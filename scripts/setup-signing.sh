#!/usr/bin/env bash
# Create a Tizen signing profile this app can build with, headlessly.
#
#   scripts/setup-signing.sh
#   CERT_DIR=~/my-certs PROFILE=MyTV scripts/setup-signing.sh
#
# Expects two PKCS#12 files in CERT_DIR (default ~/.tizen-certs):
#   author.p12        author certificate + key
#   distributor.p12   distributor certificate + key
# and optionally CERT_DIR/ca/*.crt for the CA chain.
#
# Why a shim: Tizen CLI 6.x reads certificate passwords from the D-Bus Secret
# Service. Without a keyring daemon every build fails with
# "CertificationException: Invaild password". This script installs
# scripts/tizen-secret-shim.sh in place of the SDK's secret-tool, so passwords
# live in 0600 files instead.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CERT_DIR="${CERT_DIR:-$HOME/.tizen-certs}"
PROFILE="${PROFILE:-JellyfinLean}"
PW="${CERT_PASSWORD:-tizenpkcs12passfordsigner}"
AUTHOR="$CERT_DIR/author.p12"
DIST="$CERT_DIR/distributor.p12"

fail() { echo "error: $*" >&2; exit 1; }

TIZEN=""
for candidate in "$(command -v tizen 2>/dev/null || true)" \
                 "$HOME/tizen-studio/tools/ide/bin/tizen"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then TIZEN="$candidate"; break; fi
done
[ -n "$TIZEN" ] || fail "Tizen CLI not found (see README, 'Build machine')"
export PATH="$(dirname "$TIZEN"):$PATH"
SDK="${TIZEN_SDK:-$(cd "$(dirname "$TIZEN")/../../.." && pwd)}"

[ -f "$AUTHOR" ] || fail "missing $AUTHOR"
[ -f "$DIST" ]   || fail "missing $DIST"

# ---------------------------------------------------------- password backend
SHIM_DIR="$SDK/tools/certificate-encryptor"
if [ -d "$SHIM_DIR" ]; then
    if [ ! -f "$SHIM_DIR/secret-tool.real" ]; then
        cp -a "$SHIM_DIR/secret-tool" "$SHIM_DIR/secret-tool.real"
    fi
    install -m 755 "$ROOT/scripts/tizen-secret-shim.sh" "$SHIM_DIR/secret-tool"
    echo "==> installed file-backed password shim in $SHIM_DIR"
else
    echo "==> no certificate-encryptor in this SDK; leaving it alone"
fi

# ------------------------------------------------------------------- profile
PROFILES_XML="$HOME/tizen-studio-data/profile/profiles.xml"
mkdir -p "$(dirname "$PROFILES_XML")"

tizen security-profiles remove -n "$PROFILE" >/dev/null 2>&1 || true
tizen security-profiles add -n "$PROFILE" \
    -a "$AUTHOR" -p "$PW" \
    -d "$DIST" -dp "$PW" -f >/dev/null
tizen cli-config "profiles.path=$PROFILES_XML" >/dev/null

[ -f "$PROFILES_XML" ] || fail "profile was not written"
echo "==> profile '$PROFILE' is active ($PROFILES_XML)"
echo ""
echo "Build with: scripts/build.sh"
