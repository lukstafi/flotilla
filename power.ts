// Sleep routes follow the currently observed OS, never the endpoint's nickname.
export interface Endpoint {
  id: string;
  kind: "unix" | "windows";
  host?: string;
  local?: boolean;
}
export interface Machine { name: string; endpoints: Endpoint[] }
export interface Observation {
  ok: boolean;
  fetched_at: string | null;
  data: { os?: string; is_wsl?: boolean } | null;
}
export interface SleepRoute { endpoint: Endpoint; platform: "linux" | "darwin" | "windows" }
export interface Command { argv: string[]; stdin?: string }
export interface CommandResult { code: number; stdout: string; stderr: string; timedOut?: boolean }
export interface SleepStatus {
  state: "preparing" | "pending" | "executing" | "requested" | "failed" | "unconfirmed" | "cancelled";
  at: string;
  endpoint?: string;
  error?: string;
}

export function selectSleepRoute(
  machine: Machine, observation: (ep: Endpoint) => Observation | undefined,
  now = Date.now(), maxAgeMs = 60_000,
): SleepRoute {
  const routes: (SleepRoute & { stamp: number })[] = [];
  for (const ep of machine.endpoints) {
    const st = observation(ep);
    const stamp = Date.parse(st?.fetched_at ?? "");
    if (!st?.ok || !Number.isFinite(stamp) || now - stamp > maxAgeMs || !st.data) continue;
    if (ep.kind === "windows" && st.data.os === "windows") routes.push({ endpoint: ep, platform: "windows", stamp });
    if (ep.kind === "unix" && st.data.os === "darwin") routes.push({ endpoint: ep, platform: "darwin", stamp });
    if (ep.kind === "unix" && st.data.os === "linux" && st.data.is_wsl === false)
      routes.push({ endpoint: ep, platform: "linux", stamp });
  }
  // A WSL observation alone is never authority to suspend its host. Prefer
  // the freshest native observation across either direction of a dual boot.
  routes.sort((a, b) => b.stamp - a.stamp);
  const route = routes.find(r => r.endpoint.local) ?? routes[0];
  if (!route) throw new Error("No recently reachable native OS sleep route; refresh the fleet and check SSH access.");
  return route;
}

export function sleepCommand(route: SleepRoute): Command {
  const { endpoint: ep, platform } = route;
  let script: string;
  if (platform === "windows") {
    script = `Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) { throw 'SetSuspendState refused suspend' }`;
  } else if (platform === "linux") {
    script = `set -eu
[ "$(uname -s)" = Linux ] || { echo 'OS changed; refresh before requesting sleep' >&2; exit 2; }
if grep -qi microsoft /proc/sys/kernel/osrelease; then echo 'Refusing to suspend WSL; use its Windows host' >&2; exit 2; fi
exec systemctl --no-ask-password --check-inhibitors=yes suspend`;
  } else {
    script = `set -eu
[ "$(uname -s)" = Darwin ] || { echo 'OS changed; refresh before requesting sleep' >&2; exit 2; }
exec pmset sleepnow`;
  }
  const shell = platform === "windows" ? ["powershell", "-NoProfile", "-NonInteractive", "-Command", "-"] : ["sh", "-s"];
  if (ep.local) return { argv: shell, stdin: script };
  if (!ep.host || ep.host.startsWith("-")) throw new Error("Sleep endpoint has no valid SSH host");
  return { argv: ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=5",
    "-o", "ServerAliveCountMax=2", ep.host, shell.join(" ")], stdin: script };
}

export async function runCommand(command: Command, timeoutMs = 30_000): Promise<CommandResult> {
  const proc = Bun.spawn(command.argv, { stdin: command.stdin === undefined ? "ignore" : Buffer.from(command.stdin),
    stdout: "pipe", stderr: "pipe" });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; proc.kill("SIGKILL"); }, timeoutMs);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
    ]);
    return { code, stdout, stderr, timedOut };
  } finally { clearTimeout(timer); }
}

// An accepted command is not proof of sleeping. An SSH disconnect can mean it
// suspended successfully; retain that uncertainty instead of inventing success.
export class SleepController {
  readonly status = new Map<string, SleepStatus>();
  private pending = new Map<string, { at: string; timer: unknown }>();
  constructor(
    private choose: (machine: Machine) => SleepRoute,
    private execute: (route: SleepRoute) => Promise<CommandResult>,
    private delayMs: number,
    private clock = () => Date.now(),
    private startTimer: (fn: () => void, delay: number) => unknown = setTimeout,
    private stopTimer: (timer: any) => void = clearTimeout,
  ) {}
  schedule(machine: Machine): { sleep_at: string } {
    const existing = this.pending.get(machine.name);
    if (existing) return { sleep_at: existing.at };
    if (this.status.get(machine.name)?.state === "executing") throw new Error("A sleep request is already executing.");
    const route = this.choose(machine); // Refuse unsupported/offline routes before acknowledging.
    const at = new Date(this.clock() + this.delayMs).toISOString();
    const timer = this.startTimer(() => { void this.fire(machine); }, this.delayMs);
    this.pending.set(machine.name, { at, timer });
    this.status.set(machine.name, { state: "pending", at, endpoint: route.endpoint.id });
    return { sleep_at: at };
  }
  cancel(name: string): boolean {
    const pending = this.pending.get(name);
    if (!pending) return false;
    this.stopTimer(pending.timer);
    this.pending.delete(name);
    this.status.set(name, { state: "cancelled", at: new Date(this.clock()).toISOString() });
    return true;
  }
  pendingSnapshot() { return Object.fromEntries([...this.pending].map(([name, pending]) => [name, pending.at])); }
  async fire(machine: Machine): Promise<void> {
    if (!this.pending.delete(machine.name)) return;
    const at = new Date(this.clock()).toISOString();
    try {
      const route = this.choose(machine); // State can change during the cancellation window.
      this.status.set(machine.name, { state: "executing", at, endpoint: route.endpoint.id });
      const result = await this.execute(route);
      const setupFailed = /Permission denied|Host key verification failed|REMOTE HOST IDENTIFICATION HAS CHANGED|Could not resolve hostname|Connection refused|No route to host|Network is unreachable|connect to host .* timed out/i.test(result.stderr);
      const uncertain = !setupFailed && (result.timedOut || (result.code === 255 && !route.endpoint.local));
      this.status.set(machine.name, { state: uncertain ? "unconfirmed" : result.code === 0 ? "requested" : "failed",
        at, endpoint: route.endpoint.id,
        ...(uncertain || result.code !== 0 ? { error: (result.stderr.trim() ||
          (uncertain ? "Connection ended before suspend could be confirmed; check reachability." : `Sleep command exited ${result.code}`)).slice(0, 400) } : {}),
      });
    } catch (error) {
      this.status.set(machine.name, { state: "failed", at, error: String(error instanceof Error ? error.message : error).slice(0, 400) });
    }
  }
}
