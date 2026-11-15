import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runBounded } from "../run";

// SIGKILL is delivered at once but reaped a moment later.
async function leftover(pattern: string): Promise<string> {
  let left = "";
  for (let i = 0; i < 20; i++) {
    left = Bun.spawnSync(["pgrep", "-f", pattern]).stdout.toString().trim();
    if (!left) break;
    await Bun.sleep(50);
  }
  return left;
}

test("runBounded returns output, exit code and stdin round trip", async () => {
  const run = await runBounded(["sh", "-c", "cat; echo oops >&2; exit 5"], { stdin: Buffer.from("hi\n"), timeoutMs: 5000 });
  expect(run).toEqual({ out: "hi\n", err: "oops\n", code: 5, timedOut: false });
});

test("runBounded's deadline ends the read even when a grandchild holds the pipes", async () => {
  const started = Date.now();
  const run = await runBounded(["bash", "-c", "echo early; echo warn >&2; sleep 31.6 & sleep 31.6"], { timeoutMs: 300 });
  expect(Date.now() - started).toBeLessThan(2000);
  expect(run.timedOut).toBe(true);
  expect(run.code).toBeNull();
  expect(run.out).toBe("early\n"); // what was read before the deadline is kept
  expect(run.err).toBe("warn\n");
  expect(await leftover("sleep 31.6")).toBe("");
});

test("a stalled collector neither blocks later rounds nor a close, and leaves nothing behind", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flotilla-bounded-test-"));
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port; reserve.stop(true);
  // One desktop record vouching that the session in /w/idle has long been quiet.
  const store = join(dir, "store");
  mkdirSync(join(store, "dev", "sub"), { recursive: true });
  writeFileSync(join(store, "dev", "sub", "s.json"), JSON.stringify({ cwd: "/w/idle", lastActivityAt: 0, title: "idle" }));
  const config = join(dir, "config.json");
  writeFileSync(config, JSON.stringify({ port, poll_interval_s: 0.1, idle_after_s: 60, ssh_timeout_ms: 400,
    session_idle_s: 1, desktop_store: store,
    machines: [{ name: "test", endpoints: [
      { id: "good", kind: "unix", host: "good-test" },
      { id: "stall", kind: "unix", host: "stall-test" },
    ] }], watch: { counts: [], sessions: [] } }));
  // The close arrives as "sh -s --"; the collector as "bash -s --". Each stall
  // backgrounds a grandchild that inherits the pipes, as pgrep or nvidia-smi would.
  writeFileSync(join(dir, "ssh"), `#!/bin/sh
case "$*" in
  *" sh -s -- "*) sleep 31.9 & sleep 31.9;;
  *stall-test*) sleep 31.8 & sleep 31.8;;
  *) cat >/dev/null; printf '%s\\n' '{"os":"linux","is_wsl":false,"ncpu":1,"counts":{},"sessions":{"claude":[{"pid":4242,"cwd":"/w/idle","cmd":"claude"}]}}';;
esac
`);
  chmodSync(join(dir, "ssh"), 0o755);
  const proc = Bun.spawn([process.execPath, "server.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, PATH: dir + ":" + process.env.PATH, FLOTILLA_CONFIG: config },
    stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const base = `http://localhost:${port}`;
  const endpoints = async () => (await (await fetch(base + "/api/fleet")).json()).machines[0].endpoints;
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if (await check()) return; } catch {}
      await Bun.sleep(20);
    }
    throw new Error("Timed out waiting for isolated test server");
  }
  try {
    await until(async () => (await endpoints()).stall.error === "Collector connection or command timed out");
    // Rounds keep coming: the healthy endpoint refreshes again after the stall timed out.
    const first = (await endpoints()).good.fetched_at;
    await until(async () => (await endpoints()).good.fetched_at > first);
    const started = Date.now();
    const close = await fetch(base + "/api/session/close", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ machine: "test", endpoint: "good", pid: 4242 }) });
    expect(close.status).toBe(504);
    expect((await close.json()).error).toContain("timed out");
    expect(Date.now() - started).toBeLessThan(2000);
    expect(await leftover("sleep 31.9")).toBe("");
  } finally {
    proc.kill(); await proc.exited; await stderr;
    rmSync(dir, { recursive: true, force: true });
  }
  // A stalled poll in flight when the server stopped goes with it.
  expect(await leftover("sleep 31.8")).toBe("");
}, 15_000);
