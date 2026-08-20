# Flotilla

A live view of the small fleet of machines your coding agents run on: which
sessions are alive and where, which machines are awake, and which processes are
still resident for work you already finished.

Nothing is installed on the machines it watches. Collectors are piped over SSH
and run from stdin, so a machine joins the fleet by accepting an SSH key.

```
mac-studio   cpu   8%  gpu  9%   dune 0  claude 5  codex 0
  claude pid 10601 up 01:54:35  Glob benchmarks/dune's Python test deps  idle 2h
  claude pid 63753 up 03:14:05  Add a drift check for .gitignore cache dirs
rog          cpu   0%  gpu  0%   dune 0  claude 6  codex 0
  claude pid 54013 up 3-01:24:17  Measure the gh-574 finer-fission prize  idle 94h
  claude pid 984239 up 01:36:33  Ahrefs/ocannl issues #648 and #663
```

## The gap it fills

Agent session managers know what a session *is* and when it last mattered. They
do not know what is still **resident**. A process scan knows what is resident but
not what any of it means.

Flotilla joins the two, and the disagreement is the interesting part: sessions
whose pull request merged days ago, still holding memory on the machine they ran
on, invisible to the tool that started them because it has already moved on.
That is what the close button is for.

The machine metrics are context for that, not the point. If you want history,
alerting, disks, network and temperatures, run [Beszel] or [Netdata] — they are
better at it than this will ever be.

[Beszel]: https://beszel.dev
[Netdata]: https://www.netdata.cloud

## What it shows

- **CPU occupancy** — on dual-boot boxes the Windows counter is host-wide truth
  (it includes the WSL2 VM); the WSL number is shown separately.
- **GPU load** — macOS via `ioreg` (IOAccelerator), NVIDIA via `nvidia-smi`
  (whole-card, so it covers Windows load seen from WSL), and Windows GPU-engine
  perf counters where the card is invisible from WSL (an AMD iGPU has no
  `/dev/kfd`). Instantaneous readings are 1-second point samples, so each
  endpoint also carries 1/5/15-minute moving averages.
- **Watched process counts** — a tally per configured name (`dune`, `cargo`,
  `make`, …): how hard the box is being worked, not by whom.
- **Agent sessions** — title, uptime, working directory, and liveness per
  session. Sessions whose worktree was deleted out from under them are tagged
  **no worktree**; idle ones can be closed from the dashboard.
- **Reachability** — a machine whose endpoints all time out renders as
  "unreachable — asleep?" rather than as an error, and its sleep button becomes
  a wake button.

## Quick start

Needs [Bun] on the hub and `sshd` on everything else.

```bash
git clone https://github.com/lukstafi/flotilla && cd flotilla
cp flotilla.config.example.json flotilla.config.json   # then edit it
bun server.ts
```

[Bun]: https://bun.sh

The hub polls every endpoint over SSH, so it needs passwordless SSH to each
machine, and `bash` (macOS/Linux/WSL) or `powershell` (Windows) on the far end.
Adding a machine is an entry in the config; nothing else.

For autostart on macOS, adapt `launchd/com.lukstafi.flotilla.plist.example`.
After editing `server.ts`, restart it — the collectors and the dashboard page are
re-read per request, but the server itself is not.

## Configuration

`flotilla.config.json` (or `$FLOTILLA_CONFIG`). See
`flotilla.config.example.json` for a commented copy.

| key | meaning |
| --- | --- |
| `port` | what the hub listens on (default 7799) |
| `server_url` | what clients elsewhere should call; defaults to `localhost:<port>` |
| `poll_interval_s` | seconds between rounds (default 15) |
| `idle_after_s` | stop measuring after this long without a client (default 90) |
| `sleep_delay_s` | cancellable delay before a machine suspends (default 15) |
| `session_idle_s` | how quiet a session must be to be closable (default 3600) |
| `watch.counts` | process names to tally — one `pgrep` each, so a long list is fine |
| `watch.sessions` | process names to list — a `ps` and a cwd lookup per match, so keep it short |
| `desktop_store` | Claude Desktop's session directory, if not the macOS default |
| `machines[]` | one entry per physical machine, each with one or more endpoints |

The machine carrying a `local` endpoint is the one running the server. Defaults
name what the author runs (`dune`, `claude`, `codex`); a config listing `cargo`
and `aider` instead is a first-class setup.

Some agents do not run from a binary named after them — Claude Code's remote CLI
lives at `~/.claude/remote/ccd-cli/<version>`, so its executable is named after
the version and a name match alone misses every remote session. The collector
carries that knowledge for the agents it knows, so the config does not have to.

## Closing idle sessions

Idle sessions carry a close button: `×`, then `kill?` to confirm. Two taps,
because a stray click should not end a session. Working sessions show a lit dot
and no button.

"Idle" comes from **Claude Desktop's own session records**, which the server
reads off disk — it is co-located with the desktop, and the desktop tracks
sessions running on remote machines too. `quiet_s` is the age of that record's
last activity, and a session becomes closable past `session_idle_s`.

Process CPU was tried first as the liveness signal and does not work: an idle
session and a working one both sit near 1%, because a session's real work happens
in child processes, not in the agent process itself. The desktop's own notion of
activity separates cleanly — live sessions read minutes quiet, abandoned ones
read days. The threshold defaults to an hour because that record moves at turn
boundaries rather than continuously, so a single long turn looks quiet; an hour
sits far above the longest plausible turn and far below anything abandoned.

Every gate is re-checked server-side — the button is a convenience, not the
authority — and the far end re-reads the process's command line and kills only if
it still matches the session the dashboard offered, so a pid recycled between
poll and click is a no-op. Termination is SIGTERM, so the session can shut down
its transport and flush its transcript.

```bash
curl -X POST $FLOTILLA_URL/api/session/close \
  -H 'content-type: application/json' \
  -d '{"machine":"rog","endpoint":"wsl","pid":1257}'
```

Refusals are explicit: `409` with `quiet_s`/`threshold_s` for a session that is
not idle, `409` for an identity mismatch or an already-dead process, `404` for a
pid that is not a known Claude session on that endpoint. Only Claude sessions are
closable, and only on unix endpoints. Without the desktop store — any hub not
running Claude Desktop — nothing is closable, which is a safe default rather than
a fallback guess.

## Sleep and wake

Each machine has a **sleep** button (`flotilla sleep <machine>`, or
`POST /api/sleep`). The suspend fires after `sleep_delay_s` — a window to power
off input devices that would otherwise interrupt going to sleep — and is
cancellable until it fires. macOS sleeps via `pmset sleepnow`; other machines
suspend their Windows host, WSL included, via `SetSuspendState` over SSH.

An unreachable machine's button becomes **wake**: `POST /api/wake` sends
Wake-on-LAN magic packets to the MACs in its `wol` config over the LAN
broadcast. Waking the hub itself cannot go through the server — it is down with
its host — so `flotilla wake <machine>` relays the packet send through the first
awake machine over SSH whenever the server is unreachable.

Magic packets reliably wake Macs over **Ethernet only**, even with "Wake for
network access" enabled. A Wi-Fi-only Mac hub is worth pairing with a scheduled
`pmset` wake.

## Agent access

Any agent on any machine can query the JSON directly:

```bash
curl -s $FLOTILLA_URL/api/fleet          # everything
curl -s $FLOTILLA_URL/api/fleet/rog      # one machine
```

Or use the CLI, which prints a compact table (`--json` for the raw payload):

```bash
./bin/flotilla
./bin/flotilla rog
```

Payload shape: `machines[].endpoints.<id>` each carry `ok`/`error`/`fetched_at`
plus `data` with `cpu_pct`, `load1`, `ncpu`, `gpu`
(`kind`/`name`/`util_pct`/`mem_used_mb`/`mem_total_mb`), `counts` (a map of
name → count) and `sessions` (a map of name → array of
`pid`/`etime`/`cwd`/`cwd_deleted`/`cmd`, plus `title`/`branch`/`archived`/
`quiet_s`/`closable` where Claude Desktop knows the session). Each endpoint also
carries `avg.{m1,m5,m15}` moving averages of `cpu_pct` and `gpu_util_pct`, with
the contributing sample count. History is in memory and resets on restart.

**Polling pauses when nobody is watching**: after `idle_after_s` without any
request, measurement stops. Any request — dashboard or agent curl — resumes it;
the first response after a pause serves the stale cache (check `fetched_at`)
while a fresh round starts, or pass `?fresh=1` to wait for that round. The
`polling` field reports `active`/`paused`.

## What this is not

No history beyond the in-memory averages, no alerting, no disks, no network, no
temperatures, no authentication. The hub holds passwordless SSH to every machine
it watches and exposes unauthenticated `POST /api/sleep` and
`/api/session/close` on its port. Bind it to a trusted network — a tailnet, a
home LAN — and not to the open internet.

## Layout

- `server.ts` — the hub: SSH poller, cache, HTML and JSON routes.
- `collect/unix.sh` — macOS/Linux/WSL collector (one JSON object on stdout).
- `collect/windows.ps1` — Windows collector (perf counters).
- `collect/close-session.sh` — identity-checked session terminator.
- `public/index.html` — the dashboard page.
- `bin/flotilla` — CLI client.
- `launchd/` — autostart template for a macOS hub.

## License

Apache-2.0.
