#!/usr/bin/env bash
# build-apk.sh — build luci-app-netsteer .apk (APKv3/ADB) from files/
# Usage: ./scripts/build-apk.sh [version] [arch]   (defaults: 1.12.4, aarch64_generic)
# Requires: curl, tar, python3 (for file permission fixups); downloads apk-tools-static on first run.
set -euo pipefail

VERSION="${1:-1.6.0}"
ARCH="${2:-aarch64_generic}"
# 防御: 版本串只允许安全字符 (会被插入 sed 表达式与包名; 斜杠等会导致 sed 分隔符提前终止)
case "$VERSION" in
  *[!0-9a-zA-Z._-]*)
    echo "ERROR: invalid version '$VERSION' — allowed chars: [0-9a-zA-Z._-]" >&2
    exit 1 ;;
esac
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
  "$HERE/scripts/fetch-apk-static.sh" "$APKTOOL"
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
chmod 755 "$PKGROOT"/usr/bin/netsteer-* "$PKGROOT"/etc/init.d/netsteer "$PKGROOT"/etc/hotplug.d/iface/99-netsteer 2>/dev/null
find "$PKGROOT" -name '*.js' -o -name '*.json' | xargs chmod 644

# 3. install/upgrade hooks — 不使用。探针包实测 (v1.22.2): OpenWrt apk 3.0.5 对 scripts hooks
#    完全不执行 (默认与显式 --commit-hooks --scripts 均不跑), 历史版本"安装侧修复"因此从未生效。
#    P0 数据保护与 P2 cron 挂载改为运行时自愈: netsteer-check 每分钟裁决 (见 netsteer-check)。

# 4. build — 必须以 root 身份 (UID/GID 0) 打包: 静态链接的 apk.static 不受 fakeroot (LD_PRELOAD) 影响,
#    非 root 直接打包会把构建机用户名写入包元数据, 在 OpenWrt 上安装后落成 nobody:nogroup (本地提权风险)。
#    使用 Linux user namespace (unshare -r) 在内核层将当前用户映射为 0:0。
OUT="$OUT_DIR/${NAME}-${VERSION}-${ARCH}.apk"
mkpkg_cmd() {
  "$MKPKG" mkpkg \
    -F "$PKGROOT" \
    -I "name:$NAME" -I "version:$VERSION" -I "arch:$ARCH" \
    -I "description:NetSteer - steer network softirq/IRQ load across CPU cores with auto benchmark" \
    -I "origin:$NAME" -I "maintainer:pm-parker" \
    -I "url:https://github.com/pm-parker/netsteer" -I "license:MIT" \
    -I "depends:luci-base" \
    -o "$OUT"
}
if [ "$(id -u)" -eq 0 ]; then
  chown -R 0:0 "$PKGROOT"
  mkpkg_cmd
elif command -v unshare >/dev/null 2>&1 && unshare -r true 2>/dev/null; then
  unshare -r "$MKPKG" mkpkg \
    -F "$PKGROOT" \
    -I "name:$NAME" -I "version:$VERSION" -I "arch:$ARCH" \
    -I "description:NetSteer - steer network softirq/IRQ load across CPU cores with auto benchmark" \
    -I "origin:$NAME" -I "maintainer:pm-parker" \
    -I "url:https://github.com/pm-parker/netsteer" -I "license:MIT" \
    -I "depends:luci-base" \
    -o "$OUT"
else
  echo "ERROR: non-root build requires 'unshare -r' so packaged files are owned by root:root" >&2
  exit 1
fi

echo ">> built $OUT ($(stat -c '%s' "$OUT") bytes)"
echo ">> verify content:"
mkdir -p "$WORK/check"
"$MKPKG" extract --allow-untrusted --destination "$WORK/check" "$OUT" >/dev/null
find "$WORK/check" -type f | sort | sed 's/^/   /'
# integrity check — a package that fails verify must never be shipped
"$MKPKG" verify --allow-untrusted "$OUT" >/dev/null || { echo "ERROR: apk verify failed"; exit 1; }
# ownership check — refuse to ship packages with non-root user/group metadata (prevents nobody:nogroup install)
BAD_OWN=$("$MKPKG" adbdump "$OUT" | grep -E '^[[:space:]]*(user|group):' | grep -vE '^[[:space:]]*(user|group): root$' || true)
if [ -n "$BAD_OWN" ]; then
  echo "ERROR: package contains non-root ownership metadata:" >&2
  echo "$BAD_OWN" | head -n 10 >&2
  exit 1
fi
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
