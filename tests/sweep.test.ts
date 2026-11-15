import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SweepReader, latestRun, machineSweepView, openPaths, outcomeClass, parseHistory, sweepMachine } from "../sweep";

const machines = [
  { name: "hub", endpoints: [{ local: true }] },
  { name: "rog", endpoints: [{ host: "rog-nv-linux" }, { host: "rog-nv-wsl" }] },
  { name: "minix", endpoints: [{ host: "minix-amd-linux" }] },
  { name: "macbook-pro", endpoints: [{ host: "macbook-pro" }] },
];

const HEADER = "when\tmachine\tbackend\tref\toutcome\tseconds\ttarget\tslow\tlog\texecution";
const row = (when: string, box: string, backend: string, outcome: string, seconds = 60) =>
  [when, box, backend, "abc1234", outcome, String(seconds), "<all>", "0", `/logs/${when}-${box}-${backend}.log`, "forced"].join("\t");

test("outcomes fall into the classes the dashboard colours", () => {
  expect(["pass", "incremental-pass", "legacy-pass"].map(outcomeClass)).toEqual(["pass", "pass", "pass"]);
  expect(["fail", "error", "timeout", "gate"].map(outcomeClass)).toEqual(["fail", "error", "timeout", "gate"]);
  expect(outcomeClass("skip (box rog reserved by wake-lab --hold)")).toBe("skip");
  expect(outcomeClass("weird")).toBe("other");
});

test("history columns are read by name, and a header without them is refused", () => {
  const reordered = "outcome\twhen\tbackend\tmachine\n" + "pass\t20261115T093642Z\tcuda\trog-nv\n";
  expect(parseHistory(reordered)).toMatchObject([{ when: "20261115T093642Z", box: "rog-nv", backend: "cuda", outcome: "pass", seconds: null }]);
  expect(() => parseHistory("a\tb\n1\t2\n")).toThrow("unexpected header");
  expect(parseHistory("")).toEqual([]);
});

test("sweep boxes map to machines: the local box, ssh stems and short names", () => {
  expect(sweepMachine(machines, "m4-max", "m4-max")).toBe("hub");
  expect(sweepMachine(machines, "local", null)).toBe("hub");
  expect(sweepMachine(machines, "rog-nv", "m4-max")).toBe("rog");
  expect(sweepMachine(machines, "minix", "m4-max")).toBe("minix");
  expect(sweepMachine(machines, "macbook", null)).toBe("macbook-pro");
  expect(sweepMachine(machines, "tuf", "m4-max")).toBeNull();
});

const PREV = "20261114T061813Z", RUN = "20261115T093642Z";
const history = parseHistory([HEADER,
  row(PREV, "m4-max", "metal", "pass"), row(PREV, "rog-nv", "cuda", "fail"), row(PREV, "m4-max", "cc-gc-backprop", "pass"),
  row(PREV, "minix", "hip", "incremental-pass"),
  row(RUN, "m4-max", "metal", "fail"), row(RUN, "rog-nv", "cuda", "pass", 4307),
].join("\n"));
// A unit still running (hyphens in both box and backend's neighbours), a diagnostic
// leg's log, and the run's box-check log, none of which may read as units.
const logs = [`${RUN}-m4-max-metal.log`, `${RUN}-rog-nv-cuda.log`, `${RUN}-rog-nv-cuda-native-ptx.log`,
  `${RUN}-m4-max-cc-gc-backprop.log`, `${RUN}-m4-max-box-check.log`, `${RUN}-minix-hip.verdict-records`, `${PREV}-minix-hip.log`];
const place = (box: string) => sweepMachine(machines, box, "m4-max");

test("the latest run lists finished units with their change, and started ones as running", () => {
  const run = latestRun(history, logs, true, () => "2026-11-15T12:00:00.000Z", place)!;
  expect(run).toMatchObject({ stamp: RUN, started_at: "2026-11-15T09:36:42Z", active: true, ref: "abc1234" });
  const byKey = Object.fromEntries(run.units.map((u) => [`${u.box} ${u.backend}`, u]));
  expect(Object.keys(byKey).sort()).toEqual(["m4-max cc-gc-backprop", "m4-max metal", "rog-nv cuda"]);
  expect(byKey["m4-max metal"]).toMatchObject({ state: "done", class: "fail", change: "new-fail", machine: "hub" });
  expect(byKey["rog-nv cuda"]).toMatchObject({ state: "done", class: "pass", change: "fixed", machine: "rog", seconds: 4307 });
  expect(byKey["m4-max cc-gc-backprop"]).toMatchObject({ state: "running", outcome: null, previous: { outcome: "pass" } });
});

test("a unit with no row reads as died once its run no longer holds the run lock", () => {
  const run = latestRun(history, logs, false, () => null, place)!;
  expect(run.units.find((u) => u.backend === "cc-gc-backprop")!.state).toBe("died");
});

test("lsof's field output gives the open paths", () => {
  expect(openPaths("p123\nf9\nn/a/sweep.lock\np456\nf8\nn/b/rog.lock\n")).toEqual(new Set(["/a/sweep.lock", "/b/rog.lock"]));
});

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "flotilla-sweep-"));
  for (const d of ["state/logs", "lab", "wt"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "state", "history.tsv"), [HEADER, row(PREV, "m4-max", "metal", "pass"), row(PREV, "rog-nv", "cuda", "pass")].join("\n") + "\n");
  writeFileSync(join(dir, "state", "logs", `${RUN}-m4-max-metal.log`), "building\n");
  writeFileSync(join(dir, "state", "logs", `${RUN}-rog-nv-cuda.log`), "building\n");
  writeFileSync(join(dir, "lab", "rog.lock"), `ocannl sweep ${RUN} (pid 1, since ${RUN})\n`);
  writeFileSync(join(dir, "lab", "minix.lock"), "ocannl sweep old (pid 2, since old)\n");
  writeFileSync(join(dir, "local-box"), "m4-max\n");
  const reader = new SweepReader({
    state_dir: join(dir, "state"), run_lock: join(dir, "wt", "sweep.lock"), lab_lock_dir: join(dir, "lab"),
    local_box_file: join(dir, "local-box"),
  }, "/home", machines);
  return { dir, reader };
}

// Hold files open the way the sweep does: a descriptor on each. One process,
// exec'd into sleep, so killing it releases them (a child would inherit them,
// as the sweep's own children inherit its run lock).
function holdOpen(paths: string[]) {
  const redirs = paths.map((p, i) => `exec ${7 + i}>>"${p}";`).join(" ");
  return Bun.spawn(["bash", "-c", `${redirs} echo ready; exec sleep 30`], { stdout: "pipe" });
}

test("a held run lock and lane lock read as an active run and a held box; released, as died", async () => {
  const { dir, reader } = fixture();
  const holder = holdOpen([join(dir, "wt", "sweep.lock"), join(dir, "lab", "rog.lock")]);
  const reader1 = holder.stdout.getReader();
  await reader1.read(); // "ready": both descriptors are open
  try {
    await reader.refresh();
    const snap = reader.snapshot!;
    expect(snap.locks_error).toBeNull();
    expect(snap.run).toMatchObject({ stamp: RUN, active: true });
    expect(snap.run!.units.map((u) => `${u.backend}:${u.state}`).sort()).toEqual(["cuda:running", "metal:running"]);
    expect(snap.locks).toEqual([{ box: "rog", machine: "rog", kind: "lane", holder: `ocannl sweep ${RUN} (pid 1, since ${RUN})` }]);
    expect(machineSweepView(snap, "rog")).toMatchObject({ active: true, units: [{ backend: "cuda" }], locks: [{ kind: "lane" }] });
    expect(machineSweepView(snap, "macbook-pro")).toBeNull();
  } finally {
    holder.kill();
    await holder.exited;
  }
  await reader.refresh();
  expect(reader.snapshot!.run!.active).toBe(false);
  expect(reader.snapshot!.run!.units.every((u) => u.state === "died")).toBe(true);
  expect(reader.snapshot!.locks).toEqual([]);
  // Reading never writes: the holder lines are as the sweep left them.
  expect(readFileSync(join(dir, "lab", "rog.lock"), "utf8")).toBe(`ocannl sweep ${RUN} (pid 1, since ${RUN})\n`);
});

test("a --slow run stays slow when a variant unit records slow=0", () => {
  const slowRow = (box: string, backend: string, slow: string) =>
    [RUN, box, backend, "abc1234", "pass", "60", "<all>", slow, "/l", "forced"].join("\t");
  const rows = parseHistory([HEADER, slowRow("m4-max", "cc", "1"), slowRow("m4-max", "cc-outlined", "0")].join("\n"));
  expect(latestRun(rows, [], false, () => null, place)!.slow).toBe(true);
  expect(latestRun(parseHistory([HEADER, slowRow("m4-max", "cc", "0")].join("\n")), [], false, () => null, place)!.slow).toBe(false);
});

test("a host without lsof reports the locks unknown and still publishes the run", async () => {
  const { dir } = fixture();
  const reader = new SweepReader({
    state_dir: join(dir, "state"), run_lock: join(dir, "wt", "sweep.lock"), lab_lock_dir: join(dir, "lab"),
    local_box_file: join(dir, "local-box"), lsof: join(dir, "no-such-lsof"),
  }, "/home", machines);
  await reader.refresh(); // resolves: a launch failure must not reject the shared poll round
  expect(reader.snapshot!.locks_error).toContain("cannot run");
  expect(reader.snapshot!.run).toMatchObject({ stamp: RUN, active: false });
});

test("a host without sweep history reports it instead of failing", async () => {
  const reader = new SweepReader({ state_dir: "/nonexistent/sweep" }, "/home", machines);
  await reader.refresh();
  expect(reader.snapshot!.error).toContain("/nonexistent/sweep/history.tsv");
  expect(reader.snapshot!.run).toBeNull();
});

// The dashboard and CLI render the server's own view.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const render = new Function("setInterval", script.slice(0, script.lastIndexOf("\nrefresh();")) +
  ";return (machine) => renderMachine(machine);")(() => 0);

const view = (active: boolean) => machineSweepView({
  enabled: true, fetched_at: null, error: null, locks_error: null,
  run: latestRun(history, logs, active, () => new Date(Date.now() - 3600_000).toISOString(), place),
  locks: [{ box: "m4-max", machine: "hub", kind: "hold", holder: "wake-lab --hold hub" }],
}, "hub");

test("a card lists its sweep units, a new failure, a quiet running unit and held locks", () => {
  const out = render({ name: "hub", wol: false, endpoints: {}, sweep: view(true) });
  expect(out).toContain(`class="sweep"`);
  expect(out).toContain("09:36Z · running");
  expect(out).toContain(`class="xtag newfail"`);
  expect(out).toContain("running · quiet 1h");
  expect(out).toContain("wake-lab --hold hub");
});

test("the CLI prints each unit and lock of a machine's sweep view", async () => {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({ name: "hub", endpoints: {}, sweep: view(false) }) });
  try {
    const proc = Bun.spawn(["bun", new URL("../bin/flotilla", import.meta.url).pathname, "hub"], {
      env: { ...process.env, FLOTILLA_URL: `http://localhost:${server.port}`, FLOTILLA_CONFIG: "/nonexistent" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(out).toContain("sweep metal fail 1m [new-fail]");
    expect(out).toContain("sweep cc-gc-backprop died with its run");
    expect(out).toContain("sweep hold lock: wake-lab --hold hub");
  } finally {
    server.stop(true);
  }
});
