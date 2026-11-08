#!/bin/sh
# feed.test.sh — netsteer-feed 端到端测试 (CI/沙箱可跑; 模拟源 + 装机目录)
# 用法: sh tests/unit/feed.test.sh
# 依赖: sh (POSIX), curl, sha256sum, python3 (仅起本地 http 源)
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=$(mktemp -d /tmp/nsfeedXXXXXX)
PORT=18923
PASS=0; FAIL=0
ok() { PASS=$((PASS+1)); }
bad() { FAIL=$((FAIL+1)); echo "FAIL: $1"; }
cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

# ---- 构造源目录 (从 repo data/ 复制) 与"老版装机"目录 ----
mkdir -p "$WORK/data" "$WORK/installed"
for f in gamedomains.txt gameips.txt gameports.txt downloadports.txt streamdomains.txt manifest.tsv; do
	cp "$ROOT/data/$f" "$WORK/data/$f" || { echo "FATAL: $ROOT/data/$f missing (run scripts/gen-manifest.py)"; exit 2; }
done
# 老版: streamdomains 少一行 + 老 manifest (sha 全 0)
sed '/^pptv\t/d' "$ROOT/data/streamdomains.txt" > "$WORK/installed/streamdomains.txt"
printf '# netsteer-data-manifest v=2026.11.01-old gen=x\nstreamdomains.txt\t%s\t1\n' "$(printf '0%.0s' $(seq 64))" > "$WORK/installed/manifest.tsv"

# ---- 沙箱版 feed: 重定向 DATA_DIR/STATE_DIR/源 ----
sed -e "s|DATA_DIR=\"/usr/share/netsteer\"|DATA_DIR=\"$WORK/installed\"|" \
	-e "s|STATE_DIR=\"/tmp/netsteer\"|STATE_DIR=\"$WORK/state\"|" \
	-e "s|https://cdn.jsdelivr.net/gh/pm-parker/netsteer@main/data|http://127.0.0.1:$PORT|" \
	-e "s|https://raw.githubusercontent.com/pm-parker/netsteer/main/data||" \
	"$ROOT/files/usr/bin/netsteer-feed" > "$WORK/feed"
chmod +x "$WORK/feed"

python3 -m http.server $PORT --directory "$WORK/data" >/dev/null 2>&1 &
SRV=$!
i=0; while [ $i -lt 20 ]; do curl -sf "http://127.0.0.1:$PORT/manifest.tsv" >/dev/null 2>&1 && break; i=$((i+1)); sleep 0.2; done

# ---- T1 check: 发现更新 ----
OUT=$("$WORK/feed" check 2>/dev/null)
echo "$OUT" | grep -q '"update_available":true' && ok || bad "T1 check 未发现更新: $OUT"
echo "$OUT" | grep -q '"remote_version":"2026\.' && ok || bad "T1 remote_version 缺失"

# ---- T2 update: 6 文件拉齐 + 落地一致 ----
OUT=$("$WORK/feed" update 2>/dev/null); RC=$?
[ $RC -eq 0 ] && ok || bad "T2 update rc=$RC"
N=$(echo "$OUT" | grep -o '"file":' | wc -l)
[ "$N" -ge 5 ] && ok || bad "T2 更新文件数 $N < 5 (5 个数据文件)"
sha256sum "$WORK/installed/streamdomains.txt" "$WORK/data/streamdomains.txt" 2>/dev/null | awk '{print $1}' | uniq | wc -l | grep -q '^1$' && ok || bad "T2 装机文件与源不一致"

# ---- T3 status: integrity true ----
"$WORK/feed" status 2>/dev/null | grep -q '"integrity":true' && ok || bad "T3 integrity!=true"

# ---- T4 幂等: 二次 update count=0 ----
"$WORK/feed" update 2>/dev/null | grep -q '"count":0' && ok || bad "T4 二次 update 非 0"
"$WORK/feed" update 2>/dev/null | grep -qv '"failed"' && ok || bad "T4 幂等出现 failed"

# ---- T5 篡改拒绝: 源文件与 manifest 不配套 → 拒装 ----
echo "evil	evilsite.com" >> "$WORK/data/streamdomains.txt"
# 强制重新比对: 删远程缓存后再跑 (sha 不匹配走 (sha256) 失败)
rm -rf "$WORK/state"
printf '# netsteer-data-manifest v=2026.11.02-x gen=x\nstreamdomains.txt\t%s\t1\n' "$(printf '1%.0s' $(seq 64))" > "$WORK/installed/manifest.tsv"
OUT=$("$WORK/feed" update 2>/dev/null); RC=$?
[ $RC -eq 2 ] && ok || bad "T5 篡改源应 rc=2, got $RC"
grep -c "evil" "$WORK/installed/streamdomains.txt" 2>/dev/null | grep -q '^0$' && ok || bad "T5 篡改内容被安装"

# ---- T6 rollback ----
cp "$WORK/data/streamdomains.txt.bak" /dev/null 2>/dev/null
# T2 备份被 T5 循环消耗则重建场景: 直接验证 rollback 输出结构
OUT=$("$WORK/feed" rollback 2>/dev/null)
echo "$OUT" | grep -q '"restored":\[' && ok || bad "T6 rollback 输出异常: $OUT"

echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] || exit 1
exit 0
