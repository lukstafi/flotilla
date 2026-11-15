// Cross-machine test sweep activity, read from the hub's sweep state.
//
// OCANNL's tools/sweep.sh (driven daily by Ludics' ocannl-cross-machine-sweep
// routine) runs one LANE per box -- cc and metal on the Mac, cuda on rog, hip
// and multidev_cc on minix, hip again on tuf -- concurrently, and records each
// finished unit as a row of history.tsv. Everything it leaves is on the machine
// that launched it, which in the author's fleet is the hub:
//
//   <state>/history.tsv            one row per FINISHED unit (header-named columns)
//   <state>/logs/<run>-<box>-<backend>.log
//                                  written from the unit's start, so a log with
//                                  no row is a unit still running -- or one that
//                                  died with its run
//   <run lock>                     ~/ocannl-staging-worktrees/sweep.lock, an flock
//                                  held by the run and every process it starts
//   <lab lock dir>/<box>.lock      wake-lab's LANE lock: a remote lane holds it
//                                  while it uses the box; its first line names
//                                  the holder (`ocannl sweep <run> (pid …)`)
//   <lab lock dir>/<box>.hold.lock wake-lab's HOLD lock (`wake-lab --hold`)
//
// The locks are flocks, and this module NEVER takes one, not even shared and
// for an instant: a sweep starting in that instant refuses ("another sweep is
// running"), and a lane would count us as contention. Whether a lock is held is
// asked of lsof instead -- which processes have the file open -- in one call per
// round. A lane waiting for a lock has it open too, so "held" reads "held or
// being waited for"; the holder line says which run it is about.

import { join } from "path";
import { readFileSync, readdirSync, realpathSync, statSync } from "fs";
import { runBounded } from "./run";
import { machineForBox, type MachineLike } from "./waves";

export interface SweepConfig {
  state_dir?: string;      // ~/.ocannl-sweep
  run_lock?: string;       // ~/ocannl-staging-worktrees/sweep.lock
  lab_lock_dir?: string;   // ~/.local/state/wake-lab
  local_box_file?: string; // ~/.config/ocannl-sweep/local-box: the hub's own box id (m4-max)
  timeout_ms?: number;     // bound on the lsof call; 10000
}

export interface SweepRow {
  when: string; box: string; backend: string; ref: string; outcome: string;
  seconds: number | null; slow: boolean; log: string; execution: string;
}

export type OutcomeClass = "pass" | "fail" | "error" | "timeout" | "skip" | "gate" | "other";

export interface SweepUnit {
  box: string;
  backend: string;
  machine: string | null;
  state: "done" | "running" | "died";
  outcome: string | null;        // the row's outcome, verbatim; null until it is written
  class: OutcomeClass | null;
  seconds: number | null;
  last_output_at: string | null; // the log's mtime: a running unit's sign of life
  previous: { run: string; outcome: string; class: OutcomeClass } | null;
  change: "new-fail" | "fixed" | null;
}

export interface SweepLock { box: string; machine: string | null; kind: "lane" | "hold"; holder: string }

export interface SweepSnapshot {
  enabled: true;
  fetched_at: string | null;
  error: string | null;       // the history could not be read at all
  locks_error: string | null; // lsof failed: activity is not known, units read as "died"
  run: {
    stamp: string;
    started_at: string;
    active: boolean;
    ref: string | null;
    slow: boolean;
    units: SweepUnit[];
  } | null;
  locks: SweepLock[];          // lane and hold locks someone has open
}

const PASSING = /^(pass|incremental-pass|legacy-pass)$/;
export function outcomeClass(outcome: string): OutcomeClass {
  const head = outcome.trim().split(/[\s(]/)[0];
  if (PASSING.test(head)) return "pass";
  if (head === "fail" || head === "error" || head === "timeout" || head === "skip" || head === "gate") return head;
  return "other";
}

// history.tsv's columns are read by NAME: the sweep migrated its header once
// already (adding `execution`), and positional readers are what it guards.
export function parseHistory(text: string): SweepRow[] {
  const lines = text.split("\n").filter((l) => l.length);
  if (!lines.length) return [];
  const cols = lines[0].split("\t");
  const at = (name: string) => cols.indexOf(name);
  const need = ["when", "machine", "backend", "outcome"].map(at);
  if (need.some((i) => i < 0)) throw new Error(`history.tsv: unexpected header: ${lines[0].slice(0, 120)}`);
  const [iWhen, iBox, iBackend, iOutcome] = need;
  const iRef = at("ref"), iSec = at("seconds"), iSlow = at("slow"), iLog = at("log"), iExec = at("execution");
  return lines.slice(1).map((l) => l.split("\t")).filter((f) => f.length >= cols.length - 1).map((f) => ({
    when: f[iWhen], box: f[iBox], backend: f[iBackend], outcome: f[iOutcome],
    ref: iRef >= 0 ? f[iRef] ?? "" : "",
    seconds: iSec >= 0 && /^\d+$/.test(f[iSec] ?? "") ? Number(f[iSec]) : null,
    slow: iSlow >= 0 && f[iSlow] === "1",
    log: iLog >= 0 ? f[iLog] ?? "" : "",
    execution: iExec >= 0 ? f[iExec] ?? "" : "",
  }));
}

const STAMP = /^(\d{8}T\d{6}Z)-(.+)\.log$/;
export const stampTime = (s: string) =>
  `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`;

// The latest run, its units, and how each compares with that unit's previous run.
// `logs` are the log directory's file names; `pairs` every box/backend the history
// has ever recorded, which is how a unit's log is told from a diagnostic leg's
// (`rog-nv-cuda-native-ptx.log`) without knowing the sweep's leg names. A unit
// seen for the first time therefore shows only once its row is written.
export function latestRun(rows: SweepRow[], logs: string[], active: boolean,
  lastOutput: (name: string) => string | null, place: (box: string) => string | null): SweepSnapshot["run"] {
  const stamps = new Set(rows.map((r) => r.when));
  const logStamps = logs.map((n) => n.match(STAMP)?.[1]).filter((s): s is string => !!s);
  const stamp = [...stamps, ...logStamps].sort().at(-1);
  if (!stamp) return null;
  const pairs = new Set(rows.map((r) => `${r.box}\0${r.backend}`));
  const done = rows.filter((r) => r.when === stamp);
  const units: SweepUnit[] = [];
  const previousOf = (box: string, backend: string) => {
    const r = rows.filter((x) => x.box === box && x.backend === backend && x.when < stamp).at(-1);
    return r ? { run: r.when, outcome: r.outcome, class: outcomeClass(r.outcome) } : null;
  };
  for (const r of done) {
    const cls = outcomeClass(r.outcome), previous = previousOf(r.box, r.backend);
    units.push({
      box: r.box, backend: r.backend, machine: place(r.box), state: "done",
      outcome: r.outcome, class: cls, seconds: r.seconds,
      last_output_at: lastOutput(`${stamp}-${r.box}-${r.backend}.log`), previous,
      change: !previous ? null
        : cls === "fail" || cls === "error" || cls === "timeout" ? (previous.class === "pass" ? "new-fail" : null)
        : cls === "pass" && ["fail", "error", "timeout"].includes(previous.class) ? "fixed" : null,
    });
  }
  const recorded = new Set(done.map((r) => `${r.box}\0${r.backend}`));
  for (const name of logs) {
    const m = name.match(STAMP);
    if (!m || m[1] !== stamp) continue;
    // `<box>-<backend>`, where either may hold a hyphen: try every split against the known pairs.
    const rest = m[2];
    for (let i = rest.indexOf("-"); i > 0; i = rest.indexOf("-", i + 1)) {
      const box = rest.slice(0, i), backend = rest.slice(i + 1), key = `${box}\0${backend}`;
      if (!pairs.has(key) || recorded.has(key)) continue;
      recorded.add(key);
      units.push({
        box, backend, machine: place(box), state: active ? "running" : "died",
        outcome: null, class: null, seconds: null, last_output_at: lastOutput(name),
        previous: previousOf(box, backend), change: null,
      });
      break;
    }
  }
  const any = done[0];
  return {
    stamp, started_at: stampTime(stamp), active, units,
    ref: any?.ref || null, slow: done.length ? done.every((r) => r.slow) : false,
  };
}

// lsof -F n: `p<pid>` opens each process's block, `n<path>` each open file.
export function openPaths(lsofOut: string): Set<string> {
  return new Set(lsofOut.split("\n").filter((l) => l.startsWith("n")).map((l) => l.slice(1)));
}

// The sweep's boxes are its own ids: the hub is `m4-max` (its local-box file) or,
// in old rows, `local`; the GPU boxes are ssh stems (`rog-nv`) or short names.
export function sweepMachine(machines: MachineLike[], box: string, localBox: string | null): string | null {
  if (box === "local" || (localBox && box === localBox)) return machineForBox(machines, "local");
  return machineForBox(machines, box)
    ?? machines.find((m) => m.name.startsWith(box + "-") || m.endpoints.some((e) => e.host?.startsWith(box + "-")))?.name
    ?? null;
}

export class SweepReader {
  readonly stateDir: string;
  private readonly runLock: string;
  private readonly labLockDir: string;
  private readonly localBoxFile: string;
  private readonly timeoutMs: number;
  private history: { mtime: number; rows: SweepRow[] } | null = null;
  private refreshing: Promise<void> | null = null;
  snapshot: SweepSnapshot | null = null;

  constructor(cfg: SweepConfig, home: string, private machines: MachineLike[]) {
    const expand = (p: string) => p.replace(/^~(?=\/|$)/, home);
    this.stateDir = expand(cfg.state_dir ?? "~/.ocannl-sweep");
    this.runLock = expand(cfg.run_lock ?? "~/ocannl-staging-worktrees/sweep.lock");
    this.labLockDir = expand(cfg.lab_lock_dir ?? "~/.local/state/wake-lab");
    this.localBoxFile = expand(cfg.local_box_file ?? "~/.config/ocannl-sweep/local-box");
    this.timeoutMs = cfg.timeout_ms ?? 10_000;
  }

  refresh(): Promise<void> {
    this.refreshing ??= this.read().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async read(): Promise<void> {
    const path = join(this.stateDir, "history.tsv");
    let rows: SweepRow[];
    try {
      const mtime = statSync(path).mtimeMs;
      if (this.history?.mtime !== mtime) this.history = { mtime, rows: parseHistory(readFileSync(path, "utf8")) };
      rows = this.history.rows;
    } catch (err) {
      this.snapshot = { enabled: true, fetched_at: null, error: `cannot read ${path}: ${(err as Error).message}`,
        locks_error: null, run: null, locks: [] };
      return;
    }
    const logDir = join(this.stateDir, "logs");
    let logs: string[] = [];
    try { logs = readdirSync(logDir); } catch {}
    let localBox: string | null = null;
    try { localBox = readFileSync(this.localBoxFile, "utf8").trim() || null; } catch {}
    let labLocks: string[] = [];
    try { labLocks = readdirSync(this.labLockDir).filter((n) => n.endsWith(".lock")).map((n) => join(this.labLockDir, n)); } catch {}

    // One lsof for every lock. It exits 1 when ANY named file is not open -- the
    // usual case, with the rest listed on stdout -- so 0 and 1 are both answers.
    let open = new Set<string>(), locksError: string | null = null;
    const r = await runBounded(["lsof", "-F", "n", "--", this.runLock, ...labLocks], { timeoutMs: this.timeoutMs });
    if (r.timedOut) locksError = "lsof timed out";
    else if (r.code === 0 || r.code === 1) open = openPaths(r.out);
    else locksError = `lsof exit ${r.code}: ${r.err.trim().slice(0, 200)}`;
    // lsof names a file by its resolved path (macOS's /var is /private/var), so
    // a lock is compared through its own resolved path.
    const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
    const isOpen = (p: string) => open.has(real(p));

    const place = (box: string) => sweepMachine(this.machines, box, localBox);
    const lastOutput = (name: string) => {
      try { return new Date(statSync(join(logDir, name)).mtimeMs).toISOString(); } catch { return null; }
    };
    const locks: SweepLock[] = [];
    for (const p of labLocks) {
      if (!isOpen(p)) continue;
      const name = p.slice(this.labLockDir.length + 1).replace(/\.lock$/, "");
      const hold = name.endsWith(".hold"), box = hold ? name.slice(0, -5) : name;
      let holder = "";
      try { holder = readFileSync(p, "utf8").split("\n")[0].replace(/[\x00-\x1f]/g, "").slice(0, 200); } catch {}
      locks.push({ box, machine: place(box), kind: hold ? "hold" : "lane", holder: holder || "an unnamed holder" });
    }
    this.snapshot = {
      enabled: true,
      fetched_at: new Date().toISOString(),
      error: null,
      locks_error: locksError,
      run: latestRun(rows, logs, isOpen(this.runLock), lastOutput, place),
      locks,
    };
  }
}

// What one machine is doing for the sweep: its units of the latest run and the
// lab locks someone holds on it.
export function machineSweepView(snap: SweepSnapshot | null, machine: string) {
  if (!snap) return null;
  const units = snap.run?.units.filter((u) => u.machine === machine) ?? [];
  const locks = snap.locks.filter((l) => l.machine === machine);
  return units.length || locks.length ? { run: snap.run?.stamp ?? null, active: !!snap.run?.active, units, locks } : null;
}
