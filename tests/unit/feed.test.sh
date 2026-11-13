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
for f in gamedomains.txt gameips.txt gameports.txt downloadports.txt streamdomains.txt confdomains.txt downloadtrackers.txt manifest.tsv; do
	cp "$ROOT/data/$f" "$WORK/data/$f" || { echo "FATAL: $ROOT/data/$f missing (run scripts/gen-manifest.py)"; exit 2; }
done
# 老版: streamdomains 少一行 + 老 manifest (sha 全 0)
sed '/^pptv\t/d' "$ROOT/data/streamdomains.txt" > "$WORK/installed/streamdomains.txt"
printf '# netsteer-data-manifest v=2026.11.01-old gen=x\nstreamdomains.txt\t%s\t1\n' "$(printf '0%.0s' $(seq 64))" > "$WORK/installed/manifest.tsv"

# ---- 沙箱版 feed: 重定向 DATA_DIR/STATE_DIR/源 ----
sed -e "s|DATA_DIR=\"/usr/share/netsteer\"|DATA_DIR=\"$WORK/installed\"|" \
	-e "s|STATE_DIR=\"/tmp/netsteer\"|STATE_DIR=\"$WORK/state\"|" \
	-e "s|FEED_HIST=\"/etc/netsteer/feed-history\"|FEED_HIST=\"$WORK/fhist\"|" \
	-e "s|PHIST=\"/etc/netsteer/history.log\"|PHIST=\"$WORK/phist.log\"|" \
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

# ---- T7 validate: 合法数据过 / 坏域名拒 / 坏 proto 拒 (v1.22.2) ----
# 文件名必须用真实数据名 — validate_data 按 basename 分发格式规则, 任意名一律"无有效数据行"
# 函数体抽取独立加载 (整脚本 source 会执行 case/status 并覆盖 WORK — 避开)
mkdir -p "$WORK/vtest/bad" "$WORK/vtest/good"
printf 'gaming\tBAD DOMAIN!!\n' > "$WORK/vtest/bad/gamedomains.txt"
printf 'steam\t27015/abca\n' > "$WORK/vtest/bad/gameports.txt"
printf 'steam\t4662/tcp\n' > "$WORK/vtest/good/gameports.txt"
sed -n '/^validate_data()/,/^}/p' "$WORK/feed" > "$WORK/vfn.sh"
T7_1=$( ( . "$WORK/vfn.sh"; validate_data "$WORK/data/gamedomains.txt" >/dev/null 2>&1 && echo L || echo x ) )
T7_2=$( ( . "$WORK/vfn.sh"; validate_data "$WORK/vtest/bad/gamedomains.txt" >/dev/null 2>&1 && echo x || echo L ) )
T7_3=$( ( . "$WORK/vfn.sh"; validate_data "$WORK/vtest/bad/gameports.txt" >/dev/null 2>&1 && echo x || echo L ) )
T7_4=$( ( . "$WORK/vfn.sh"; validate_data "$WORK/vtest/good/gameports.txt" >/dev/null 2>&1 && echo L || echo x ) )
T7OUT="$T7_1$T7_2$T7_3$T7_4"
case "$T7OUT" in
	LLLL) ok ;;
	*) bad "T7 validate 组合异常 ($T7OUT): L=合法过/拒" ;;
esac

# ---- T7b gameips 分类名含 't': 方括号内 \t 是字面 \ 与 t, 不是制表符 —
# 原写法把 "steam<TAB>CIDR" 切成 "eam<TAB>CIDR", 真实 gameips.txt 全行判非法 ----
mkdir -p "$WORK/vtest/ips"
printf 'steam\t1.2.3.0/24\nvalorant\t5.6.7.0/24\n' > "$WORK/vtest/ips/gameips.txt"
( . "$WORK/vfn.sh"; validate_data "$WORK/vtest/ips/gameips.txt" >/dev/null 2>&1 ) \
	&& ok || bad "T7b 含 t 分类名的 gameips 被误判非法"
( . "$WORK/vfn.sh"; validate_data "$ROOT/data/gameips.txt" >/dev/null 2>&1 ) \
	&& ok || bad "T7b 仓库真实 gameips.txt 校验未通过"
printf 'steam\tnot-an-ip\n' > "$WORK/vtest/ips/bad.txt"
mv "$WORK/vtest/ips/bad.txt" "$WORK/vtest/ips/gameips.txt"
( . "$WORK/vfn.sh"; validate_data "$WORK/vtest/ips/gameips.txt" >/dev/null 2>&1 ) \
	&& bad "T7b 非法 CIDR 未被拒" || ok

# ---- T8 冒烟失败自动回滚 (v1.22.2): 坏引擎 → update rc=3 + 数据保持原状 ----
# T5 篡改过源 streamdomains+manifest — 先恢复源一致性, 否则 update 在 sha 层就 rc=2
cp "$ROOT/data/streamdomains.txt" "$WORK/data/streamdomains.txt"
rm -rf "$WORK/data/manifest.tsv"
cp "$ROOT/data/manifest.tsv" "$WORK/data/manifest.tsv"
cp "$WORK/data/gamedomains.txt" "$WORK/installed/gamedomains.txt"
printf 'BEGIN { broken' > "$WORK/installed/sense.awk"
rm -rf "$WORK/state/feed"
OUT=$("$WORK/feed" update 2>/dev/null); RC=$?
[ $RC -eq 3 ] && ok || bad "T8 冒烟失败应 rc=3, got $RC"
echo "$OUT" | grep -q '"rolled_back"' && ok || bad "T8 无 rolled_back 字段: $OUT"
cmp -s "$WORK/data/gamedomains.txt" "$WORK/installed/gamedomains.txt" && ok || bad "T8 回滚内容与源不符"

# ---- T9 feed-history 版本化 (v1.22.2): update 产生快照, rollback 恢复到更新前 ----
rm -rf "$WORK/installed/sense.awk"
ls -1 "$WORK/fhist" 2>/dev/null | grep -q '.' && ok || bad "T9 update 未产生 feed-history 快照"
printf 'vtest	vtest9.invalid\n' >> "$WORK/data/gamedomains.txt"
N=$(sha256sum "$WORK/data/gamedomains.txt" | cut -d' ' -f1); S=$(wc -c < "$WORK/data/gamedomains.txt")
OLD_N=$(grep '^gamedomains.txt' "$WORK/data/manifest.tsv" | cut -f2)
sed -i "s|$OLD_N|$N	$S|" "$WORK/data/manifest.tsv"
rm -rf "$WORK/state/feed"
"$WORK/feed" update >/dev/null 2>&1
grep -q 'vtest9.invalid' "$WORK/installed/gamedomains.txt" && ok || bad "T9 二次更新未落地"
"$WORK/feed" rollback >/dev/null 2>&1
grep -q 'vtest9.invalid' "$WORK/installed/gamedomains.txt"; [ $? -ne 0 ] && ok || bad "T9 rollback 后测试行仍在"

# ---- T19/T20 降级保护: 源版本旧于装机 → check 不算更新, update 拒绝且数据不动 ----
# 前置: T9 rollback 已把 installed 恢复到构造旧版 — 先升到 repo 当前版 (新于 2026.11.01)
"$WORK/feed" update >/dev/null 2>&1
SRC_VER=$(grep '^# ' "$WORK/data/manifest.tsv" | head -1)
sed -i "1s|.*|# netsteer-data-manifest v=2026.11.01-old gen=x|" "$WORK/data/manifest.tsv"
OUT=$("$WORK/feed" check 2>/dev/null)
echo "$OUT" | grep -q '"update_available":false' && ok || bad "T19 旧远端仍报有更新: $OUT"
echo "$OUT" | grep -q '"remote_older":true' && ok || bad "T19 缺 remote_older:true: $OUT"
GD_BEFORE=$(sha256sum "$WORK/installed/gamedomains.txt" | cut -d' ' -f1)
OUT2=$("$WORK/feed" update 2>/dev/null)
echo "$OUT2" | grep -q 'skipped_remote_older' && ok || bad "T20 update 未拒绝降级: $OUT2"
GD_AFTER=$(sha256sum "$WORK/installed/gamedomains.txt" | cut -d' ' -f1)
[ "$GD_BEFORE" = "$GD_AFTER" ] && ok || bad "T20 降级拦截但数据被动了"
# 恢复源版本 (供后续潜在用例)
sed -i "1s|.*|$SRC_VER|" "$WORK/data/manifest.tsv"

echo "PASS=$PASS FAIL=$FAIL"
[ $FAIL -eq 0 ] || exit 1
exit 0
