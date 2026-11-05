#!/usr/bin/env bash
# Sideload the widget onto a Samsung TV over the network.
#
#   scripts/install.sh --scan                 find TVs exposing the SDB port
#   scripts/install.sh --ip 192.168.1.50      install dist/JellyLean.wgt
#   scripts/install.sh --ip 192.168.1.50 --run
#
# Prerequisites on the TV: Settings > General > System Manager > Developer mode
# enabled and the host PC's IP entered, then reboot the TV.
# Prerequisites on this machine: Tizen Studio CLI (tizen, sdb) and a signed wgt.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# The CLI installer does not touch PATH, so look where it actually lands.
for dir in "$HOME/tizen-studio/tools" "$HOME/tizen-studio/tools/ide/bin"; do
    [ -d "$dir" ] && PATH="$dir:$PATH"
done
export PATH

PKG="$ROOT/dist/JellyLean.wgt"
IP=""
RUN=0
SCAN=0
APP_ID="jflean0001.JellyfinLean"
PACKAGE_ID="jflean0001"

usage() {
    sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
}

scan_network() {
    echo "Scanning the local /24 for TCP 26101 (SDB)..."
    python3 - <<'PY'
import concurrent.futures
import socket
import subprocess

try:
    route = subprocess.run(["ip", "-4", "route", "get", "1.1.1.1"],
                           capture_output=True, text=True, timeout=3).stdout
    prefix = route.split("src")[1].split()[0].rsplit(".", 1)[0]
except Exception:
    try:
        prefix = socket.gethostbyname(socket.gethostname()).rsplit(".", 1)[0]
    except Exception:
        prefix = "192.168.1"

def probe(host):
    sock = socket.socket()
    sock.settimeout(0.35)
    try:
        if sock.connect_ex((host, 26101)) == 0:
            return host
    finally:
        sock.close()
    return None

hosts = ["%s.%d" % (prefix, n) for n in range(1, 255)]
found = []
with concurrent.futures.ThreadPoolExecutor(max_workers=128) as pool:
    for result in pool.map(probe, hosts):
        if result:
            found.append(result)

if found:
    for host in found:
        print(host)
else:
    print("No TV found. Check that developer mode is on and this PC's IP is allowed on the TV.")
PY
}

while [ $# -gt 0 ]; do
    case "$1" in
        --ip) IP="${2:-}"; shift 2 ;;
        --package) PKG="${2:-}"; shift 2 ;;
        --run) RUN=1; shift ;;
        --scan) SCAN=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) echo "unknown argument: $1" >&2; usage; exit 2 ;;
    esac
done

if [ "$SCAN" = "1" ]; then
    scan_network
    exit 0
fi

if ! command -v sdb >/dev/null 2>&1 || ! command -v tizen >/dev/null 2>&1; then
    cat >&2 <<'MSG'
error: the Tizen CLI (sdb + tizen) was not found.

Install it headlessly with:
  curl -O https://download.tizen.org/sdk/Installer/tizen-studio_6.1/web-cli_Tizen_Studio_6.1_ubuntu-64.bin
  chmod +x web-cli_Tizen_Studio_6.1_ubuntu-64.bin
  ./web-cli_Tizen_Studio_6.1_ubuntu-64.bin --accept-license --no-java-check "$HOME/tizen-studio"

Meanwhile, test the app in a browser with:
  node scripts/dev-server.js
MSG
    exit 1
fi

if [ -z "$IP" ]; then
    echo "error: --ip is required (use --scan to find the TV)" >&2
    exit 2
fi

if [ ! -f "$PKG" ]; then
    echo "error: package not found: $PKG" >&2
    echo "Build it first: scripts/build.sh" >&2
    exit 1
fi

echo "==> connecting to $IP:26101"
sdb start-server >/dev/null 2>&1 || true
sdb connect "$IP:26101" >/dev/null || true

TARGET="$(sdb devices | awk -v ip="$IP" '$2 == "device" && index($1, ip) == 1 { print $1; exit }')"
if [ -z "$TARGET" ]; then
    TARGET="$(sdb devices | awk '$2 == "device" { print $1; exit }')"
fi

if [ -z "$TARGET" ]; then
    echo "error: no device connected. sdb devices says:" >&2
    sdb devices >&2 || true
    echo "" >&2
    echo "Check TV developer mode, the allowed host IP, and that the TV is on the same network." >&2
    exit 1
fi

echo "==> target: $TARGET"

# Not every CLI version has install-permit; the prompt only appears on some TVs.
echo "==> requesting install permission (accept on the TV if prompted)"
tizen install-permit -s "$TARGET" >/dev/null 2>&1 \
    || tizen install-permit -t "$TARGET" >/dev/null 2>&1 || true

echo "==> installing $(basename "$PKG")"
# The CLI wants the serial from `sdb devices` (-s), not the -t target name.
if ! tizen install -n "$PKG" -s "$TARGET"; then
    echo "==> tizen install failed, falling back to sdb install"
    sdb -s "$TARGET" install "$PKG" || true
fi

if ! sdb -s "$TARGET" shell 0 vd_applist 2>/dev/null | grep -q "$APP_ID"; then
    cat >&2 <<'MSG'

Install failed. The usual causes, in order:

  1. "Invalid certificate chain" / "Check certificate error" — the widget is
     unsigned or the profile does not match this TV. Check with:
       unzip -l dist/JellyLean.wgt | grep signature
     Rebuild signed:
       scripts/build.sh
  2. Developer mode is off, or this PC's IP (see: hostname -I) is not the one
     entered under Apps > 12345 > Developer mode. Change it there and reboot
     the TV (hold power ~5s).
  3. The TV has no free app slots — uninstall something.

A distributor certificate that expired in 2022 is accepted by most TVs in
developer mode; if this TV rejects it, sign with a Samsung-issued certificate
from Tizen Studio's Certificate Manager and rebuild.
MSG
    exit 1
fi

if [ "$RUN" = "1" ]; then
    echo "==> launching $APP_ID"
    # -p takes the application id and -s the serial; the CLI prints a spurious
    # "Could not launch the null application" after a successful launch.
    tizen run -p "$APP_ID" -s "$TARGET" 2>/dev/null \
        || sdb -s "$TARGET" shell 0 was_execute "$APP_ID" \
        || echo "Installed, but the launch command was refused. Open JellyLean from the TV's app list."
fi

echo ""
echo "Done. If the app is not in the TV's app list, reboot the TV once."
