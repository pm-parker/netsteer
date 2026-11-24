#!/usr/bin/env bash
# fetch-apk-static.sh — resolve the current Alpine edge apk-tools-static and extract sbin/apk.static.
# Usage: fetch-apk-static.sh DEST_DIR [BASE_URL]
# Used by scripts/build-apk.sh and by CI package verification (pull request build and tag release).
# HTTP errors fail the script. The body is checked for gzip before tar, so an HTML error page is never extracted.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: fetch-apk-static.sh DEST_DIR [BASE_URL]" >&2
  exit 2
fi

DEST=$1
BASE=${2:-https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64}
BASE=${BASE%/}

INDEX=$(mktemp)
APK=$(mktemp)
trap 'rm -f "$INDEX" "$APK"' EXIT

if ! curl -fsSL --retry 0 --connect-timeout 20 --max-time 120 -o "$INDEX" "$BASE/"; then
  echo "ERROR: apk-tools index fetch failed: $BASE/" >&2
  exit 1
fi

# Directory listing is HTML. Pick the newest apk-tools-static-*.apk (version sort: 3.0.11 > 3.0.9).
NAME=$(grep -oE 'apk-tools-static-[0-9][^"<[:space:]]*\.apk' "$INDEX" | sort -V -u | tail -n 1 || true)
if [ -z "${NAME}" ]; then
  echo "ERROR: cannot resolve apk-tools-static name from $BASE/" >&2
  exit 1
fi
case "$NAME" in
  *[!a-zA-Z0-9._-]*)
    echo "ERROR: refused apk-tools-static name: $NAME" >&2
    exit 1 ;;
  apk-tools-static-[0-9]*.apk) ;;
  *)
    echo "ERROR: refused apk-tools-static name: $NAME" >&2
    exit 1 ;;
esac

if ! curl -fsSL --retry 0 --connect-timeout 20 --max-time 120 -o "$APK" "$BASE/$NAME"; then
  echo "ERROR: apk-tools-static download failed: $BASE/$NAME" >&2
  exit 1
fi

SIG=$(od -An -N2 -tx1 "$APK" | tr -d '[:space:]')
if [ "$SIG" != "1f8b" ] || ! gzip -t "$APK"; then
  echo "ERROR: downloaded apk-tools-static is not a gzip package" >&2
  exit 1
fi

mkdir -p "$DEST"
tar xzf "$APK" -C "$DEST" sbin/apk.static
chmod +x "$DEST/sbin/apk.static"
if [ ! -x "$DEST/sbin/apk.static" ]; then
  echo "ERROR: sbin/apk.static missing after extract" >&2
  exit 1
fi
echo ">> fetched $NAME" >&2
