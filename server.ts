// Flotilla server. Polls every configured endpoint over SSH (collectors are
// piped via stdin — nothing is deployed to the remote machines), caches the
// latest snapshot, and serves a human dashboard plus a JSON API for agents:
//
//   GET /                     HTML dashboard
//   GET /api/fleet            full snapshot, all machines
//   GET /api/fleet/<machine>  one machine (e.g. /api/fleet/rog)
//   GET /healthz              liveness probe
//   POST /api/session/close   terminate one idle Claude session (see closeSession)
//
// Run: bun server.ts   (config: ./flotilla.config.json, or $FLOTILLA_CONFIG)

import { join } from "path";
import { homedir } from "os";
import { readFileSync, readdirSync, statSync } from "fs";

const ROOT = import.meta.dir;

interface EndpointConfig {
  id: string;
  kind: "unix" | "windows";
  host?: string;
  local?: boolean;
}
interface MachineConfig {
  name: string;
  endpoints: EndpointConfig[];
  wol?: { macs: string[]; broadcast: string };
}
interface WatchConfig {
  counts?: string[];   // processes worth tallying — one pgrep each, cheap
  sessions?: string[]; // processes worth listing — a ps and a cwd lookup per match
}
interface FleetConfig {
  port: number;
  poll_interval_s: number;
  ssh_timeout_ms: number;
  idle_after_s?: number;
  sleep_delay_s?: number;
  session_idle_s?: number;
  server_url?: string;    // what clients elsewhere should call; defaults to localhost
  desktop_store?: string; // Claude Desktop's session directory, if not the macOS default
  watch?: WatchConfig;
  machines: MachineConfig[];
}

const CONFIG_PATH = process.env.FLOTILLA_CONFIG ?? join(ROOT, "flotilla.config.json");
const config: FleetConfig = await Bun.file(CONFIG_PATH).json().catch((err) => {
  const missing = (err as { code?: string }).code === "ENOENT";
  console.error(
    missing
      ? `flotilla: no config at ${CONFIG_PATH}\n` +
        `  cp flotilla.config.example.json flotilla.config.json   # then edit it\n` +
        `  (or point $FLOTILLA_CONFIG somewhere else)`
      : `flotilla: cannot read ${CONFIG_PATH}: ${err instanceof Error ? err.message : err}`,
  );
  process.exit(1);
});

// Defaults name what this author runs; nothing here is privileged, and a config
// that lists cargo and aider instead is a first-class setup.
const WATCH_COUNTS = config.watch?.counts ?? ["dune"];
const WATCH_SESSIONS = config.watch?.sessions ?? ["claude", "codex"];

const UNIX_SCRIPT = join(ROOT, "collect", "unix.sh");
const WIN_SCRIPT = join(ROOT, "collect", "windows.ps1");

interface EndpointState {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  fetched_at: string | null; // last successful sample
  attempted_at: string | null;
  duration_ms: number | null;
}

const state = new Map<string, EndpointState>();
const epKey = (m: string, e: string) => `${m}/${e}`;

// In-memory sample history per endpoint, for moving-window averages (the
// instantaneous readings are 1s point samples — spiky loads need smoothing).
// Resets on restart; kept just long enough for the largest window.
const AVG_WINDOWS_S: Record<string, number> = { m1: 60, m5: 300, m15: 900 };
const HISTORY_KEEP_MS = 1000 * 60 * 20;
interface Sample { t: number; cpu: number | null; gpu: number | null }
const history = new Map<string, Sample[]>();

function recordSample(key: string, data: any): void {
  const samples = history.get(key) ?? [];
  samples.push({
    t: Date.now(),
    cpu: typeof data?.cpu_pct === "number" ? data.cpu_pct : null,
    gpu: typeof data?.gpu?.util_pct === "number" ? data.gpu.util_pct : null,
  });
  const cutoff = Date.now() - HISTORY_KEEP_MS;
  while (samples.length && samples[0].t < cutoff) samples.shift();
  history.set(key, samples);
}

function windowAverages(key: string) {
  const samples = history.get(key) ?? [];
  const now = Date.now();
  const avgOf = (vals: number[]) =>
    vals.length ? Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10 : null;
  const result: Record<string, { cpu_pct: number | null; gpu_util_pct: number | null; samples: number }> = {};
  for (const [name, secs] of Object.entries(AVG_WINDOWS_S)) {
    const win = samples.filter((s) => s.t >= now - secs * 1000);
    result[name] = {
      cpu_pct: avgOf(win.map((s) => s.cpu).filter((v): v is number => v != null)),
      gpu_util_pct: avgOf(win.map((s) => s.gpu).filter((v): v is number => v != null)),
      samples: win.length,
    };
  }
  return result;
}
// ---------------------------------------------------------------------------
// Session liveness, from Claude Desktop's own records.
//
// Process-level CPU was tried first and does not work: an idle session and a
// working one both sit near 1% here, because a session's real work happens in
// child processes (shells, ssh, MCP servers), not in the agent process itself.
//
// The desktop is co-located with this server and stores one JSON per session —
// remote sessions included — carrying the timestamp of the last activity on it.
// That separates cleanly in practice: live sessions read minutes quiet,
// abandoned ones read days. `quiet_s` is that gap.
//
// Caveat behind the default threshold: lastActivityAt moves at turn boundaries,
// not continuously, so a single very long turn looks quiet. An hour sits far
// above the longest plausible turn and far below anything actually abandoned.

const SESSION_IDLE_S = config.session_idle_s ?? 3600;

const DESKTOP_STORE = config.desktop_store
  ?? join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions");
interface DesktopRec { cwd: string; title?: string; branch?: string; archived: boolean; last_activity: number }
const desktopFiles = new Map<string, { mtime: number; rec: DesktopRec }>();
let desktopByCwd = new Map<string, DesktopRec>();

function refreshDesktopSessions(): void {
  const paths: string[] = [];
  try {
    for (const device of readdirSync(DESKTOP_STORE))
      for (const sub of readdirSync(join(DESKTOP_STORE, device)))
        for (const f of readdirSync(join(DESKTOP_STORE, device, sub)))
          if (f.endsWith(".json")) paths.push(join(DESKTOP_STORE, device, sub, f));
  } catch {
    desktopByCwd = new Map();
    return; // no desktop on this host: sessions stay un-closable, which is the safe default
  }
  const present = new Set(paths);
  for (const p of desktopFiles.keys()) if (!present.has(p)) desktopFiles.delete(p);
  for (const p of paths) {
    try {
      const mtime = statSync(p).mtimeMs;
      if (desktopFiles.get(p)?.mtime === mtime) continue; // unchanged since the last scan
      const d = JSON.parse(readFileSync(p, "utf8"));
      const cwd = d.cwd ?? d.worktreePath;
      if (!cwd || typeof d.lastActivityAt !== "number") { desktopFiles.delete(p); continue; }
      desktopFiles.set(p, {
        mtime,
        rec: { cwd, title: d.title, branch: d.branch, archived: !!d.isArchived, last_activity: d.lastActivityAt },
      });
    } catch { desktopFiles.delete(p); }
  }
  // A directory accumulates sessions over time; for the join, the liveliest wins.
  const byCwd = new Map<string, DesktopRec>();
  for (const { rec } of desktopFiles.values()) {
    const prev = byCwd.get(rec.cwd);
    if (!prev || rec.last_activity > prev.last_activity) byCwd.set(rec.cwd, rec);
  }
  desktopByCwd = byCwd;
}
refreshDesktopSessions();

// cwd is the only field the desktop and a process scan can agree on — the
// desktop's sshRemoteProcessId is an internal UUID, not an OS pid.
function decorateSessions(data: any) {
  if (!data?.sessions) return data;
  const now = Date.now();
  const withState = (arr: any[], agent: string) => (arr ?? []).map((s: any) => {
    const desk = s.cwd ? desktopByCwd.get(s.cwd) : undefined;
    const quiet_s = desk ? Math.round((now - desk.last_activity) / 1000) : null;
    return {
      ...s,
      quiet_s,
      // Only Claude sessions, only ones the desktop can vouch for as quiet.
      closable: agent === "claude" && quiet_s != null && quiet_s >= SESSION_IDLE_S,
      title: desk?.title ?? null, branch: desk?.branch ?? null, archived: desk?.archived ?? null,
    };
  });
  return {
    ...data,
    sessions: Object.fromEntries(
      Object.entries(data.sessions).map(([agent, arr]) => [agent, withState(arr as any[], agent)]),
    ),
  };
}

for (const m of config.machines)
  for (const e of m.endpoints)
    state.set(epKey(m.name, e.id), {
      ok: false, data: null, error: "not polled yet",
      fetched_at: null, attempted_at: null, duration_ms: null,
    });

const WATCH_ARGS = [WATCH_COUNTS.join(","), WATCH_SESSIONS.join(",")];

function collectorCommand(ep: EndpointConfig): string[] {
  if (ep.local) return ["bash", UNIX_SCRIPT, ...WATCH_ARGS];
  const ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ep.host!];
  return ep.kind === "windows"
    ? [...ssh, "powershell -NoProfile -Command -"]
    : [...ssh, `bash -s -- ${WATCH_ARGS.map((a) => JSON.stringify(a)).join(" ")}`];
}

// PowerShell's "-Command -" refuses positional arguments, so the Windows
// collector takes its configuration as assignments prepended to the script.
const winPrelude = () =>
  `$Counts=${JSON.stringify(WATCH_COUNTS.join(","))}; $Sessions=${JSON.stringify(WATCH_SESSIONS.join(","))}\n`;
let winScript: Uint8Array | null = null;
async function collectorStdin(ep: EndpointConfig) {
  if (ep.local) return undefined;
  if (ep.kind !== "windows") return Bun.file(UNIX_SCRIPT);
  winScript ??= new Uint8Array(await Bun.file(WIN_SCRIPT).arrayBuffer());
  return Buffer.concat([Buffer.from(winPrelude()), winScript]);
}

async function pollEndpoint(machine: string, ep: EndpointConfig): Promise<void> {
  const key = epKey(machine, ep.id);
  const st = state.get(key)!;
  st.attempted_at = new Date().toISOString();
  const started = Date.now();
  try {
    const proc = Bun.spawn(collectorCommand(ep), {
      stdin: await collectorStdin(ep),
      stdout: "pipe",
      stderr: "pipe",
    });
    const timer = setTimeout(() => proc.kill(), config.ssh_timeout_ms);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    clearTimeout(timer);
    st.duration_ms = Date.now() - started;
    // PowerShell may emit banners/warnings around the payload; take the JSON line.
    const jsonLine = stdout.split("\n").find((l) => l.trimStart().startsWith("{"));
    if (!jsonLine) {
      throw new Error(
        exitCode !== 0
          ? `exit ${exitCode}: ${stderr.trim().slice(0, 200) || "no output"}`
          : `no JSON in output: ${stdout.trim().slice(0, 200)}`,
      );
    }
    st.data = JSON.parse(jsonLine);
    st.ok = true;
    st.error = null;
    st.fetched_at = new Date().toISOString();
    recordSample(key, st.data);
  } catch (err) {
    st.ok = false;
    st.error = String(err instanceof Error ? err.message : err).slice(0, 300);
    st.duration_ms = Date.now() - started;
  }
}

// Polling is gated on client activity: measurements pause once nothing has
// asked for data in idle_after_s (agents' curls count as clients too). The
// first request after a pause serves the stale cache and kicks a fresh round;
// ?fresh=1 awaits that round instead.
const IDLE_AFTER_MS = (config.idle_after_s ?? 90) * 1000;
let lastClientRequest = Date.now();
let lastPollAt = 0;

// Delayed machine sleep: the delay runs here (cancellable) so the user can
// power off input devices that would otherwise interrupt going to sleep.
const SLEEP_DELAY_S = config.sleep_delay_s ?? 15;
const WIN_SUSPEND_SCRIPT = `Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)`;
const pendingSleeps = new Map<string, { sleep_at: string; timer: ReturnType<typeof setTimeout> }>();

function executeSleep(m: MachineConfig): void {
  pendingSleeps.delete(m.name);
  if (m.endpoints.some((e) => e.local)) {
    Bun.spawn(["pmset", "sleepnow"]);
    return;
  }
  // Suspending the Windows host suspends the whole box, WSL included.
  const win = m.endpoints.find((e) => e.kind === "windows");
  if (!win) return console.error(`flotilla: no sleep route for ${m.name}`);
  Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", win.host!, "powershell -NoProfile -Command -"],
    { stdin: Buffer.from(WIN_SUSPEND_SCRIPT), stdout: "ignore", stderr: "ignore" },
  );
}

function scheduleSleep(m: MachineConfig): { sleep_at: string } {
  const existing = pendingSleeps.get(m.name);
  if (existing) return { sleep_at: existing.sleep_at };
  const sleep_at = new Date(Date.now() + SLEEP_DELAY_S * 1000).toISOString();
  const timer = setTimeout(() => executeSleep(m), SLEEP_DELAY_S * 1000);
  pendingSleeps.set(m.name, { sleep_at, timer });
  console.log(`flotilla: sleep scheduled for ${m.name} at ${sleep_at}`);
  return { sleep_at };
}

function sendWake(m: MachineConfig): { sent: string[] } {
  const wol = m.wol!;
  // Magic packet: 6x 0xFF + 16x MAC, UDP to the LAN broadcast (ports 7 and 9).
  const py = `
import socket, sys
bcast = sys.argv[1]
for mac in sys.argv[2:]:
    payload = bytes.fromhex('ff'*6 + mac.replace(':','')*16)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
    for port in (7, 9):
        s.sendto(payload, (bcast, port))
        s.sendto(payload, ('255.255.255.255', port))
    s.close()
`;
  Bun.spawn(["python3", "-c", py, wol.broadcast, ...wol.macs], { stdout: "ignore", stderr: "ignore" });
  console.log(`flotilla: wake packets sent for ${m.name} (${wol.macs.join(", ")})`);
  return { sent: wol.macs };
}

function cancelSleep(name: string): boolean {
  const pending = pendingSleeps.get(name);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingSleeps.delete(name);
  console.log(`flotilla: sleep cancelled for ${name}`);
  return true;
}


// Terminate one agent session. Every gate is re-checked server-side: the UI's
// button is a convenience, not the authority.
const CLOSE_SCRIPT = join(ROOT, "collect", "close-session.sh");

async function closeSession(
  m: MachineConfig, epId: string, pid: number,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const ep = m.endpoints.find((e) => e.id === epId);
  if (!ep) return { status: 404, body: { error: `unknown endpoint: ${m.name}/${epId}` } };
  if (ep.kind !== "unix") return { status: 400, body: { error: "closing is only wired for unix endpoints" } };

  const st = state.get(epKey(m.name, ep.id));
  const data: any = st?.ok ? decorateSessions(st.data) : null;
  const sess = (data?.sessions?.claude ?? []).find((s: any) => s.pid === pid);
  if (!sess) return { status: 404, body: { error: `no Claude session with pid ${pid} on ${m.name}/${epId}` } };
  if (!sess.closable)
    return {
      status: 409,
      body: {
        error: "session is not idle",
        quiet_s: sess.quiet_s, threshold_s: SESSION_IDLE_S,
      },
    };

  // The far end re-checks the command line before killing, so a pid recycled
  // between poll and click is a no-op rather than a mis-kill.
  const want = Buffer.from(sess.cmd ?? "").toString("base64");
  const argv = ep.local
    ? ["sh", CLOSE_SCRIPT, String(pid), want]
    : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", ep.host!, `sh -s -- ${pid} ${want}`];
  const proc = Bun.spawn(argv, {
    stdin: ep.local ? undefined : Bun.file(CLOSE_SCRIPT),
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) {
    console.error(`flotilla: close ${m.name}/${epId} pid ${pid} failed (${code}): ${err.trim()}`);
    const reason = code === 3 ? "process no longer matches the session" : code === 4 ? "process is already gone" : err.trim().slice(0, 200);
    return { status: 409, body: { error: reason, exit: code } };
  }
  console.log(`flotilla: closed ${m.name}/${epId} pid ${pid} (${sess.title ?? sess.cwd})`);
  pollAll(); // reflect the kill on the next render without waiting for the tick
  return { status: 200, body: { closed: pid, machine: m.name, endpoint: epId, detail: out.trim() } };
}

let polling = false;
async function pollAll(): Promise<void> {
  if (polling) return; // a slow round must not stack onto the next tick
  polling = true;
  lastPollAt = Date.now();
  refreshDesktopSessions();
  try {
    await Promise.all(
      config.machines.flatMap((m) => m.endpoints.map((e) => pollEndpoint(m.name, e))),
    );
  } finally {
    polling = false;
  }
}

function pollTick(): void {
  if (Date.now() - lastClientRequest > IDLE_AFTER_MS) return; // nobody watching
  pollAll();
}

function noteClientActivity(): Promise<void> | null {
  const wasIdle = Date.now() - lastPollAt > config.poll_interval_s * 2000;
  lastClientRequest = Date.now();
  return wasIdle ? pollAll() : null; // wake from pause with a fresh round
}

function machineSnapshot(m: MachineConfig) {
  return {
    name: m.name,
    wol: !!m.wol,
    endpoints: Object.fromEntries(
      m.endpoints.map((e) => {
        const key = epKey(m.name, e.id);
        const st = state.get(key)!;
        return [e.id, { kind: e.kind, host: e.host ?? "local", ...st, data: decorateSessions(st.data), avg: windowAverages(key) }];
      }),
    ),
  };
}

function fleetSnapshot() {
  return {
    updated_at: new Date().toISOString(),
    poll_interval_s: config.poll_interval_s,
    polling: Date.now() - lastClientRequest > IDLE_AFTER_MS ? "paused" : "active",
    sleep_pending: Object.fromEntries(
      [...pendingSleeps].map(([name, p]) => [name, p.sleep_at]),
    ),
    sleep_delay_s: SLEEP_DELAY_S,
    session_idle_s: SESSION_IDLE_S,
    watch: { counts: WATCH_COUNTS, sessions: WATCH_SESSIONS },
    machines: config.machines.map(machineSnapshot),
  };
}

const indexHtml = Bun.file(join(ROOT, "public", "index.html"));

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path === "/" || path === "/index.html") {
      noteClientActivity();
      return new Response(indexHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (path === "/healthz") return Response.json({ ok: true });
    if (path === "/api/sleep" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const m = config.machines.find((x) => x.name === body.machine);
      if (!m) return Response.json({ error: `unknown machine: ${body.machine}` }, { status: 404 });
      return Response.json({ machine: m.name, ...scheduleSleep(m) });
    }
    if (path === "/api/sleep-cancel" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      return Response.json({ machine: body.machine, cancelled: cancelSleep(body.machine) });
    }
    if (path === "/api/wake" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const m = config.machines.find((x) => x.name === body.machine);
      if (!m) return Response.json({ error: `unknown machine: ${body.machine}` }, { status: 404 });
      if (!m.wol) return Response.json({ error: `no wol config for ${m.name}` }, { status: 400 });
      lastClientRequest = Date.now(); // keep polling so the wake-up is noticed
      return Response.json({ machine: m.name, ...sendWake(m) });
    }
    if (path === "/api/session/close" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const m = config.machines.find((x) => x.name === body.machine);
      if (!m) return Response.json({ error: `unknown machine: ${body.machine}` }, { status: 404 });
      const pid = Number(body.pid);
      if (!Number.isInteger(pid) || pid <= 0) return Response.json({ error: `bad pid: ${body.pid}` }, { status: 400 });
      lastClientRequest = Date.now();
      const { status, body: out } = await closeSession(m, String(body.endpoint), pid);
      return Response.json(out, { status });
    }
    if (path === "/api/fleet") {
      const woke = noteClientActivity();
      if (woke && url.searchParams.get("fresh")) await woke;
      return Response.json(fleetSnapshot());
    }
    const single = path.match(/^\/api\/fleet\/([\w-]+)$/);
    if (single) {
      const m = config.machines.find((x) => x.name === single[1]);
      if (!m) return Response.json({ error: `unknown machine: ${single[1]}` }, { status: 404 });
      const woke = noteClientActivity();
      if (woke && url.searchParams.get("fresh")) await woke;
      return Response.json({ updated_at: new Date().toISOString(), ...machineSnapshot(m) });
    }
    return new Response("not found", { status: 404 });
  },
});

console.log(`flotilla: http://localhost:${server.port} (polling every ${config.poll_interval_s}s, pausing after ${IDLE_AFTER_MS / 1000}s without clients)`);
pollAll();
setInterval(pollTick, config.poll_interval_s * 1000);
