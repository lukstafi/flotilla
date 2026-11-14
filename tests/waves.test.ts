import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WaveReader, isTerminal, machineForBox, machineWaveView, parseBoard, parseCoordinator, parseExecutions, unplacedTasks,
} from "../waves";

const machines = [
  { name: "hub", endpoints: [{ local: true }] },
  { name: "rog", endpoints: [{ host: "rog-nv-linux" }, { host: "rog-nv-wsl" }] },
];

const board = (wave: string, tasks: [string, Record<string, unknown>][]) => ({
  board: 1, wave, updated_at: "2026-11-13T23:46:10Z",
  notes: { gate_mac: "codex login expired", count: 3 },
  tasks: tasks.map(([task, fields]) => ({ task, fields, updated_at: "2026-11-13T23:00:00Z" })),
});

test("every spelling of a finished task coordinators have used reads as terminal", () => {
  for (const s of ["merged #1137 at 9d689b6ada85", "MERGED 37a9539b; issue closed;", "dropped: superseded", "done", "closed"])
    expect(isTerminal(s)).toBe(true);
  for (const s of ["launched", "", "PR1 #1207 b49aef90 + PR2 #1217", "CENSUS posted"]) expect(isTerminal(s)).toBe(false);
  expect(isTerminal("", { merge: "0ad58409d88e5a51d74a68df5e459b83674ba5ae" })).toBe(true);
});

test("a board row keeps what the dashboard needs and only string notes", () => {
  const b = parseBoard(board("w1", [["t1", {
    issue: "o/r#1", repository: "o/r", pr: "12", state: "merged #12 at abc", agent_host: "rog-nv-linux",
    exec_hosts: "rog-nv-linux mac-studio", worktree: "/w/t1", kind: "codex",
  }], ["t2", { state: "launched", exec_hosts: "none", pr: "none" }]]))!;
  expect(b.notes).toEqual({ gate_mac: "codex login expired" });
  expect(b.tasks[0]).toMatchObject({ task: "t1", pr: "12", terminal: true, exec_hosts: ["rog-nv-linux", "mac-studio"] });
  expect(b.tasks[1]).toMatchObject({ pr: null, terminal: false, exec_hosts: [], agent_host: null });
  expect(parseBoard({ wave: "x" })).toBeNull();
});

test("the coordinator lease is read without its token", () => {
  const c = parseCoordinator("host=Mac/session-1\ntoken=secret-token\nsince=2026-11-13T21:14:38Z\n");
  expect(c).toEqual({ host: "Mac/session-1", since: "2026-11-13T21:14:38Z" });
  expect(JSON.stringify(c)).not.toContain("secret");
});

test("boxes map to machines by name, endpoint host, or local", () => {
  expect(machineForBox(machines, "rog-nv-wsl")).toBe("rog");
  expect(machineForBox(machines, "hub")).toBe("hub");
  expect(machineForBox(machines, "local")).toBe("hub");
  expect(machineForBox(machines, "tuf-amd-linux")).toBeNull();
});

test("a machine sees its own tasks, tasks that only execute there, and its reservations", () => {
  const tasks = parseBoard(board("w1", [
    ["a", { agent_host: "rog-nv-linux", exec_hosts: "rog-nv-linux", issue: "o/r#1", state: "launched" }],
    ["b", { agent_host: "hub", exec_hosts: "rog-nv-linux", issue: "o/r#2", state: "launched" }],
    ["c", { agent_host: "tuf-amd-linux", exec_hosts: "tuf-amd-linux", issue: "o/r#3", state: "launched" }],
  ]))!.tasks;
  const executions = parseExecutions(JSON.stringify([
    { request_id: "w1-a-rog", state: "dispatched", request: { wave: "w1", issue: "o/r#1", kind: "measurement", execution_host: "rog-nv-linux" } },
  ]));
  const snap: any = { tasks, executions };
  const rog = machineWaveView(snap, machines, "rog")!;
  expect(rog.tasks.map((t) => t.task)).toEqual(["a"]);
  expect(rog.visiting.map((t) => t.task)).toEqual(["b"]);
  expect(rog.executions.map((x) => x.kind)).toEqual(["measurement"]);
  expect(machineWaveView(snap, machines, "hub")!.tasks.map((t) => t.task)).toEqual(["b"]);
  expect(unplacedTasks(snap, machines).map((t) => t.task)).toEqual(["c"]);
});

function fixture(fleetWorker: string) {
  const dir = mkdtempSync(join(tmpdir(), "flotilla-waves-"));
  mkdirSync(join(dir, "boards"));
  writeFileSync(join(dir, "boards", "w1.json"), JSON.stringify(board("w1", [
    ["done", { agent_host: "rog-nv-linux", worktree: "/w/done", state: "merged #5 at abc", pr: "5" }],
    ["live", { agent_host: "rog-nv-linux", worktree: "/w/live", state: "launched", issue: "o/r#6" }],
  ])));
  writeFileSync(join(dir, "COORDINATOR"), "host=Mac/s\ntoken=t\nsince=2026-11-13T21:14:38Z\n");
  const fw = join(dir, "fw.sh");
  writeFileSync(fw, fleetWorker);
  return { dir, reader: new WaveReader({ state_dir: dir, fleet_worker: fw }, "/home", machines) };
}

test("a session is joined to the task of the worktree it runs in, on that machine only", async () => {
  const { reader } = fixture(`echo '[]'`);
  await reader.refresh();
  expect(reader.taskForSession("rog", "/w/done")).toMatchObject({ task: "done", terminal: true });
  expect(reader.taskForSession("rog", "/w/live/src/deep")).toMatchObject({ task: "live", terminal: false });
  expect(reader.taskForSession("hub", "/w/live")).toBeNull();
  expect(reader.taskForSession("rog", "/w/livestock")).toBeNull();
  const snap = reader.snapshot!;
  expect(snap.tasks.map((t) => t.task)).toEqual(["live"]);
  expect(snap.waves).toMatchObject([{ wave: "w1", tasks: 2, active: 1 }]);
  expect(snap.halt).toBeNull();
});

test("a failing registry keeps the last good reservations and says they are stale", async () => {
  const { dir, reader } = fixture(`echo 'note'; echo '[{"request_id":"r1","state":"dispatched","request":{"execution_host":"rog-nv-linux"}}]'`);
  await reader.refresh();
  expect(reader.snapshot!.executions.map((x) => x.request_id)).toEqual(["r1"]);
  writeFileSync(join(dir, "fw.sh"), `echo boom >&2; exit 1`);
  writeFileSync(join(dir, "HALT"), "2026-11-14T00:00:00Z id=h1 stop\n");
  await reader.refresh();
  expect(reader.snapshot!.executions.map((x) => x.request_id)).toEqual(["r1"]);
  expect(reader.snapshot!.executions_error).toContain("boom");
  expect(reader.snapshot!.halt).toContain("id=h1");
});

test("a host without anchor state reports it instead of failing", async () => {
  const reader = new WaveReader({ state_dir: "/nonexistent/issue-wave", fleet_worker: "/bin/true" }, "/home", machines);
  await reader.refresh();
  expect(reader.snapshot!.error).toContain("/nonexistent/issue-wave/boards");
  expect(reader.snapshot!.tasks).toEqual([]);
});

// The dashboard renderer, as power-ui.test.ts exercises it.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const render = new Function("setInterval", script.slice(0, script.lastIndexOf("\nrefresh();")) +
  ";return (machine) => renderMachine(machine);")(() => 0);

test("a resident session on a finished wave task is flagged, and the card lists the wave", () => {
  const sess = (cwd: string, wave: any) => ({ pid: 1, etime: "1:00", cwd, cmd: "codex", quiet_s: null, closable: false, wave });
  const out = render({
    name: "rog", wol: false,
    wave: {
      tasks: [{ wave: "w1", task: "live", issue: "o/r#6", repository: "o/r", pr: null, state: "launched" }],
      visiting: [],
      executions: [{ request_id: "r1", wave: "w1", issue: "o/r#6", kind: "measurement", state: "dispatched", standing: false }],
    },
    endpoints: { linux: { ok: true, fetched_at: new Date().toISOString(), data: { sessions: { codex: [
      sess("/w/done", { wave: "w1", task: "done", pr: "5", state: "merged #5 at abc", terminal: true }),
      sess("/w/live", { wave: "w1", task: "live", pr: null, state: "launched", terminal: false }),
    ] } } } },
  });
  expect(out).toContain(`class="wtag done"`);
  expect(out).toContain("done merged #5");
  expect(out).toContain("still resident");
  expect(out).toContain(`class="wave"`);
  expect(out).toContain("https://github.com/o/r/issues/6");
  expect(out).toContain(`class="xtag measurement"`);
});
