import { describe, expect, test } from "bun:test";
import { selectSleepRoute, sleepCommand, SleepController, runCommand, type Endpoint, type Observation } from "../power";
const now = 100_000;
const linux: Endpoint = { id: "linux", kind: "unix", host: "test-linux" };
const wsl: Endpoint = { id: "wsl", kind: "unix", host: "test-wsl" };
const windows: Endpoint = { id: "win", kind: "windows", host: "test-win" };
const machine = { name: "test", endpoints: [windows, wsl, linux] };
const observed = (os: string, is_wsl?: boolean, age = 0): Observation =>
  ({ ok: true, fetched_at: new Date(now-age).toISOString(), data: { os, is_wsl } });

describe("physical OS routing", () => {
  test("native Linux takes the dual-boot route even with stale Windows success", () => {
    const records = { linux: observed("linux", false), win: observed("windows", undefined, 10_000), wsl: observed("linux", true) };
    expect(selectSleepRoute(machine, e => records[e.id], now).platform).toBe("linux");
  });
  test("WSL never becomes a Linux suspend route", () => {
    expect(() => selectSleepRoute({ name: "wsl", endpoints: [wsl] }, () => observed("linux", true), now)).toThrow();
    expect(() => selectSleepRoute({ name: "wsl", endpoints: [wsl] }, () => observed("linux"), now)).toThrow();
  });
  test("Windows handles the active Windows/WSL pair", () => {
    const route = selectSleepRoute(machine, e => e.id === "win" ? observed("windows") : e.id === "wsl" ? observed("linux", true) : undefined, now);
    expect(route.endpoint.id).toBe("win");
    expect(sleepCommand(route).stdin).toContain("throw 'SetSuspendState refused suspend'");
  });
  test("stale or failed observations do not authorize sleep", () => {
    for (const st of [observed("linux", false, 60_001), { ...observed("linux", false), ok: false }])
      expect(() => selectSleepRoute(machine, () => st, now)).toThrow();
  });
  test("local Linux uses systemctl; local macOS uses pmset", () => {
    const ep = { ...linux, local: true };
    expect(sleepCommand({ endpoint: ep, platform: "linux" }).stdin).toContain("--check-inhibitors=yes suspend");
    expect(sleepCommand({ endpoint: ep, platform: "darwin" }).stdin).toContain("pmset sleepnow");
    expect(sleepCommand({ endpoint: ep, platform: "linux" }).argv[0]).toBe("sh");
  });
  test("remote Linux command rechecks WSL and never bypasses authorization", () => {
    const command = sleepCommand({ endpoint: linux, platform: "linux" });
    expect(command.stdin).toContain("Refusing to suspend WSL");
    expect(command.stdin).toContain("--no-ask-password");
    expect(command.stdin).not.toContain("sudo");
    expect(command.argv).toContain("BatchMode=yes");
  });
});

describe("delayed sleep lifecycle", () => {
  function fixture(result = { code: 0, stdout: "", stderr: "" }) {
    let executions = 0, timerCount = 0, blocked = false;
    const controller = new SleepController(
      () => { if (blocked) throw new Error("endpoint disappeared"); return { endpoint: linux, platform: "linux" }; },
      async () => { executions++; return result; }, 15_000, () => now,
      () => { timerCount++; return timerCount; }, () => {},
    );
    return { controller, count: () => executions, timers: () => timerCount, block: () => { blocked = true; } };
  }
  test("duplicate schedules share a timer and cancellation prevents execution", async () => {
    const f = fixture();
    const a = f.controller.schedule(machine);
    expect(f.controller.schedule(machine)).toEqual(a);
    expect(f.timers()).toBe(1);
    expect(f.controller.cancel(machine.name)).toBe(true);
    await f.controller.fire(machine);
    expect(f.count()).toBe(0);
    expect(f.controller.status.get(machine.name)?.state).toBe("cancelled");
  });
  test("route revalidated at execution; no command on disappeared endpoint", async () => {
    const f = fixture(); f.controller.schedule(machine); f.block(); await f.controller.fire(machine);
    expect(f.count()).toBe(0);
    expect(f.controller.status.get(machine.name)?.error).toBe("endpoint disappeared");
    expect(f.controller.pendingSnapshot()).toEqual({});
  });
  test("successful command means requested, not proven asleep", async () => {
    const f = fixture(); f.controller.schedule(machine); await f.controller.fire(machine);
    expect(f.controller.status.get(machine.name)?.state).toBe("requested");
  });
  test("permission failures remain visible after countdown finishes", async () => {
    const f = fixture({ code: 1, stdout: "", stderr: "Interactive authentication required" });
    f.controller.schedule(machine); await f.controller.fire(machine);
    expect(f.controller.status.get(machine.name)?.state).toBe("failed");
    expect(f.controller.status.get(machine.name)?.error).toContain("authentication");
  });
  test("SSH loss is unconfirmed rather than a fabricated success/failure", async () => {
    const f = fixture({ code: 255, stdout: "", stderr: "Connection closed" });
    f.controller.schedule(machine); await f.controller.fire(machine);
    expect(f.controller.status.get(machine.name)?.state).toBe("unconfirmed");
  });
});

test("command runner captures errors and enforces its deadline", async () => {
  const error = await runCommand({ argv: ["sh", "-c", "echo refused >&2; exit 7"] });
  expect(error.code).toBe(7); expect(error.stderr).toContain("refused");
  const timeout = await runCommand({ argv: [process.execPath, "-e", "setTimeout(() => {}, 10000)"] }, 50);
  expect(timeout.timedOut).toBe(true);
});
