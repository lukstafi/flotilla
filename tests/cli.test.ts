import { expect, test } from "bun:test";
import { machinePayload } from "../payload";

// Run bin/flotilla against a stub server and return what it prints.
async function cli(payload: unknown, ...args: string[]) {
  const server = Bun.serve({ port: 0, fetch: () => Response.json(payload) });
  try {
    const proc = Bun.spawn(["bun", new URL("../bin/flotilla", import.meta.url).pathname, ...args], {
      env: { ...process.env, FLOTILLA_URL: `http://localhost:${server.port}`, FLOTILLA_CONFIG: "/nonexistent" },
      stdout: "pipe", stderr: "pipe",
    });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    return out;
  } finally {
    server.stop(true);
  }
}

test("the one-machine view prints the watched counts, as the fleet view does", async () => {
  const sess = (pid: number) => ({ pid, etime: "1:00", cwd: `/w/${pid}`, cmd: "claude" });
  const machine = {
    name: "mac-studio", sleep_status: null, wol: false, wave: null,
    endpoints: { local: { kind: "unix", host: "local", ok: true, fetched_at: new Date().toISOString(), data: {
      cpu_pct: 12, counts: { dune: 0 }, sessions: { claude: [sess(1), sess(2)], codex: [sess(3)] },
    } } },
  };
  const out = await cli(machinePayload({ session_idle_s: 3600, watch: { counts: ["dune"], sessions: ["claude", "codex"] } }, machine),
    "mac-studio");
  expect(out).toMatch(/^mac-studio .*cpu +12%.* dune 0  claude 2  codex 1\n/);
});
