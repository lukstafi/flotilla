#!/usr/bin/env bash
# Flotilla metrics collector for macOS and Linux (incl. WSL2).
# Emits a single JSON object on stdout. Designed to be piped over ssh:
#   ssh <host> "bash -s -- <counts> <sessions>" < unix.sh
# where both arguments are comma-separated process names from the config:
#   counts    processes worth tallying   (dune, cargo, make, ninja, tsc, ...)
#   sessions  processes worth listing    (claude, codex, ...)
# Counting is one pgrep; listing costs a ps and a cwd lookup per match, so keep
# the counts list long and the sessions list short.
# Every section is best-effort: a failing probe yields null/empty, never a crash.

set -u

WATCH_COUNTS="${1:-dune}"
WATCH_SESSIONS="${2:-claude,codex}"

OS="$(uname -s)"
HOST="$(hostname -s 2>/dev/null || hostname)"

json_escape() {
  # Escape backslashes and double quotes for embedding in JSON strings.
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | tr -d '\n\t'
}

# ---------- CPU ----------
NCPU=""
CPU_PCT=""
LOAD1=""
if [ "$OS" = "Darwin" ]; then
  NCPU=$(sysctl -n hw.ncpu 2>/dev/null)
  # iostat's second sample is a real 1s measurement (first is since-boot), and
  # unlike `top -l 2` (~1 CPU-second: it enumerates every process) it is ~free.
  # Last line ends: ... us sy id 1m 5m 15m — so us/sy are NF-5/NF-4.
  CPU_PCT=$(iostat -c 2 -w 1 2>/dev/null | awk 'END{if (NF>=6) printf "%.1f", $(NF-5)+$(NF-4)}')
  LOAD1=$(sysctl -n vm.loadavg 2>/dev/null | awk '{print $2}')
else
  NCPU=$(nproc 2>/dev/null)
  S1=($(head -1 /proc/stat)) ; sleep 1 ; S2=($(head -1 /proc/stat))
  T1=0; T2=0
  for i in 1 2 3 4 5 6 7 8; do
    T1=$((T1 + ${S1[$i]:-0})); T2=$((T2 + ${S2[$i]:-0}))
  done
  IDLE1=$(( ${S1[4]:-0} + ${S1[5]:-0} )) ; IDLE2=$(( ${S2[4]:-0} + ${S2[5]:-0} ))
  DT=$((T2 - T1))
  if [ "$DT" -gt 0 ]; then
    CPU_PCT=$(awk -v dt="$DT" -v di="$((IDLE2 - IDLE1))" 'BEGIN{printf "%.1f", 100*(dt-di)/dt}')
  fi
  LOAD1=$(awk '{print $1}' /proc/loadavg 2>/dev/null)
fi

# ---------- GPU ----------
GPU_JSON="null"
if [ "$OS" = "Darwin" ]; then
  UTIL=$(ioreg -r -d 1 -w 0 -c IOAccelerator 2>/dev/null | sed -nE 's/.*"Device Utilization %"=([0-9]+).*/\1/p' | head -1)
  if [ -n "$UTIL" ]; then
    CHIP=$(sysctl -n machdep.cpu.brand_string 2>/dev/null)
    GPU_JSON="{\"kind\":\"apple\",\"name\":\"$(json_escape "${CHIP:-Apple GPU}")\",\"util_pct\":$UTIL,\"mem_used_mb\":null,\"mem_total_mb\":null}"
  fi
else
  NVSMI=""
  if [ -x /usr/lib/wsl/lib/nvidia-smi ]; then NVSMI=/usr/lib/wsl/lib/nvidia-smi
  elif command -v nvidia-smi >/dev/null 2>&1; then NVSMI=nvidia-smi
  fi
  if [ -n "$NVSMI" ]; then
    LINE=$("$NVSMI" --query-gpu=name,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null | head -1)
    if [ -n "$LINE" ]; then
      GNAME=$(echo "$LINE" | awk -F', ' '{print $1}')
      GUTIL=$(echo "$LINE" | awk -F', ' '{print $2}')
      GUSED=$(echo "$LINE" | awk -F', ' '{print $3}')
      GTOT=$(echo "$LINE" | awk -F', ' '{print $4}')
      GPU_JSON="{\"kind\":\"nvidia\",\"name\":\"$(json_escape "$GNAME")\",\"util_pct\":${GUTIL:-null},\"mem_used_mb\":${GUSED:-null},\"mem_total_mb\":${GTOT:-null}}"
    fi
  fi
fi

# ---------- watched process counts ----------
# A tally, not an inventory: "how hard is this box being worked", not by whom.
counts_json() {
  local out="" name n
  for name in $(printf '%s' "$WATCH_COUNTS" | tr ',' ' '); do
    [ -z "$name" ] && continue
    n=$(pgrep -x "$name" 2>/dev/null | wc -l | tr -d ' ')
    [ -n "$out" ] && out="$out,"
    out="$out\"$(json_escape "$name")\":${n:-0}"
  done
  printf '{%s}' "$out"
}

# ---------- agent sessions ----------
# Some agents do not run from a binary named after them. Claude Code's remote
# CLI lives at ~/.claude/remote/ccd-cli/<version>, so its executable is named
# after the version and a name match alone misses every remote session. This
# table is knowledge the config should not have to carry.
agent_exe_fragment() {
  case "$1" in
    claude) printf '%s' ".claude/remote/ccd-cli/" ;;
    *) printf '' ;;
  esac
}

session_pids() {
  # $1: exact process name (pgrep -x). $2: optional executable-path fragment.
  local name="$1" extra="${2:-}" pid a
  pgrep -x "$name" 2>/dev/null
  [ -z "$extra" ] && return
  for pid in $(pgrep -f "$extra" 2>/dev/null); do
    a=$(ps -o args= -p "$pid" 2>/dev/null)
    # Only the executable counts, so shells that merely mention the path in their
    # own command line (this collector's pipeline included) are not counted.
    case "${a%% *}" in *"$extra"*) echo "$pid" ;; esac
  done
}

sessions_of() {
  local name="$1" extra out="" pid etime args cwd gone
  extra=$(agent_exe_fragment "$name")
  for pid in $(session_pids "$name" "$extra" | sort -un); do
    args=$(ps -o args= -p "$pid" 2>/dev/null)
    [ -z "$args" ] && continue
    case "$args" in
      # Electron/app-bundle helpers and IDE extension servers, not real sessions.
      */Applications/ChatGPT.app/*|*/.vscode/extensions/*) continue ;;
    esac
    etime=$(ps -o etime= -p "$pid" 2>/dev/null | tr -d ' ')
    cwd=""
    if [ "$OS" = "Darwin" ]; then
      cwd=$(lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | sed -n 's/^n//p' | head -1)
    else
      cwd=$(readlink "/proc/$pid/cwd" 2>/dev/null)
    fi
    # A worktree removed out from under a still-running session: Linux marks the
    # cwd link "(deleted)". Report it as a flag rather than inside the path.
    gone=false
    case "$cwd" in *" (deleted)") cwd=${cwd% (deleted)}; gone=true ;; esac
    args=$(printf '%s' "$args" | cut -c1-160)
    [ -n "$out" ] && out="$out,"
    out="$out{\"pid\":$pid,\"etime\":\"$(json_escape "$etime")\",\"cwd\":\"$(json_escape "$cwd")\",\"cwd_deleted\":$gone,\"cmd\":\"$(json_escape "$args")\"}"
  done
  printf '[%s]' "$out"
}

sessions_json() {
  local out="" name
  for name in $(printf '%s' "$WATCH_SESSIONS" | tr ',' ' '); do
    [ -z "$name" ] && continue
    [ -n "$out" ] && out="$out,"
    out="$out\"$(json_escape "$name")\":$(sessions_of "$name")"
  done
  printf '{%s}' "$out"
}

COUNTS_JSON=$(counts_json)
SESSIONS_JSON=$(sessions_json)

OS_TAG=$([ "$OS" = "Darwin" ] && echo darwin || echo linux)

printf '{"os":"%s","host":"%s","ncpu":%s,"cpu_pct":%s,"load1":%s,"gpu":%s,"counts":%s,"sessions":%s}\n' \
  "$OS_TAG" "$(json_escape "$HOST")" "${NCPU:-null}" "${CPU_PCT:-null}" "${LOAD1:-null}" \
  "$GPU_JSON" "$COUNTS_JSON" "$SESSIONS_JSON"
