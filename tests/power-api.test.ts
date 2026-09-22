import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("HTTP sleep scheduling, cancellation, and delayed failure use the native route", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flotilla-power-test-"));
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port; reserve.stop(true);
  const config = join(dir, "config.json"), log = join(dir, "commands");
  writeFileSync(config, JSON.stringify({ port, poll_interval_s: 0.1, idle_after_s: 0.05, sleep_delay_s: 0.2, ssh_timeout_ms: 1000,
    machines: [{ name: "test", endpoints: [
      { id: "linux", kind: "unix", host: "native-test" },
      { id: "win", kind: "windows", host: "offline-test" },
      { id: "timeout", kind: "unix", host: "timeout-test" },
    ] }], watch: { counts: [], sessions: [] } }));
  writeFileSync(join(dir, "ssh"), `#!/bin/sh
case "$*" in *offline-test*) exit 255;; *timeout-test*) exec sleep 10;; esac
body=$(cat)
case "$body" in
  *'exec systemctl'*) echo native-suspend >> "$FLOTILLA_TEST_COMMANDS"; echo 'mock: authorization required' >&2; exit 1;;
  *) echo collect >> "$FLOTILLA_TEST_COMMANDS.polls"; printf '%s\\n' '{"os":"linux","is_wsl":false,"ncpu":1,"counts":{},"sessions":{}}';;
esac
`);
  chmodSync(join(dir, "ssh"), 0o755);
  const proc = Bun.spawn([process.execPath, "server.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, PATH: dir + ":" + process.env.PATH,
      FLOTILLA_CONFIG: config, FLOTILLA_TEST_COMMANDS: log }, stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const base = `http://localhost:${port}`;
  async function until(check: () => Promise<boolean>) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try { if (await check()) return; } catch {}
      await Bun.sleep(20);
    }
    throw new Error("Timed out waiting for isolated test server");
  }
  const snapshot = async () => (await fetch(base + "/api/fleet")).json();
  const post = (path: string) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: '{"machine":"test"}' });
  try {
    await until(async () => (await snapshot()).machines[0].endpoints.linux.ok);
    const preparing = post("/api/sleep");
    await until(async () => (await snapshot()).sleep_preparing.includes("test"));
    expect((await (await post("/api/sleep-cancel")).json()).cancelled).toBe(true);
    expect((await preparing).status).toBe(409);
    expect(existsSync(log)).toBe(false);
    const scheduled = await post("/api/sleep");
    expect(scheduled.status).toBe(200);
    const countdown = await scheduled.json();
    expect(await (await post("/api/sleep")).json()).toEqual(countdown);
    expect((await (await post("/api/sleep-cancel")).json()).cancelled).toBe(true);
    await Bun.sleep(250);
    expect(existsSync(log)).toBe(false);
    expect((await post("/api/sleep")).status).toBe(200);
    await until(async () => (await snapshot()).sleep_status.test?.state === "failed");
    const state = await snapshot();
    expect(state.sleep_status.test.endpoint).toBe("linux");
    expect(state.sleep_status.test.error).toContain("authorization required");
    expect(state.sleep_pending).toEqual({});
    const machine = await (await fetch(base + "/api/fleet/test")).json();
    expect(machine.sleep_status).toEqual(state.sleep_status.test);
    expect(readFileSync(log, "utf8")).toBe("native-suspend\n");
    await until(async () => (await snapshot()).machines[0].endpoints.timeout.error?.includes("timed out"));
    expect((await post("/api/wake")).status).toBe(400); // no fabricated WoL capability
    await Bun.sleep(1300); // Let the current round finish and client activity expire.
    const before = readFileSync(log + ".polls", "utf8");
    expect((await post("/api/sleep")).status).toBe(200); // No GET to wake polling first.
    expect(readFileSync(log + ".polls", "utf8").length).toBeGreaterThan(before.length);
    expect((await (await post("/api/sleep-cancel")).json()).cancelled).toBe(true);
  } finally {
    proc.kill(); await proc.exited; await stderr;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
