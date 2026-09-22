import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

// Exercise the actual renderer without starting its polling or countdown timers.
const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
const render = new Function("setInterval", script.slice(0, script.lastIndexOf("\nrefresh();")) +
  ";return (machine, pending) => { sleepPending = pending; return renderMachine(machine); };")(() => 0);

test("an offline machine keeps its cancellation control throughout a pending countdown", () => {
  for (const wol of [true, false]) {
    const machine = { name: "test", wol, endpoints: {
      linux: { ok: false, data: null, error: "Connection timed out", fetched_at: null },
    } };
    const pending = render(machine, { test: new Date(Date.now() + 15000).toISOString() });
    expect(pending).toContain("postSleep('cancel'");
    expect(pending).not.toContain("postWake(");
    expect(pending).not.toContain("Wake manually");
    const idle = render(machine, {});
    expect(idle).toContain(wol ? "postWake(" : "Wake manually");
  }
});

test("a collector timeout stays visible without claiming the machine is asleep", () => {
  const result = render({ name: "test", wol: false, endpoints: {
    linux: { ok: false, data: null, error: "Collector connection or command timed out", fetched_at: null },
  } }, {});
  expect(result).toContain("Collector connection or command timed out");
  expect(result).not.toContain("unreachable — asleep?");
});
