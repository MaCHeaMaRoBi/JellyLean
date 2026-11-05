#!/bin/sh
# File-backed stand-in for Tizen Studio's certificate password store.
#
# Tizen CLI 6.x keeps signing passwords in the D-Bus Secret Service via
# tools/certificate-encryptor/secret-tool, a Go wrapper over org.freedesktop.secrets.
# On a machine without a keyring daemon (headless, minimal KDE, WSL, containers)
# `tizen package` dies with "CertificationException: Invaild password", because the
# lookup cannot even reach a provider.
#
# scripts/setup-signing.sh installs this file as that secret-tool. It keeps the
# same lookup/store/clear contract and persists to $TIZEN_PASSWD_DIR (default
# ~/.tizen-certs/passwords) with 0600 permissions.

DIR="${TIZEN_PASSWD_DIR:-$HOME/.tizen-certs/passwords}"
mkdir -p "$DIR" || exit 1
chmod 700 "$DIR" 2>/dev/null || true

cmd="$1"; shift || exit 2

label=""; key=""; password=""; attrs=""; prev=""
for arg in "$@"; do
    case "$arg" in
        --label=*) label="${arg#--label=}" ;;
        -l) prev="label" ;;
        --password=*) password="${arg#--password=}" ;;
        -p) prev="password" ;;
        -*) ;;
        *)
            if [ "$prev" = "label" ]; then label="$arg"; prev=""
            elif [ "$prev" = "password" ]; then password="$arg"; prev=""
            else attrs="$attrs $arg"
            fi
            ;;
    esac
done

# Tizen passes "keyfile <path> tool certificate-manager"; key on the file path.
# shellcheck disable=SC2086
set -- $attrs
if [ $# -ge 2 ]; then key="$2"; fi
[ -z "$key" ] && key="$label"
safe=$(printf '%s' "$key" | tr -c 'A-Za-z0-9._-' '_')

case "$cmd" in
    store)
        [ -z "$password" ] && password=$(cat)
        printf '%s' "$password" > "$DIR/$safe" || exit 1
        chmod 600 "$DIR/$safe" 2>/dev/null || true
        ;;
    lookup)
        [ -f "$DIR/$safe" ] || exit 1
        cat "$DIR/$safe"
        ;;
    clear) rm -f "$DIR/$safe" ;;
    *) echo "tizen-secret-shim: unsupported command '$cmd'" >&2; exit 2 ;;
esac
