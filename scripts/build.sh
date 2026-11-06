#!/usr/bin/env bash
# Build a .wgt for the TV.
#
#   scripts/build.sh                       signed widget in dist/ (uses the active profile)
#   scripts/build.sh --unsigned            plain zip, for inspection/dev only
#   TIZEN_PROFILE=MyCert scripts/build.sh  pick a specific signing profile
#
# A signed widget needs an author certificate plus a distributor certificate.
# Tizen Studio stores those in a security profile; this script finds the CLI and
# the active profile automatically, so no PATH or cli-config setup is required.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST="$ROOT/dist"
NAME="JellyLean"
WGT="$DIST/$NAME.wgt"
SIGNED=1

for arg in "$@"; do
    case "$arg" in
        --unsigned) SIGNED=0 ;;
        -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
        *) echo "unknown argument: $arg" >&2; exit 2 ;;
    esac
done

if [ ! -f "$ROOT/config.xml" ] || [ ! -f "$ROOT/index.html" ]; then
    echo "error: run this from a complete checkout (config.xml or index.html missing)" >&2
    exit 1
fi

# The version in config.xml and js/api.js must match.
CFG_VER="$(tr '\n' ' ' < "$ROOT/config.xml" | sed -n 's/.*<widget[^>]* version="\([0-9.]*\)".*/\1/p')"
API_VER="$(sed -n "s/.*CLIENT_VERSION = '\([0-9.]*\)'.*/\1/p" "$ROOT/js/api.js" | head -1)"
if [ -z "$CFG_VER" ] || [ "$CFG_VER" != "$API_VER" ]; then
    echo "error: version mismatch: config.xml=$CFG_VER, js/api.js=$API_VER" >&2
    exit 1
fi

# ---------------------------------------------------------------- toolchain
TIZEN=""
for candidate in "$(command -v tizen 2>/dev/null || true)" \
                 "$HOME/tizen-studio/tools/ide/bin/tizen" \
                 "$HOME/tizen-studio-5.5/tools/ide/bin/tizen"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then TIZEN="$candidate"; break; fi
done

if [ -n "$TIZEN" ]; then
    export PATH="$(dirname "$TIZEN"):$PATH"
    export TIZEN_SDK="${TIZEN_SDK:-$(cd "$(dirname "$TIZEN")/../../.." && pwd)}"
fi

# ------------------------------------------------------- security profile
PROFILE="${TIZEN_PROFILE:-}"
PROFILES_XML=""

if [ "$SIGNED" = "1" ] && [ -n "$TIZEN" ]; then
    PROFILES_XML="$(tizen cli-config -l 2>/dev/null | awk -F= '/^profiles.path=/{print $2}' || true)"
    if [ -z "$PROFILES_XML" ] || [ ! -f "$PROFILES_XML" ]; then
        PROFILES_XML="$TIZEN_SDK-data/profile/profiles.xml"
        [ -f "$PROFILES_XML" ] || PROFILES_XML="$HOME/tizen-studio-data/profile/profiles.xml"
    fi
    if [ -f "$PROFILES_XML" ]; then
        tizen cli-config "profiles.path=$PROFILES_XML" >/dev/null 2>&1 || true
        if [ -z "$PROFILE" ]; then
            PROFILE="$(sed -n 's/.*<profiles[^>]*active="\([^"]*\)".*/\1/p' "$PROFILES_XML" | head -1)"
        fi
    fi
fi

mkdir -p "$DIST"
rm -f "$WGT" "$DIST/$NAME.zip"
rm -rf "$ROOT/.build"

# One staging tree for both paths: whatever is staged is exactly what ships.
STAGE="$ROOT/.build/stage"
mkdir -p "$STAGE"
for item in config.xml index.html icon.png banner.jpg css js fonts; do
    [ -e "$ROOT/$item" ] && cp -r "$ROOT/$item" "$STAGE"/
done

echo "==> staged $(find "$STAGE" -type f | wc -l) files"

if [ "$SIGNED" = "1" ] && [ -n "$TIZEN" ] && [ -n "$PROFILE" ]; then
    echo "==> tizen package (profile: $PROFILE)"
    (
        cd "$STAGE"
        tizen package -t wgt -s "$PROFILE" -- .
    )
    FOUND="$(find "$STAGE" -maxdepth 1 -name '*.wgt' -print 2>/dev/null | head -1)"
    if [ -z "$FOUND" ]; then
        FOUND="$(find "$ROOT" -maxdepth 1 -name '*.wgt' -print 2>/dev/null | head -1)"
    fi
    if [ -z "$FOUND" ]; then
        echo "error: tizen package did not produce a .wgt" >&2
        exit 1
    fi
    if [ "$FOUND" != "$WGT" ]; then
        mv "$FOUND" "$WGT"
    fi
else
    if [ "$SIGNED" = "1" ]; then
        echo "==> no signing profile found: building an unsigned widget"
        echo "    (fine for the dev server, rejected by a real TV)"
    else
        echo "==> building an unsigned widget as requested"
    fi
    (
        cd "$STAGE"
        zip -qr "$WGT" .
    )
    cp "$WGT" "$DIST/$NAME.zip"
fi

rm -rf "$ROOT/.build"

if [ ! -s "$WGT" ]; then
    echo "error: $WGT was not created" >&2
    exit 1
fi

# What Apps2Samsung reads before it will install a package: the <tizen:application>
# ids, required_version (newer than the TV = refused) and the manifest version.
# Fail the build here, so a package the catalog cannot install is never released.
CONFIG="$(unzip -p "$WGT" config.xml 2>/dev/null | tr '\n' ' ')"
need() {
    if ! printf '%s' "$CONFIG" | grep -Eq "$1"; then
        echo "error: config.xml: $2" >&2
        exit 1
    fi
}
need '<tizen:application[^>]*id="[A-Za-z0-9_]+\.[A-Za-z0-9_]+"' "no valid tizen:application id"
need '<tizen:application[^>]*package="[A-Za-z0-9_]+"' "no valid package id (Apps2Samsung needs it to upgrade in place)"
need '<tizen:application[^>]*required_version="[0-9]+\.[0-9]+"' "no required_version (Tizen refuses an install without it)"
need '<widget[^>]*version="[0-9]+\.[0-9]+\.[0-9]+"' "no widget version"

echo ""
echo "Built: $WGT ($(du -h "$WGT" | cut -f1))"
if unzip -l "$WGT" 2>/dev/null | grep -q 'signature1.xml'; then
    echo "Signed: author + distributor signatures present. Ready for scripts/install.sh."
else
    echo "Unsigned: fine for the dev server and browser testing, not for TV install."
fi
