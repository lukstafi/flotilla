// Flotilla server. Polls every configured endpoint over SSH (collectors are
// piped via stdin — nothing is deployed to the remote machines), caches the
// latest snapshot, and serves a human dashboard plus a JSON API for agents:
//
//   GET /                     HTML dashboard
//   GET /api/fleet            full snapshot, all machines
//   GET /api/fleet/<machine>  one machine (e.g. /api/fleet/rog)
//   GET /healthz              liveness probe
//   POST /api/session/close   terminate one idle Claude session (see closeSession)
//   POST /api/power-log       append one dashboard power click (see appendPowerLog)
//
// With a Ludics anchor's state on this host, the snapshot also carries issue-wave
// status (waves.ts): per machine, the wave tasks and execution reservations on it,
// and per session, the wave task its worktree belongs to.
//
// Run: bun server.ts   (config: ./flotilla.config.json, or $FLOTILLA_CONFIG)

import { dirname, join } from "path";
import { selectSleepRoute, sleepCommand, runCommand, SleepController } from "./power";
import { WaveReader, machineWaveView, unplacedTasks, type WavesConfig } from "./waves";
import { runBounded, killLiveGroups } from "./run";
import { homedir } from "os";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "fs";

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
  power_log?: string;     // where dashboard power clicks are appended (JSONL)
  session_idle_s?: number;
  server_url?: string;    // what clients elsewhere should call; defaults to localhost
  desktop_store?: string; // Claude Desktop's session directory, if not the macOS default
  watch?: WatchConfig;
  waves?: WavesConfig | false; // Ludics issue-wave status; see waves.ts
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

// Wave status is on when configured, or when this host holds a Ludics anchor's
// state at the default place; `"waves": false` turns it off.
const waveReader = config.waves === false ? null
  : config.waves || existsSync(join(homedir(), ".local", "state", "issue-wave", "boards"))
    ? new WaveReader(config.waves || {}, homedir(), config.machines) : null;

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
function decorateSessions(data: any, machine: string) {
  if (!data?.sessions) return data;
  const now = Date.now();
  const withState = (arr: any[], agent: string) => (arr ?? []).map((s: any) => {
    const desk = agent === "claude" && s.cwd ? desktopByCwd.get(s.cwd) : undefined;
    const quiet_s = desk ? Math.round((now - desk.last_activity) / 1000) : null;
    const t = waveReader?.taskForSession(machine, s.cwd);
    return {
      ...s,
      quiet_s,
      // Only Claude sessions, only ones the desktop can vouch for as quiet.
      closable: agent === "claude" && quiet_s != null && quiet_s >= SESSION_IDLE_S,
      title: s.kind === "app-server" ? "Codex App (shared server)" : desk?.title ?? null,
      branch: desk?.branch ?? null, archived: desk?.archived ?? null,
      // A terminal task under a resident session is work finished but still holding the box.
      wave: t ? { wave: t.wave, task: t.task, issue: t.issue, pr: t.pr, state: t.state, terminal: t.terminal } : null,
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
    // The deadline bounds the whole read: every endpoint's poll shares pollAll()'s
    // promise, so one stalled collector would otherwise hold up every later round.
    const run = await runBounded(collectorCommand(ep), { stdin: await collectorStdin(ep), timeoutMs: config.ssh_timeout_ms });
    if (run.timedOut) throw new Error("Collector connection or command timed out");
    const { out: stdout, err: stderr, code: exitCode } = run;
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

// The dashboard's power clicks, mirrored from its in-browser log (one JSON line
// each, a "click" before the request and a "done" with its outcome), so the
// question "did that button press ever happen?" has an answer on the hub.
const POWER_LOG = config.power_log ?? join(homedir(), ".local", "state", "flotilla", "power-clicks.jsonl");
function appendPowerLog(body: any, from: string | undefined): string | null {
  const str = (v: unknown, max: number) => typeof v === "string" && v.length > 0 && v.length <= max;
  if (!body || typeof body !== "object") return "body must be a JSON object";
  if (!str(body.id, 64) || !str(body.machine, 64) || !str(body.at, 40)) return "id, machine and at are required";
  if (!["sleep", "cancel", "wake"].includes(body.action)) return `bad action: ${body.action}`;
  if (!["click", "done"].includes(body.phase)) return `bad phase: ${body.phase}`;
  if (body.outcome !== undefined && !str(body.outcome, 400)) return "outcome must be a short string";
  const { id, at, phase, action, machine, outcome } = body;
  mkdirSync(dirname(POWER_LOG), { recursive: true });
  appendFileSync(POWER_LOG, JSON.stringify({ received_at: new Date().toISOString(), from, id, at, phase, action, machine,
    ...(outcome === undefined ? {} : { outcome }) }) + "\n");
  return null;
}
const sleepController = new SleepController(
  (m) => selectSleepRoute(m, ep => state.get(epKey(m.name, ep.id)) as any,
    Date.now(), Math.max(60_000, config.poll_interval_s * 3000)),
  route => runCommand(sleepCommand(route)), SLEEP_DELAY_S * 1000,
);

const sleepPreparations = new Map<string, { cancelled: boolean; result: Promise<{ sleep_at: string }> }>();
function prepareSleep(m: MachineConfig): Promise<{ sleep_at: string }> {
  // A duplicate must not wait past its existing countdown and schedule again.
  if (sleepController.pendingSnapshot()[m.name] || sleepController.status.get(m.name)?.state === "executing")
    return Promise.resolve(sleepController.schedule(m));
  const existing = sleepPreparations.get(m.name);
  if (existing) return existing.result;
  const preparation = { cancelled: false, result: null! as Promise<{ sleep_at: string }> };
  sleepPreparations.set(m.name, preparation);
  sleepController.status.set(m.name, { state: "preparing", at: new Date().toISOString() });
  preparation.result = (async () => {
    await (noteClientActivity() ?? polling);
    if (preparation.cancelled) throw new Error("Sleep cancelled during refresh");
    lastClientRequest = Date.now();
    return sleepController.schedule(m);
  })().catch(error => {
    if (!preparation.cancelled)
      sleepController.status.set(m.name, { state: "failed", at: new Date().toISOString(),
        error: String(error instanceof Error ? error.message : error).slice(0, 400) });
    throw error;
  }).finally(() => {
    if (sleepPreparations.get(m.name) === preparation) sleepPreparations.delete(m.name);
  });
  return preparation.result;
}

async function sendWake(m: MachineConfig): Promise<{ sent: string[] }> {
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
  const result = await runCommand({ argv: ["python3", "-c", py, wol.broadcast, ...wol.macs] });
  if (result.code !== 0 || result.timedOut) throw new Error(result.stderr.trim() || "Wake packet send failed");
  console.log(`flotilla: wake packets sent for ${m.name} (${wol.macs.join(", ")})`);
  return { sent: wol.macs };
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
  const data: any = st?.ok ? decorateSessions(st.data, m.name) : null;
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
  const run = await runBounded(argv, { stdin: ep.local ? undefined : Bun.file(CLOSE_SCRIPT), timeoutMs: config.ssh_timeout_ms });
  if (run.timedOut) {
    console.error(`flotilla: close ${m.name}/${epId} pid ${pid} timed out after ${config.ssh_timeout_ms} ms`);
    return { status: 504, body: { error: `close command timed out after ${config.ssh_timeout_ms} ms` } };
  }
  const { out, err, code } = run;
  if (code !== 0) {
    console.error(`flotilla: close ${m.name}/${epId} pid ${pid} failed (${code}): ${err.trim()}`);
    const reason = code === 3 ? "process no longer matches the session" : code === 4 ? "process is already gone" : err.trim().slice(0, 200);
    return { status: 409, body: { error: reason, exit: code } };
  }
  console.log(`flotilla: closed ${m.name}/${epId} pid ${pid} (${sess.title ?? sess.cwd})`);
  pollAll(); // reflect the kill on the next render without waiting for the tick
  return { status: 200, body: { closed: pid, machine: m.name, endpoint: epId, detail: out.trim() } };
}

let polling: Promise<void> | null = null;
function pollAll(): Promise<void> {
  if (polling) return polling; // Fresh callers join the same round.
  lastPollAt = Date.now();
  refreshDesktopSessions();
  polling = Promise.all([
    ...config.machines.flatMap((m) => m.endpoints.map((e) => pollEndpoint(m.name, e))),
    waveReader?.refresh(),
  ]).then(() => {}).finally(() => { polling = null; });
  return polling;
}

function pollTick(): void {
  if (Date.now() - lastClientRequest > IDLE_AFTER_MS && !Object.keys(sleepController.pendingSnapshot()).length) return; // nobody watching
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
    sleep_status: sleepController.status.get(m.name) ?? null,
    wol: !!m.wol,
    wave: machineWaveView(waveReader?.snapshot ?? null, config.machines, m.name),
    endpoints: Object.fromEntries(
      m.endpoints.map((e) => {
        const key = epKey(m.name, e.id);
        const st = state.get(key)!;
        return [e.id, { kind: e.kind, host: e.host ?? "local", ...st, data: decorateSessions(st.data, m.name), avg: windowAverages(key) }];
      }),
    ),
  };
}

function fleetSnapshot() {
  return {
    updated_at: new Date().toISOString(),
    poll_interval_s: config.poll_interval_s,
    polling: Date.now() - lastClientRequest > IDLE_AFTER_MS ? "paused" : "active",
    sleep_pending: sleepController.pendingSnapshot(),
    sleep_preparing: [...sleepPreparations.keys()],
    sleep_status: Object.fromEntries(sleepController.status),
    sleep_delay_s: SLEEP_DELAY_S,
    session_idle_s: SESSION_IDLE_S,
    watch: { counts: WATCH_COUNTS, sessions: WATCH_SESSIONS },
    waves: waveReader?.snapshot
      ? { ...waveReader.snapshot, unplaced: unplacedTasks(waveReader.snapshot, config.machines) } : null,
    machines: config.machines.map(machineSnapshot),
  };
}

const indexHtml = Bun.file(join(ROOT, "public", "index.html"));

// Subprocesses run in their own process groups (run.ts), out of reach of a
// signal to ours; end them with the server rather than leave them behind.
for (const [sig, n] of [["SIGINT", 2], ["SIGTERM", 15], ["SIGHUP", 1]] as const)
  process.on(sig, () => { killLiveGroups(); process.exit(128 + n); });

const server = Bun.serve({
  port: config.port,
  hostname: "0.0.0.0",
  async fetch(req, srv) {
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
      try {
        return Response.json({ machine: m.name, ...await prepareSleep(m) });
      } catch (error) {
        return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 409 });
      }
    }
    if (path === "/api/sleep-cancel" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const preparation = sleepPreparations.get(body.machine);
      if (preparation) {
        preparation.cancelled = true;
        sleepPreparations.delete(body.machine);
        sleepController.status.set(body.machine, { state: "cancelled", at: new Date().toISOString() });
      }
      const cancelled = sleepController.cancel(body.machine);
      return Response.json({ machine: body.machine, cancelled: !!preparation || cancelled });
    }
    if (path === "/api/power-log" && req.method === "POST") {
      const error = appendPowerLog(await req.json().catch(() => null), srv.requestIP(req)?.address);
      return error ? Response.json({ error }, { status: 400 }) : Response.json({ ok: true });
    }
    if (path === "/api/wake" && req.method === "POST") {
      const body = await req.json().catch(() => ({}));
      const m = config.machines.find((x) => x.name === body.machine);
      if (!m) return Response.json({ error: `unknown machine: ${body.machine}` }, { status: 404 });
      if (!m.wol) return Response.json({ error: `no wol config for ${m.name}` }, { status: 400 });
      lastClientRequest = Date.now(); // keep polling so the wake-up is noticed
      try {
        return Response.json({ machine: m.name, ...await sendWake(m) });
      } catch (error) {
        return Response.json({ error: String(error instanceof Error ? error.message : error) }, { status: 502 });
      }
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
