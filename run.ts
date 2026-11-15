// A subprocess read with a deadline that actually bounds it.
//
// Killing only the direct child does not end the read: a grandchild (a local
// collector's pgrep or nvidia-smi, say) inherits the stdout/stderr pipes and
// keeps them open after the child dies.
// So the child gets its own process group, which the deadline kills whole,
// and the deadline races the reads rather than waiting for them, in case a
// descendant escaped the group. Output read before the deadline is kept.
//
// Its own group also takes the child out of ours, so a signal to the server's
// group (Ctrl-C, launchd stopping the job) no longer reaches it: the server
// ends the groups still running with killLiveGroups() on its way out.

export interface Bounded {
  out: string;
  err: string;
  code: number | null; // null when the deadline ended it
  timedOut: boolean;
}

export interface BoundedOptions {
  stdin?: Blob | Uint8Array; // Bun.file(...) or bytes; nothing when omitted
  timeoutMs: number;
}

const live = new Set<number>();

function killGroup(pid: number, fallback: () => void): void {
  try { process.kill(-pid, "SIGKILL"); } catch { fallback(); }
}

export function killLiveGroups(): void {
  for (const pid of live) killGroup(pid, () => {});
  live.clear();
}

async function drain(stream: ReadableStream<Uint8Array>, sink: { text: string }): Promise<void> {
  const decoder = new TextDecoder();
  for await (const chunk of stream) sink.text += decoder.decode(chunk, { stream: true });
  sink.text += decoder.decode();
}

export async function runBounded(argv: string[], opts: BoundedOptions): Promise<Bounded> {
  const proc = Bun.spawn(argv, {
    stdin: opts.stdin ?? "ignore", stdout: "pipe", stderr: "pipe", detached: true,
  });
  live.add(proc.pid); // until the read ends, not the child: its group may outlive it
  const out = { text: "" }, err = { text: "" };
  const collected = Promise.all([drain(proc.stdout, out), drain(proc.stderr, err), proc.exited]);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.timeoutMs); });
  const result = await Promise.race([collected, deadline]);
  clearTimeout(timer);
  if (result) live.delete(proc.pid);
  if (result) return { out: out.text, err: err.text, code: result[2], timedOut: false };
  killGroup(proc.pid, () => proc.kill("SIGKILL"));
  live.delete(proc.pid);
  collected.catch(() => {});
  return { out: out.text, err: err.text, code: null, timedOut: true };
}
