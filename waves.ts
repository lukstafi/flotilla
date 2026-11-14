// Issue-wave status, read from a Ludics anchor's state (github.com/lukstafi/ludics).
//
// Flotilla knows what is resident on each machine; a Ludics wave knows which
// issue each worker is for, where it runs, and whether its PR already merged.
// Joining the two answers "what is this box doing for the wave?" and flags a
// session whose task finished but whose process is still holding the box.
//
// Everything here is read-only, and through surfaces Ludics documents:
//   <state>/boards/<wave>.json   the wave board, one document per wave (boardstore.py)
//   <state>/COORDINATOR          the coordinator lease, key=value lines (lease.py)
//   <state>/HALT                 present while launches are halted (lease.py)
//   fleet-worker.sh execution list --active --compact
//                                the execution registry's open reservations; the
//                                verb, not the files, since the registry locks them
//
// Ludics names boxes by ssh host (rog-nv-linux); Flotilla by machine (rog). A box
// maps to the machine whose name, or one of whose endpoint hosts, it equals.

import { join } from "path";
import { readFileSync, readdirSync, statSync } from "fs";

export interface WavesConfig {
  state_dir?: string;    // the anchor's issue-wave state; ~/.local/state/issue-wave
  fleet_worker?: string; // Ludics' launcher; ~/ludics/issue-wave/scripts/fleet-worker.sh
  recent_h?: number;     // a board quiet longer than this lists no active tasks; 24
  timeout_ms?: number;   // bound on the execution-list call; 20000
}

export interface WaveTask {
  wave: string;
  task: string;
  issue: string | null;
  repository: string | null;
  pr: string | null;
  state: string;
  terminal: boolean;
  agent_host: string | null;
  exec_hosts: string[];
  worktree: string | null;
  kind: string | null;
  model: string | null;
  transport: string | null;
  updated_at: string | null;
}

export interface WaveExecution {
  request_id: string;
  wave: string | null;
  issue: string | null;
  worker: string | null;
  kind: string | null;     // correctness | measurement
  state: string | null;    // launching | dispatched | ...
  standing: boolean;
  execution_host: string | null;
  agent_host: string | null;
  purpose: string | null;
  created_at: string | null;
}

export interface WavesSnapshot {
  enabled: true;
  state_dir: string;
  fetched_at: string | null;
  error: string | null;            // the boards could not be read at all
  executions_error: string | null; // the registry verb failed; tasks still shown
  coordinator: { host: string | null; since: string | null } | null;
  halt: string | null;             // the HALT marker's text, when launches are halted
  waves: { wave: string; updated_at: string | null; tasks: number; active: number; notes: Record<string, string> }[];
  tasks: WaveTask[];               // non-terminal tasks of recent boards
  executions: WaveExecution[];     // open reservations
}

// Boards are written by coordinators over months, and older ones spell the
// end of a task differently ("merged #1137 at 9d68…", "MERGED 37a9539b; …").
const TERMINAL = /^(merged|dropped|done|closed|abandoned|superseded|cancelled)\b/i;
export const isTerminal = (state: string, fields: Record<string, unknown> = {}) =>
  TERMINAL.test(state.trim()) || (typeof fields.merge === "string" && /^[0-9a-f]{7,40}$/.test(fields.merge));

const str = (v: unknown): string | null => (typeof v === "string" && v.length ? v : null);
const prOf = (f: Record<string, unknown>) => {
  const v = f.pr;
  if (typeof v === "number") return String(v);
  const s = str(v);
  return s && /^\d+$/.test(s) ? s : null;
};

export function parseBoard(doc: any): { wave: string; updated_at: string | null; notes: Record<string, string>; tasks: WaveTask[] } | null {
  if (!doc || typeof doc !== "object" || typeof doc.wave !== "string" || !Array.isArray(doc.tasks)) return null;
  const tasks: WaveTask[] = [];
  for (const row of doc.tasks) {
    if (!row || typeof row.task !== "string") continue;
    const f = (row.fields && typeof row.fields === "object" ? row.fields : {}) as Record<string, unknown>;
    const state = str(f.state) ?? "";
    tasks.push({
      wave: doc.wave,
      task: row.task,
      issue: str(f.issue),
      repository: str(f.repository),
      pr: prOf(f),
      state,
      terminal: isTerminal(state, f),
      agent_host: str(f.agent_host),
      exec_hosts: (str(f.exec_hosts) ?? "").split(/[\s,]+/).filter((h) => h && h !== "none"),
      worktree: str(f.worktree),
      kind: str(f.kind),
      model: str(f.model),
      transport: str(f.transport),
      updated_at: str(row.updated_at),
    });
  }
  const notes: Record<string, string> = {};
  if (doc.notes && typeof doc.notes === "object")
    for (const [k, v] of Object.entries(doc.notes)) if (typeof v === "string") notes[k] = v;
  return { wave: doc.wave, updated_at: str(doc.updated_at), notes, tasks };
}

export function parseExecutions(raw: string): WaveExecution[] {
  const list = JSON.parse(raw);
  if (!Array.isArray(list)) throw new Error("execution list: expected a JSON array");
  return list.filter((r) => r && typeof r === "object").map((r: any) => {
    const q = r.request && typeof r.request === "object" ? r.request : {};
    return {
      request_id: String(r.request_id ?? q.request_id ?? ""),
      wave: str(q.wave),
      issue: str(q.issue),
      worker: str(q.worker),
      kind: str(q.kind),
      state: str(r.state),
      standing: q.standing === true,
      execution_host: str(q.execution_host),
      agent_host: str(q.agent_host),
      purpose: str(q.purpose),
      created_at: str(r.created_at),
    };
  });
}

// `host=<hostname>/<session>`, `token=…`, `since=…`; the token is a secret of the
// lease and never leaves here.
export function parseCoordinator(text: string): { host: string | null; since: string | null } | null {
  const kv = Object.fromEntries(text.split("\n").map((l) => l.match(/^(\w+)=(.*)$/)).filter(Boolean).map((m) => [m![1], m![2].trim()]));
  return kv.host || kv.since ? { host: kv.host ?? null, since: kv.since ?? null } : null;
}

export interface MachineLike { name: string; endpoints: { host?: string; local?: boolean }[] }
export function machineForBox(machines: MachineLike[], box: string | null): string | null {
  if (!box) return null;
  const local = machines.find((m) => m.endpoints.some((e) => e.local));
  if (box === "local") return local?.name ?? null;
  return machines.find((m) => m.name === box || m.endpoints.some((e) => e.host === box))?.name ?? null;
}

// Whether a reservation is this task's: the same issue, and the same wave when
// the reservation names one (an issue retried in a later wave is another task).
// A reservation with no issue belongs to no task.
export const reservationOf = (t: WaveTask, x: WaveExecution) =>
  !!x.issue && x.issue === t.issue && (!x.wave || x.wave === t.wave);

// What one machine is doing for the waves: tasks whose agent runs there, tasks
// that only execute there, and the reservations held on it. The pairing is done
// here, once, so the dashboard and the CLI only render it: each task carries its
// reservations, and `unmatched` holds the ones no listed task owns.
export function machineWaveView(snap: WavesSnapshot | null, machines: MachineLike[], machine: string) {
  if (!snap) return null;
  const here = (box: string | null) => machineForBox(machines, box) === machine;
  const executions = snap.executions.filter((x) => here(x.execution_host));
  const withOwn = (t: WaveTask) => ({ ...t, executions: executions.filter((x) => reservationOf(t, x)) });
  const tasks = snap.tasks.filter((t) => here(t.agent_host)).map(withOwn);
  const visiting = snap.tasks.filter((t) => !here(t.agent_host) && t.exec_hosts.some(here)).map(withOwn);
  const unmatched = executions.filter((x) => ![...tasks, ...visiting].some((t) => reservationOf(t, x)));
  return tasks.length || visiting.length || executions.length ? { tasks, visiting, executions, unmatched } : null;
}

// Tasks on boxes no machine in the config answers to, so they are not lost.
export function unplacedTasks(snap: WavesSnapshot | null, machines: MachineLike[]): WaveTask[] {
  return snap ? snap.tasks.filter((t) => !machineForBox(machines, t.agent_host)) : [];
}

export class WaveReader {
  readonly stateDir: string;
  readonly fleetWorker: string;
  private readonly recentMs: number;
  private readonly timeoutMs: number;
  private boards = new Map<string, { mtime: number; board: ReturnType<typeof parseBoard> }>();
  private executions: WaveExecution[] = [];
  private executionsError: string | null = null;
  private refreshing: Promise<void> | null = null;
  snapshot: WavesSnapshot | null = null;
  // Session join: <machine>\0<worktree> → the latest task that used it, terminal ones included.
  private byWorktree = new Map<string, WaveTask>();

  constructor(cfg: WavesConfig, home: string, private machines: MachineLike[]) {
    const expand = (p: string) => p.replace(/^~(?=\/|$)/, home);
    this.stateDir = expand(cfg.state_dir ?? "~/.local/state/issue-wave");
    this.fleetWorker = expand(cfg.fleet_worker ?? "~/ludics/issue-wave/scripts/fleet-worker.sh");
    this.recentMs = (cfg.recent_h ?? 24) * 3600_000;
    this.timeoutMs = cfg.timeout_ms ?? 20_000;
  }

  refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      this.readBoards();
      await this.readExecutions();
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private readBoards(): void {
    const dir = join(this.stateDir, "boards");
    let names: string[];
    try {
      names = readdirSync(dir).filter((f) => f.endsWith(".json"));
    } catch (err) {
      this.snapshot = this.empty(`cannot read ${dir}: ${(err as Error).message}`);
      this.byWorktree = new Map();
      return;
    }
    const present = new Set(names);
    for (const n of this.boards.keys()) if (!present.has(n)) this.boards.delete(n);
    for (const n of names) {
      try {
        const mtime = statSync(join(dir, n)).mtimeMs;
        if (this.boards.get(n)?.mtime === mtime) continue;
        this.boards.set(n, { mtime, board: parseBoard(JSON.parse(readFileSync(join(dir, n), "utf8"))) });
      } catch { this.boards.delete(n); } // mid-write or foreign: next round reads it again
    }
    const now = Date.now();
    const byWorktree = new Map<string, WaveTask>();
    const recent: NonNullable<ReturnType<typeof parseBoard>>[] = [];
    // A worktree reused by a later wave resolves to the task written last. The
    // row's own updated_at decides, not its board's mtime: a gate note on an old
    // board must not hand its finished task back a worktree a newer wave reuses.
    const written = (t: WaveTask, b: { updated_at: string | null }) => t.updated_at ?? b.updated_at ?? "";
    const writtenAt = new Map<string, string>();
    for (const { mtime, board } of [...this.boards.values()].sort((a, b) => a.mtime - b.mtime)) {
      if (!board) continue;
      for (const t of board.tasks) {
        const m = machineForBox(this.machines, t.agent_host);
        if (!t.worktree || !m) continue;
        const key = `${m}\0${t.worktree}`, at = written(t, board);
        if (at >= (writtenAt.get(key) ?? "")) { byWorktree.set(key, t); writtenAt.set(key, at); }
      }
      if (now - mtime <= this.recentMs) recent.push(board);
    }
    this.byWorktree = byWorktree;
    let coordinator: WavesSnapshot["coordinator"] = null;
    try { coordinator = parseCoordinator(readFileSync(join(this.stateDir, "COORDINATOR"), "utf8")); } catch {}
    let halt: string | null = null;
    try { halt = readFileSync(join(this.stateDir, "HALT"), "utf8").trim() || "halted"; } catch {}
    recent.sort((a, b) => (b.updated_at ?? "").localeCompare(a.updated_at ?? ""));
    this.snapshot = {
      enabled: true,
      state_dir: this.stateDir,
      fetched_at: new Date().toISOString(),
      error: null,
      executions_error: this.executionsError,
      coordinator,
      halt,
      waves: recent.map((b) => ({
        wave: b.wave, updated_at: b.updated_at, tasks: b.tasks.length,
        active: b.tasks.filter((t) => !t.terminal).length, notes: b.notes,
      })),
      tasks: recent.flatMap((b) => b.tasks.filter((t) => !t.terminal)),
      executions: this.executions,
    };
  }

  private async readExecutions(): Promise<void> {
    try {
      // Its own process group, so the deadline ends every process the verb
      // started; and the deadline races the reads, since a descendant that
      // escaped the group would otherwise hold the pipes, and this refresh
      // shares pollAll()'s promise with every endpoint.
      const proc = Bun.spawn(["bash", this.fleetWorker, "execution", "list", "--active", "--compact"], {
        stdout: "pipe", stderr: "pipe", stdin: "ignore", detached: true,
      });
      const collected = Promise.all([
        new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
      ]);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), this.timeoutMs); });
      const result = await Promise.race([collected, deadline]);
      clearTimeout(timer);
      if (!result) {
        try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
        collected.catch(() => {});
        throw new Error(`execution list timed out after ${this.timeoutMs} ms`);
      }
      const [out, err, code] = result;
      if (code !== 0) throw new Error(`execution list exit ${code}: ${(err.trim() || out.trim()).slice(0, 200)}`);
      this.executions = parseExecutions(out.slice(out.indexOf("[")));
      this.executionsError = null;
    } catch (err) {
      // Keep the last good list; say it is stale rather than showing nothing.
      this.executionsError = String(err instanceof Error ? err.message : err).slice(0, 300);
    }
    if (this.snapshot) {
      this.snapshot.executions = this.executions;
      this.snapshot.executions_error = this.executionsError;
    }
  }

  private empty(error: string): WavesSnapshot {
    return {
      enabled: true, state_dir: this.stateDir, fetched_at: null, error, executions_error: null,
      coordinator: null, halt: null, waves: [], tasks: [], executions: [],
    };
  }

  // The wave task a session's working directory belongs to, if any.
  taskForSession(machine: string, cwd: string | undefined): WaveTask | null {
    if (!cwd) return null;
    for (let p = cwd; p.length > 1; p = p.slice(0, p.lastIndexOf("/")) || "/") {
      const t = this.byWorktree.get(`${machine}\0${p}`);
      if (t) return t;
    }
    return null;
  }
}
