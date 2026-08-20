#!/usr/bin/env sh
# Terminate one agent session, identity-checked. Piped over ssh like the
# collectors, so nothing is installed on the remote machine:
#   ssh <host> "sh -s -- <pid> <base64-of-expected-cmd>" < close-session.sh
#
# The expected command line comes from the cached snapshot the user clicked on.
# Killing only when the live process still matches it makes a recycled pid — or
# a stale dashboard — a no-op instead of a mis-kill. base64 keeps the expected
# string a single shell-safe word.
#
# Exit: 0 terminated · 2 bad usage · 3 identity mismatch · 4 no such process

set -u

pid="${1:-}"
want_b64="${2:-}"
[ -n "$pid" ] && [ -n "$want_b64" ] || { echo "usage: close-session.sh <pid> <b64cmd>" >&2; exit 2; }
case "$pid" in *[!0-9]*) echo "bad pid: $pid" >&2; exit 2 ;; esac

live=$(ps -o args= -p "$pid" 2>/dev/null | cut -c1-160)
[ -n "$live" ] || { echo "no such process: $pid" >&2; exit 4; }

want=$(printf '%s' "$want_b64" | base64 -d 2>/dev/null || printf '%s' "$want_b64" | base64 -D 2>/dev/null)
[ "$live" = "$want" ] || {
  echo "identity mismatch for $pid" >&2
  echo "  live: $live" >&2
  echo "  want: $want" >&2
  exit 3
}

# SIGTERM: let the session shut down its own transport and flush its transcript.
kill "$pid" || exit 4
echo "terminated $pid"
