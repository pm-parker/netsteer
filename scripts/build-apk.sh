#!/usr/bin/env bash
# build-apk.sh — build luci-app-netsteer .apk (APKv3/ADB) from files/
# Usage: ./scripts/build-apk.sh [version] [arch]   (defaults: 1.12.4, aarch64_generic)
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
# 注入发布版本到页脚 (源内默认 'dev'; NS_VERSION 缺失则跳过 — 单测另有断言)
sed -i "s/var NS_VERSION = '[^']*';/var NS_VERSION = '$VERSION';/" \
  "$PKGROOT/www/luci-static/resources/view/netsteer.js"
grep -q "var NS_VERSION = '$VERSION';" "$PKGROOT/www/luci-static/resources/view/netsteer.js" \
  || { echo "FATAL: NS_VERSION inject failed" >&2; exit 1; }
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
# 版本注入是唯一的预期差异: 把包内 NS_VERSION 还原为 'dev' 后应与源文件逐字节相同
grep -q "var NS_VERSION = '$VERSION';" "$JS" \
  || { echo "ERROR: packaged js missing NS_VERSION=$VERSION (version inject failed)"; exit 1; }
[ "$(sed "s/var NS_VERSION = '$VERSION';/var NS_VERSION = 'dev';/" "$JS" | md5sum | cut -d' ' -f1)" = "$(md5sum < "$HERE/files/www/luci-static/resources/view/netsteer.js" | cut -d' ' -f1)" ] \
  || { echo "ERROR: packaged js differs from source (beyond version inject)"; exit 1; }
GD="$WORK/check/usr/share/netsteer/gamedomains.txt"
[ -s "$GD" ] || { echo "ERROR: package is missing gamedomains.txt (L1 DNS 分类数据集)"; exit 1; }
GI="$WORK/check/usr/share/netsteer/gameips.txt"
[ -s "$GI" ] || { echo "ERROR: package is missing gameips.txt (L2 IP 段数据集)"; exit 1; }
SD="$WORK/check/usr/share/netsteer/streamdomains.txt"
[ -s "$SD" ] || { echo "ERROR: package is missing streamdomains.txt (流媒体场景数据集)"; exit 1; }
DP="$WORK/check/usr/share/netsteer/downloadports.txt"
[ -s "$DP" ] || { echo "ERROR: package is missing downloadports.txt (下载场景端口数据集)"; exit 1; }
MF="$WORK/check/usr/share/netsteer/manifest.tsv"
[ -s "$MF" ] || { echo "ERROR: package is missing manifest.tsv (数据集清单, feed 基线)"; exit 1; }
GP="$WORK/check/usr/share/netsteer/gameports.txt"
[ -s "$GP" ] || { echo "ERROR: package is missing gameports.txt (L2 端口数据集)"; exit 1; }
echo ">> OK"
