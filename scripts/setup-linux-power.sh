#!/usr/bin/env bash
# Run as the desktop/fleet user. Installs only suspend authorization and optional Ethernet WoL.
set -Eeuo pipefail
if [[ ${1:-} == --help ]]; then
  echo 'Usage: bash setup-linux-power.sh [Ethernet-interface]'
  echo 'No interface: configure remote suspend only (manual wake). Does not suspend or reboot.'
  exit 0
fi
[[ $# -le 1 && $(uname -s) == Linux && $EUID -ne 0 ]] || { echo 'Run as a normal Linux user, with at most one interface.' >&2; exit 2; }
! grep -qi microsoft /proc/sys/kernel/osrelease || { echo 'Native Linux only.' >&2; exit 2; }
fleet_user=$(id -un)
[[ $fleet_user =~ ^[a-zA-Z_][a-zA-Z0-9_-]*$ ]] || exit 2
iface=${1:-}
if [[ -n $iface ]]; then
  [[ $iface =~ ^[a-zA-Z0-9_.:-]+$ && -d /sys/class/net/$iface && ! -d /sys/class/net/$iface/wireless ]] || { echo 'Expected an Ethernet interface.' >&2; exit 2; }
  command -v ethtool >/dev/null || { echo 'Install ethtool with your distribution package manager first.' >&2; exit 1; }
  command -v nmcli >/dev/null || { echo 'NetworkManager is required for persistent WoL.' >&2; exit 1; }
fi
printf 'Grant %s remote suspend (including when the desktop is logged in).\n' "$fleet_user"
printf 'Blocking sleep inhibitors stay effective. No general sudo access is added.\n'
if [[ -n $iface ]]; then printf 'Also enable persistent magic-packet wake on %s.\n' "$iface"; fi
read -r -p 'Proceed? [y/N] ' reply
[[ $reply == [yY] || $reply == [yY][eE][sS] ]] || exit 0
sudo -v
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
if [[ -n $iface ]]; then
  profile=$(nmcli -g GENERAL.CON-UUID device show "$iface")
  [[ -n $profile && $profile != -- ]] || { echo 'Connect Ethernet first so its active profile can be identified.' >&2; exit 1; }
  # shellcheck disable=SC2024 # The report belongs in our user-owned temporary directory.
  sudo ethtool "$iface" > "$scratch/ethtool"
  cat "$scratch/ethtool"
  grep -Eq 'Supports Wake-on:.*g' "$scratch/ethtool" || { echo 'NIC does not advertise magic-packet wake.' >&2; exit 1; }
  printf 'Previous profile wake setting: '
  nmcli -g 802-3-ethernet.wake-on-lan connection show "$profile"
fi
cat > "$scratch/50-flotilla-suspend.rules" <<RULE
// Flotilla: this account may suspend through logind, but may not ignore inhibitors.
polkit.addRule(function(action, subject) {
    if (subject.user == "$fleet_user" &&
        (action.id == "org.freedesktop.login1.suspend" ||
         action.id == "org.freedesktop.login1.suspend-multiple-sessions")) {
        return polkit.Result.YES;
    }
});
RULE
rule=/etc/polkit-1/rules.d/50-flotilla-suspend.rules
if sudo test -L "$rule"; then echo "Refusing symlink $rule" >&2; exit 1; fi
if sudo test -e "$rule" && ! sudo cmp -s "$scratch/50-flotilla-suspend.rules" "$rule"; then
  sudo cp -p "$rule" "$rule.backup.$(date +%s)"
fi
sudo install -m 0644 -o root -g root "$scratch/50-flotilla-suspend.rules" "$rule"
if [[ -n $iface ]]; then
  sudo nmcli connection modify "$profile" 802-3-ethernet.wake-on-lan magic
  # Apply immediately without bouncing the connection carrying this session.
  sudo ethtool -s "$iface" wol g
  sudo ethtool "$iface" | grep -E 'Supports Wake-on|Wake-on|Link detected'
fi
printf '\nSetup complete; no suspend was requested.\n'
printf 'Power policy may take a moment to reload. From SSH, CanSuspend should now say yes:\n'
busctl call org.freedesktop.login1 /org/freedesktop/login1 org.freedesktop.login1.Manager CanSuspend
