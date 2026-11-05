#!/usr/bin/env bash
# build-apk.sh — build luci-app-netsteer .apk (APKv3/ADB) from files/
# Usage: ./scripts/build-apk.sh [version] [arch]   (defaults: 1.9.0, aarch64_generic)
# Requires: curl, tar, python3 (for file permission fixups); downloads apk-tools-static on first run.
set -euo pipefail

VERSION="${1:-1.6.0}"
ARCH="${2:-aarch64_generic}"
NAME="luci-app-netsteer"
HERE="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
OUT_DIR="$HERE/dist"
mkdir -p "$OUT_DIR"

# 1. apk-tools-static (contains mkpkg; the .apk itself is legacy tar.gz — just untar it)
APKTOOL="$WORK/apk-tools"
if [ ! -x "$APKTOOL/sbin/apk.static" ]; then
  mkdir -p "$APKTOOL"
  echo ">> fetching apk-tools-static..."
  URL=$(curl -s https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64/ \
    | grep -oE 'apk-tools-static-[^"<]*\.apk' | sort -u | tail -1)
  [ -n "$URL" ] || { echo "ERROR: cannot resolve apk-tools-static URL"; exit 1; }
  curl -s -o "$WORK/tools.apk" "https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64/$URL"
  tar xzf "$WORK/tools.apk" -C "$APKTOOL" sbin/apk.static 2>/dev/null
  chmod +x "$APKTOOL/sbin/apk.static"
fi
MKPKG="$APKTOOL/sbin/apk.static"

# 2. assemble package root from files/
PKGROOT="$WORK/PKGROOT"
cp -r "$HERE/files/." "$PKGROOT"
chmod 755 "$PKGROOT"/usr/bin/netsteer-* "$PKGROOT"/etc/init.d/netsteer 2>/dev/null
find "$PKGROOT" -name '*.js' -o -name '*.json' | xargs chmod 644

# 3. post-install script
cat > "$WORK/post-install" <<'EOF'
#!/bin/sh
/etc/init.d/netsteer enable
/etc/init.d/netsteer start 2>/dev/null || true
rm -f /tmp/luci-indexcache* 2>/dev/null
/etc/init.d/rpcd reload 2>/dev/null || /etc/init.d/rpcd restart 2>/dev/null || true
exit 0
EOF

# 4. build
OUT="$OUT_DIR/${NAME}-${VERSION}-${ARCH}.apk"
"$MKPKG" mkpkg \
  -F "$PKGROOT" \
  -I "name:$NAME" -I "version:$VERSION" -I "arch:$ARCH" \
  -I "description:NetSteer - steer network softirq/IRQ load across CPU cores with auto benchmark" \
  -I "origin:$NAME" -I "maintainer:pm-parker" \
  -I "url:https://github.com/pm-parker/netsteer" -I "license:MIT" \
  -I "depends:luci-base" \
  -s "post-install:$WORK/post-install" \
  -o "$OUT"

echo ">> built $OUT ($(stat -c '%s' "$OUT") bytes)"
echo ">> verify content:"
mkdir -p "$WORK/check"
"$MKPKG" extract --allow-untrusted --destination "$WORK/check" "$OUT" >/dev/null
find "$WORK/check" -type f | sort | sed 's/^/   /'
# integrity check — a package that fails verify must never be shipped
"$MKPKG" verify --allow-untrusted "$OUT" >/dev/null || { echo "ERROR: apk verify failed"; exit 1; }
# sanity: js must be present and non-empty
JS="$WORK/check/www/luci-static/resources/view/netsteer.js"
[ -s "$JS" ] || { echo "ERROR: package is missing netsteer.js — build is broken"; exit 1; }
[ "$(md5sum < "$JS" | cut -d' ' -f1)" = "$(md5sum < "$HERE/files/www/luci-static/resources/view/netsteer.js" | cut -d' ' -f1)" ] \
  || { echo "ERROR: packaged js differs from source"; exit 1; }
echo ">> OK"
