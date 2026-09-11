"""Run with python3 tests/collector-sessions.py; no live processes are required."""
import json
from pathlib import Path
import subprocess

source = (Path(__file__).resolve().parents[1] / 'collect/unix.sh').read_text()
functions = source[source.index('agent_exe_fragment()'):source.index('COUNTS_JSON=')]
escape = source[source.index('json_escape()'):source.index('# ---------- CPU')]
fixture = r'''
OS=Darwin
pgrep() {
  case "$*" in
    '-x codex') printf '10\n20\n30\n40\n' ;;
    '-x claude') echo 60 ;;
    '-f .claude/remote/ccd-cli/') printf '61\n62\n' ;;
  esac
}
exe() {
  case "$1" in
    10) echo /usr/local/bin/codex ;;
    20) echo /Applications/ChatGPT.app/Contents/Resources/codex ;;
    21) echo '/Volumes/My Apps/Codex.app/Contents/Resources/codex' ;;
    30) echo /Users/test/.vscode/extensions/openai/bin/codex ;;
    40) echo /Applications/ChatGPT.app/Contents/Resources/codex-code-mode-host ;;
    50) echo /bin/sh ;;
    60) echo /usr/local/bin/claude ;;
    61) echo /Users/test/.claude/remote/ccd-cli/1.2.3 ;;
    62) echo /bin/sh ;;
  esac
}
ps() {
  if [ "$*" = '-ww -axo pid=,comm=' ]; then
    for pid in 10 20 21 30 40 50; do printf '%s %s\n' "$pid" "$(exe "$pid")"; done
    return
  fi
  local field='' pid=''
  while [ "$#" -gt 0 ]; do
    case "$1" in -o) field="$2"; shift ;; -p) pid="$2"; shift ;; esac
    shift
  done
  case "$field" in
    comm=) exe "$pid" ;;
    args=) printf '%s app-server\n' "$(exe "$pid")" ;;
    etime=) echo ' 01:02' ;;
  esac
}
lsof() { printf 'p123\nn/work/repo\n'; }
readlink() {
  case "$1" in
    */exe) local pid=${1#/proc/}; exe "${pid%/exe}" ;;
    */cwd) echo /work/repo ;;
  esac
}
'''
for agent, expected in [('codex', [10, 20, 21]), ('claude', [60, 61]), ('aider', [])]:
    result = subprocess.check_output(['bash'], input=escape + functions + fixture + f'\nsessions_of {agent}\n', text=True)
    rows = json.loads(result)
    assert [r['pid'] for r in rows] == expected, rows
    if agent == 'codex':
        assert [r['kind'] for r in rows] == ['process', 'app-server', 'app-server']
        assert all(r['cwd'] == '/work/repo' for r in rows)
print('PASS: CLI, both app bundles, spaces, pgrep omission, deduplication, helpers, IDE, remote Claude, empty list')

result = subprocess.check_output(['bash'], input=escape + functions + fixture + '\nOS=Linux\nsessions_of claude\n', text=True)
assert [r['pid'] for r in json.loads(result)] == [60, 61], result
print('PASS: Linux remote Claude executable paths')
