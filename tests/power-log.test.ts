import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The dashboard's in-browser half, run with stand-ins for the browser globals.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
function dashboard() {
  const store = new Map<string, string>();
  const localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
  const sent: any[] = [];
  const elements = new Map<string, any>();
  const element = (id: string) => elements.get(id) ?? elements.set(id, { textContent: "", innerHTML: "",
    querySelector: () => element(id + " pre") }).get(id);
  let reply: () => Response = () => Response.json({ machine: "rog", sleep_at: "2026-10-07T09:10:44.000Z" });
  const fetch = async (path: string, init: any) => {
    if (path === "/api/power-log") { sent.push(JSON.parse(init.body)); return Response.json({ ok: true }); }
    if (path === "/api/fleet") throw new Error("not under test");
    return reply();
  };
  const api = new Function("setInterval", "localStorage", "fetch", "document",
    script.slice(0, script.lastIndexOf("\nrefresh();")) +
    ";return { postSleep, postWake, readPowerLog, powerLogLines };")(
    () => 0, localStorage, fetch, { getElementById: element, querySelectorAll: () => [] });
  return { api, sent, setReply: (r: () => Response) => { reply = r; } };
}

test("a power click is logged before its request and again with the outcome", async () => {
  const { api, sent, setReply } = dashboard();
  await api.postSleep("sleep", "rog");
  setReply(() => Response.json({ error: "No recently reachable native OS sleep route" }, { status: 409 }));
  await api.postWake("minix");
  const log = api.readPowerLog();
  expect(log.map((e: any) => [e.phase, e.action, e.machine])).toEqual([
    ["click", "sleep", "rog"], ["done", "sleep", "rog"], ["click", "wake", "minix"], ["done", "wake", "minix"]]);
  expect(log[0].id).toBe(log[1].id);
  expect(log[1].outcome).toBe("ok sleep_at 2026-10-07T09:10:44.000Z");
  expect(log[3].outcome).toBe("error: No recently reachable native OS sleep route");
  expect(sent).toEqual(log); // every entry is mirrored to the hub
  const lines = api.powerLogLines(log);
  expect(lines[0]).toContain("wake minix  error: No recently reachable");
  expect(lines[1]).toContain("sleep rog  ok sleep_at");
});

test("a click whose request never answers still shows in the log", () => {
  const { api } = dashboard();
  const at = "2026-10-07T09:10:00.000Z";
  const lines = api.powerLogLines([{ id: "a", phase: "click", action: "sleep", machine: "rog", at }]);
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("sleep rog  no reply recorded");
});

test("the hub appends valid power-log entries and refuses malformed ones", async () => {
  const dir = mkdtempSync(join(tmpdir(), "flotilla-power-log-test-"));
  const reserve = Bun.serve({ port: 0, fetch: () => new Response("reserved") });
  const port = reserve.port; reserve.stop(true);
  const config = join(dir, "config.json"), logPath = join(dir, "state", "power-clicks.jsonl");
  writeFileSync(config, JSON.stringify({ port, poll_interval_s: 60, ssh_timeout_ms: 1000, power_log: logPath,
    machines: [], watch: { counts: [], sessions: [] } }));
  const proc = Bun.spawn([process.execPath, "server.ts"], {
    cwd: join(import.meta.dir, ".."), env: { ...process.env, FLOTILLA_CONFIG: config }, stdout: "ignore", stderr: "pipe",
  });
  const stderr = new Response(proc.stderr).text();
  const base = `http://localhost:${port}`;
  const post = (body: unknown) => fetch(base + "/api/power-log",
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  try {
    const deadline = Date.now() + 5000;
    while (true) {
      try { if ((await fetch(base + "/healthz")).ok) break; } catch {}
      if (Date.now() > deadline) throw new Error("Timed out waiting for isolated test server");
      await Bun.sleep(20);
    }
    const click = { id: "k1", at: "2026-10-07T09:10:29.000Z", phase: "click", action: "sleep", machine: "rog" };
    expect((await post(click)).status).toBe(200);
    expect((await post({ ...click, phase: "done", outcome: "ok" })).status).toBe(200);
    expect((await post({ ...click, action: "reboot" })).status).toBe(400);
    expect((await post({ ...click, id: undefined })).status).toBe(400);
    expect((await post("not an object")).status).toBe(400);
    expect(existsSync(logPath)).toBe(true);
    const lines = readFileSync(logPath, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => [l.phase, l.action, l.machine, l.outcome])).toEqual([
      ["click", "sleep", "rog", undefined], ["done", "sleep", "rog", "ok"]]);
    expect(lines[0].from).toBeTruthy();
    expect(lines[0].received_at).toBeTruthy();
  } finally {
    proc.kill(); await proc.exited; await stderr;
    rmSync(dir, { recursive: true, force: true });
  }
}, 10_000);
