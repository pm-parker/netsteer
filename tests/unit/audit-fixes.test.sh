#!/bin/sh
# audit-fixes.test.sh — 安全加固与审计回归测试 (以真实运行时沙箱/mock 为主, CI 无 uci/root 环境可跑)
set -u

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
FILES="$ROOT/files"
pass=0; fail=0

ok()   { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$1"; }
nok()  { fail=$((fail + 1)); printf 'not ok %d - %s\n' "$pass" "$1"; }
has()  { grep -qE "$2" "$3" 2>/dev/null && ok "$1" || nok "$1 (missing: $2 in $3)"; }
nhas() { grep -qE "$2" "$3" 2>/dev/null && nok "$1 (unexpected: $2 in $3)" || ok "$1"; }
valid_json() { printf '%s' "$1" | python3 -m json.tool >/dev/null 2>&1; }

WORK="$(mktemp -d /tmp/nsauditXXXXXX)"
trap 'rm -rf "$WORK"' EXIT
MOCKBIN="$WORK/bin"
mkdir -p "$MOCKBIN"

# 通用 mock logger (不污染宿主机 syslog)
cat > "$MOCKBIN/logger" <<'EOF'
#!/bin/sh
echo "logger $*" >> "${MOCK_LOG:-/dev/null}"
EOF
chmod +x "$MOCKBIN/logger"

# 通用 mock uci (基于键值文件 $MOCK_UCI_DB)
cat > "$MOCKBIN/uci" <<'EOF'
#!/bin/sh
DB="${MOCK_UCI_DB:-/tmp/mock_uci.db}"
touch "$DB"
[ "${1:-}" = "-q" ] && shift
cmd="${1:-}"; shift || true
case "$cmd" in
	get)
		k="$1"
		awk -F'=' -v k="$k" '$1==k { sub(/^[^=]*=/, ""); print; f=1; exit } END{ exit !f }' "$DB"
		;;
	set)
		kv="$1"
		k="${kv%%=*}"; v="${kv#*=}"
		awk -F'=' -v k="$k" '$1!=k' "$DB" > "$DB.tmp" && mv "$DB.tmp" "$DB"
		printf '%s=%s\n' "$k" "$v" >> "$DB"
		echo "set $kv" >> "${MOCK_UCI_LOG:-/dev/null}"
		;;
	add_list)
		kv="$1"
		k="${kv%%=*}"; v="${kv#*=}"
		cur=$(awk -F'=' -v k="$k" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$DB")
		awk -F'=' -v k="$k" '$1!=k' "$DB" > "$DB.tmp" && mv "$DB.tmp" "$DB"
		if [ -n "$cur" ]; then printf '%s=%s %s\n' "$k" "$cur" "$v" >> "$DB"; else printf '%s=%s\n' "$k" "$v" >> "$DB"; fi
		;;
	del_list)
		kv="$1"
		k="${kv%%=*}"; v="${kv#*=}"
		cur=$(awk -F'=' -v k="$k" '$1==k { sub(/^[^=]*=/, ""); print; exit }' "$DB")
		awk -F'=' -v k="$k" '$1!=k' "$DB" > "$DB.tmp" && mv "$DB.tmp" "$DB"
		new=$(printf '%s\n' "$cur" | tr ' ' '\n' | grep -vxF "$v" | tr '\n' ' ' | sed 's/ $//')
		[ -n "$new" ] && printf '%s=%s\n' "$k" "$new" >> "$DB"
		;;
	delete)
		k="$1"
		awk -F'=' -v k="$k" '$1!=k' "$DB" > "$DB.tmp" && mv "$DB.tmp" "$DB"
		echo "delete $k" >> "${MOCK_UCI_LOG:-/dev/null}"
		;;
	show)
		p="${1:-}"
		if [ -n "$p" ]; then
			awk -F'=' -v p="$p" 'index($1, p)==1 { k=$1; sub(/^[^=]*=/, ""); printf "%s=\x27%s\x27\n", k, $0 }' "$DB"
		else
			awk -F'=' '{ k=$1; sub(/^[^=]*=/, ""); printf "%s=\x27%s\x27\n", k, $0 }' "$DB"
		fi
		;;
	commit)
		echo "commit $*" >> "${MOCK_UCI_LOG:-/dev/null}"
		;;
	import)
		cat >/dev/null
		echo "import $*" >> "${MOCK_UCI_LOG:-/dev/null}"
		;;
esac
EOF
chmod +x "$MOCKBIN/uci"

# ==============================================================================
# 1. netsteer-cfg 运行时测试 (输入注入拦截 + 单键/整节 get)
# ==============================================================================
CFG_SH="$WORK/netsteer-cfg"
sed "s|UCI=/sbin/uci|UCI=$MOCKBIN/uci|" "$FILES/usr/bin/netsteer-cfg" > "$CFG_SH"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" set "firewall.@defaults[0]" "input" "ACCEPT" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg 运行时拒绝跨包 section 注入" \
	|| nok "cfg 未拒绝跨包 section: rc=$RC out=$OUT"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" set "qos" "a.b" "1" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg 运行时拒绝含点 key 注入" \
	|| nok "cfg 未拒绝含点 key: rc=$RC out=$OUT"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" get "qos;id" "enabled" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg get 运行时拒绝非法 section" \
	|| nok "cfg get 未拒绝非法 section: rc=$RC out=$OUT"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" set "qos" "device" "192.168.11.123" 2>&1); RC=$?
[ "$RC" -eq 0 ] && echo "$OUT" | grep -q '"ok":true' \
	&& ok "cfg set 合法键值写入成功" \
	|| nok "cfg set 失败: rc=$RC out=$OUT"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" get "qos" "device" 2>&1)
valid_json "$OUT" && echo "$OUT" | grep -q '"value":"192.168.11.123"' \
	&& ok "cfg get 单键返回精确值" \
	|| nok "cfg get 单键失败: $OUT"

OUT=$(MOCK_UCI_DB="$WORK/cfg.db" sh "$CFG_SH" get "qos" 2>&1)
valid_json "$OUT" && echo "$OUT" | grep -q 'netsteer.qos.device=' \
	&& ok "cfg get 不传 key 正确返回整节" \
	|| nok "cfg get 整节失败: $OUT"

# ==============================================================================
# 2. netsteer-irq 运行时测试 (路径穿越 / JSON 注入 / >4核前导零与大写 / 拒写不污染 UCI)
# ==============================================================================
OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "../../../tmp/evil" "f" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 拒绝路径穿越 irq" \
	|| nok "irq set 未拒绝路径穿越: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "104" "1234567890abcdef1" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 拒绝超宽 mask" \
	|| nok "irq set 未拒绝超宽 mask: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "104" "0000" 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 拒绝全零 mask" \
	|| nok "irq set 未拒绝全零 mask: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "104" 'x","ok":1,"a":"' 2>&1); RC=$?
[ "$RC" -ne 0 ] && valid_json "$OUT" && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 非法 mask 不存在 JSON 注入" \
	|| nok "irq set JSON 注入漏洞: rc=$RC out=$OUT"

# 模拟 >4 核路由器内核前导零回读 ("8" -> "08", "0F" -> "0f") + 拒写不写 UCI
mkdir -p "$WORK/proc_irq/104" "$WORK/proc_irq/105"
printf '           CPU0       CPU1       CPU2       CPU3\n104:          10         20         30         40  ITS-PCI-MSIX-0001:11:00.0   999 Edge      eth0\n105:          1          2          3          4  ITS-PCI-MSIX-0002:21:00.0   888 Edge      eth1\n' > "$WORK/interrupts"
printf 'netsteer.eth0.iface=eth0\nnetsteer.eth0.irq_cpus=2\nnetsteer.eth1.iface=eth1\nnetsteer.eth1.irq_cpus=4\n' > "$WORK/irq.db"
# 104 可写且通过 FIFO/预写模拟内核补前导零: 借助只读对比 — 先写正常回读 "08" (先建普通文件写 "8", 验证 norm_hex("08")==norm_hex("8"))
IRQ_SH="$WORK/netsteer-irq"
# 模拟 8 核内核: 写入 smp_affinity 后内核回读为 2 位前导零小写
sed 's|echo "\$norm_mask" > "\$aff" 2>/dev/null|if [ -w "$aff" ]; then printf "%02x\\n" "0x$norm_mask" > "$aff" 2>/dev/null; fi|' \
	"$FILES/usr/bin/netsteer-irq" > "$IRQ_SH"
echo "02" > "$WORK/proc_irq/104/smp_affinity"
echo "04" > "$WORK/proc_irq/105/smp_affinity"
chmod 444 "$WORK/proc_irq/105/smp_affinity"  # 模拟 managed IRQ 内核拒写

OUT=$(PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/irq.db" MOCK_UCI_LOG="$WORK/irq_uci.log" \
	PROC_IRQ_DIR="$WORK/proc_irq" PROC_INTERRUPTS="$WORK/interrupts" \
	sh "$IRQ_SH" set 104 8 2>&1)
UCI_VAL=$(MOCK_UCI_DB="$WORK/irq.db" "$MOCKBIN/uci" -q get netsteer.eth0.irq_cpus)
valid_json "$OUT" && echo "$OUT" | grep -q '"ok":1' && echo "$OUT" | grep -q '"after":"08"' && [ "$UCI_VAL" = "8" ] \
	&& ok "irq set 8核前导零回读 (want=8 after=08) 判定成功并同步 UCI=8" \
	|| nok "irq set 前导零回读回归: out=$OUT uci=$UCI_VAL"

OUT=$(PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/irq.db" \
	PROC_IRQ_DIR="$WORK/proc_irq" PROC_INTERRUPTS="$WORK/interrupts" \
	sh "$IRQ_SH" set 104 0F 2>&1)
UCI_VAL=$(MOCK_UCI_DB="$WORK/irq.db" "$MOCKBIN/uci" -q get netsteer.eth0.irq_cpus)
valid_json "$OUT" && echo "$OUT" | grep -q '"ok":1' && [ "$UCI_VAL" = "f" ] \
	&& ok "irq set 大写带零掩码 (0F -> after=0f) 判定成功并归一化 UCI=f" \
	|| nok "irq set 大写掩码失败: out=$OUT uci=$UCI_VAL"

# 测试 managed IRQ 拒写 (105 只读保持 04): 应报 ok:0 且 UCI 保持原值 4 不被污染
: > "$WORK/irq_uci.log"
OUT=$(PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/irq.db" MOCK_UCI_LOG="$WORK/irq_uci.log" \
	PROC_IRQ_DIR="$WORK/proc_irq" PROC_INTERRUPTS="$WORK/interrupts" \
	sh "$IRQ_SH" set 105 8 2>&1)
UCI_VAL=$(MOCK_UCI_DB="$WORK/irq.db" "$MOCKBIN/uci" -q get netsteer.eth1.irq_cpus)
valid_json "$OUT" && echo "$OUT" | grep -q '"ok":0' && [ "$UCI_VAL" = "4" ] && [ ! -s "$WORK/irq_uci.log" ] \
	&& ok "irq set 内核拒写返回 ok:0 且不污染 UCI" \
	|| nok "irq set 内核拒写污染了 UCI: out=$OUT uci=$UCI_VAL log=$(cat "$WORK/irq_uci.log")"
chmod 644 "$WORK/proc_irq/105/smp_affinity"

CNT=$(awk -v i="104" -v nc="4" '$1==i":" {lim=nc+1; if(lim>NF) lim=NF; for(k=2;k<=lim;k++) s+=$k; print s+0; exit}' "$WORK/interrupts")
[ "$CNT" = "100" ] && ok "irq counts 仅累加前 NCPU 列 ($CNT)" || nok "irq counts 误计入描述列数字 (got=$CNT want=100)"

# ==============================================================================
# 3. netsteer-qos 运行时测试 (POSIX sed secret/port 解析 / 非贪婪含|密码 / sense 第4行 / reapply 清表)
# ==============================================================================
nhas "qos 彻底消除 eval 调用" '^[[:space:]]*eval ' "$FILES/usr/bin/netsteer-qos"

# 直接从 netsteer-qos 提取真实 sed 表达式并用 sed --posix 验证 (模拟 OpenWrt musl/BusyBox sed)
SED_PORT=$(python3 -c 'import re,sys; s=open(sys.argv[1]).read(); print(re.search(r"local p=\$\(sed -n '\''(.*?)'\'' \"\$cfg\"", s).group(1))' "$FILES/usr/bin/netsteer-qos")
SED_SEC=$(python3 -c 'import re,sys; s=open(sys.argv[1]).read(); print(re.search(r"local s=\$\(sed -n '\''(.*?)'\'' \"\$cfg\"", s).group(1))' "$FILES/usr/bin/netsteer-qos")
# 注意 shell 字面 '\'' 在源码中代表单引号字符, 还原后喂给 sed --posix
SED_PORT=$(printf '%s' "$SED_PORT" | sed "s/'\\\\''/'/g")
SED_SEC=$(printf '%s' "$SED_SEC" | sed "s/'\\\\''/'/g")
for tc in \
	"external-controller: '[::]:9090'===9090" \
	'external-controller: "[::]:19090"===19090' \
	'external-controller: 0.0.0.0:9099===9099' \
	'external-controller: 127.0.0.1:9091 ===9091'; do
	line="${tc%%===*}"; want="${tc##*===}"
	got=$(printf '%s\n' "$line" | sed --posix -n "$SED_PORT" 2>/dev/null | head -1)
	[ "$got" = "$want" ] && ok "qos POSIX sed 解析 external-controller ($want)" || nok "qos POSIX sed 失败 ($line got=$got want=$want)"
done

for tc in \
	"secret: 'mysec123'===mysec123" \
	'secret: "mysec456"===mysec456' \
	'secret: plain789 ===plain789' \
	'secret: "sec|with|pipe"===sec|with|pipe'; do
	line="${tc%%===*}"; want="${tc##*===}"
	got=$(printf '%s\n' "$line" | sed --posix -n "$SED_SEC" 2>/dev/null | head -1)
	[ "$got" = "$want" ] && ok "qos POSIX sed 解析 secret ($want)" || nok "qos POSIX sed 解析 secret 失败 ($line got=$got want=$want)"
done

# 测试含 '|' 的 secret 经 core|port|secret 拆分不被截断
api="nikki|9090|sec|with|pipe"
rest="${api#*|}"; port="${rest%%|*}"; secret="${rest#*|}"
[ "$port" = "9090" ] && [ "$secret" = "sec|with|pipe" ] \
	&& ok "qos 非贪婪拆分保留含 | 的 secret" \
	|| nok "qos 拆分截断了 secret: port=$port secret=$secret"

# 沙箱运行时测试 qos_sense + qos_sense_link: 第 4 行 linked_prev 在多轮后保留且总行数恒为 4
mkdir -p "$WORK/sense_dir"
cat > "$WORK/sense_runner.sh" <<EOF
#!/bin/sh
SENSE_DIR="$WORK/sense_dir"
SENSE_JSON="\$SENSE_DIR/sense.json"
SENSE_STATE="\$SENSE_DIR/sense.state"
log() { :; }
qos_get() {
	case "\$1" in
		sense_exclude) echo "" ;;
		sense_interval) echo "30" ;;
		sense_linked) echo "1" ;;
		*) echo "\${2:-}" ;;
	esac
}
qos_dnslog() { echo '[{"q":"steam.com","c":"192.168.11.10","d":"1.2.3.4","p":"27015","t":"udp","u":"40000","v":"40000"}]'; }
qos_json2tab() { awk -f "$FILES/usr/share/netsteer/json2tab.awk"; }
EOF
sed -n '/^qos_sense()/,/^}/p' "$FILES/usr/bin/netsteer-qos" | \
	sed "s|/usr/share/netsteer|$FILES/usr/share/netsteer|g" >> "$WORK/sense_runner.sh"
sed -n '/^scene_mode()/,/^}/p' "$FILES/usr/bin/netsteer-qos" >> "$WORK/sense_runner.sh"
sed -n '/^qos_sense_link()/,/^}/p' "$FILES/usr/bin/netsteer-qos" | \
	sed "s|/usr/bin/netsteer-mode|$MOCKBIN/mock-mode|g" >> "$WORK/sense_runner.sh"
cat > "$MOCKBIN/mock-mode" <<'EOF'
#!/bin/sh
echo "mode $*" >> "${MOCK_MODE_LOG:-/dev/null}"
EOF
chmod +x "$MOCKBIN/mock-mode"
printf 'netsteer.scenario.mode=standard\n' > "$WORK/sense.db"
cat >> "$WORK/sense_runner.sh" <<'EOF'
qos_sense 200
qos_sense_link
qos_sense 200
qos_sense_link
qos_sense 200
qos_sense_link
EOF
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/sense.db" MOCK_MODE_LOG="$WORK/sense_mode.log" \
	GAMEDOMAINS="$FILES/usr/share/netsteer/gamedomains.txt" \
	CONFDOMAINS="$FILES/usr/share/netsteer/confdomains.txt" \
	DLTRACKERS="$FILES/usr/share/netsteer/downloadtrackers.txt" \
	STREAMDOMAINS="$FILES/usr/share/netsteer/streamdomains.txt" \
	GAMEIPS="$FILES/usr/share/netsteer/gameips.txt" \
	GAMEPORTS="$FILES/usr/share/netsteer/gameports.txt" \
	DLPORTS="$FILES/usr/share/netsteer/downloadports.txt" \
	sh "$WORK/sense_runner.sh"
MODE_CALLS=$(wc -l < "$WORK/sense_mode.log" 2>/dev/null | tr -d ' ')
STATE_LINES=$(wc -l < "$WORK/sense_dir/sense.state" 2>/dev/null | tr -d ' ')
LINE4=$(sed -n 4p "$WORK/sense_dir/sense.state" 2>/dev/null)
[ "$MODE_CALLS" = "1" ] && [ "$STATE_LINES" = "4" ] && [ "$LINE4" = "gaming" ] \
	&& ok "qos_sense + qos_sense_link 边沿触发仅切 1 次且保留 4 行 state (line4=$LINE4)" \
	|| nok "qos_sense_link 边沿触发异常: calls=$MODE_CALLS lines=$STATE_LINES line4=$LINE4"

# ==============================================================================
# 4. netsteer-check 运行时测试 (存量 incidents 清理 / feed 恢复含 manifest 不死循环 / off 跳过 / 08==8 不误报)
# ==============================================================================
mkdir -p "$WORK/chk/state" "$WORK/chk/etc/incidents" "$WORK/chk/etc/feed-history/20261120-2026-11-20-aaa" \
	"$WORK/chk/data" "$WORK/chk/sys/class/net/eth0/queues/rx-0" "$WORK/chk/proc/irq/104"
# 造 25 个存量 incident 文件
i=1; while [ "$i" -le 25 ]; do
	printf 'old %d\n' "$i" > "$WORK/chk/etc/incidents/incident-1101-0000$(printf '%02d' "$i").log"
	i=$((i + 1))
done
# 造 feed-history (2026.11.20) 新于包内 (2026.11.12)
printf '# netsteer-data-manifest v=2026.11.20-aaa gen=x\ngamedomains.txt\taaa\t10\n' > "$WORK/chk/etc/feed-history/20261120-2026-11-20-aaa/manifest.tsv"
printf 'gaming\tuser.example.com\n' > "$WORK/chk/etc/feed-history/20261120-2026-11-20-aaa/gamedomains.txt"
printf '# netsteer-data-manifest v=2026.11.12-bbb gen=x\ngamedomains.txt\tbbb\t10\n' > "$WORK/chk/data/manifest.tsv"
printf 'gaming\tpkg.example.com\n' > "$WORK/chk/data/gamedomains.txt"
# 造 8 核前导零 state: UCI=8, sysfs=08, rps=0f vs f
printf 'netsteer eth0 eth0 rps f irq 104 8\n' > "$WORK/chk/state/state.txt"
printf '0f\n' > "$WORK/chk/sys/class/net/eth0/queues/rx-0/rps_cpus"
printf '08\n' > "$WORK/chk/proc/irq/104/smp_affinity"
printf 'netsteer.state.enabled=1\nnetsteer.scenario.mode=standard\nnetsteer.eth0.rps_cpus=f\nnetsteer.eth0.irq_cpus=8\n' > "$WORK/chk.db"
CHK_SH="$WORK/netsteer-check"
sed -e 's|/etc/crontabs/root|'"$WORK/chk/cron"'|g' \
	-e 's|/usr/bin/netsteer-feed|/nonexistent-feed|g' \
	"$FILES/usr/bin/netsteer-check" > "$CHK_SH"
cat > "$MOCKBIN/mock-apply" <<'EOF'
#!/bin/sh
echo "apply $*" >> "${MOCK_APPLY_LOG:-/dev/null}"
EOF
chmod +x "$MOCKBIN/mock-apply"

PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/chk.db" MOCK_LOG="$WORK/chk.log" MOCK_APPLY_LOG="$WORK/chk_apply.log" \
	NS_STATE_DIR="$WORK/chk/state" NS_INC_DIR="$WORK/chk/etc/incidents" NS_HISTORY="$WORK/chk/etc/history.log" \
	NS_DATA_DIR="$WORK/chk/data" NS_FEED_HIST="$WORK/chk/etc/feed-history" \
	NS_NET_SYS="$WORK/chk/sys" NS_PROC="$WORK/chk/proc" NS_APPLY="$MOCKBIN/mock-apply" \
	sh "$CHK_SH"
INC_LEFT=$(ls -1 "$WORK/chk/etc/incidents" | wc -l | tr -d ' ')
[ "$INC_LEFT" = "20" ] \
	&& ok "check 运行时自动将 25 个存量 incidents 清理至 20 个" \
	|| nok "check 未清理存量 incidents (left=$INC_LEFT)"

grep -q 'v=2026.11.20-aaa' "$WORK/chk/data/manifest.tsv" && grep -q 'user.example.com' "$WORK/chk/data/gamedomains.txt" \
	&& ok "check feed 升级恢复同步拷贝了 manifest.tsv 与 *.txt" \
	|| nok "check feed 恢复未拷贝 manifest.tsv"

[ ! -s "$WORK/chk_apply.log" ] \
	&& ok "check 对 8核前导零 (08 vs 8, 0f vs f) 不误报漂移" \
	|| nok "check 误报前导零漂移: $(cat "$WORK/chk_apply.log")"

# 第 2 次运行 check: 因 manifest.tsv 已同步, 不应再次触发 feed 恢复
RESTORE_BEFORE=$(grep -c 'feed 升级覆盖已恢复用户数据' "$WORK/chk/etc/history.log" 2>/dev/null || echo 0)
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/chk.db" MOCK_LOG="$WORK/chk.log" MOCK_APPLY_LOG="$WORK/chk_apply.log" \
	NS_STATE_DIR="$WORK/chk/state" NS_INC_DIR="$WORK/chk/etc/incidents" NS_HISTORY="$WORK/chk/etc/history.log" \
	NS_DATA_DIR="$WORK/chk/data" NS_FEED_HIST="$WORK/chk/etc/feed-history" \
	NS_NET_SYS="$WORK/chk/sys" NS_PROC="$WORK/chk/proc" NS_APPLY="$MOCKBIN/mock-apply" \
	sh "$CHK_SH"
RESTORE_AFTER=$(grep -c 'feed 升级覆盖已恢复用户数据' "$WORK/chk/etc/history.log" 2>/dev/null || echo 0)
[ "$RESTORE_BEFORE" = "1" ] && [ "$RESTORE_AFTER" = "1" ] \
	&& ok "check 二次运行不再死循环恢复 feed" \
	|| nok "check feed 恢复死循环: before=$RESTORE_BEFORE after=$RESTORE_AFTER"

# mode=off / enabled=0 时即使 sysfs 变为 0 也不触发漂移自愈
printf '0\n' > "$WORK/chk/sys/class/net/eth0/queues/rx-0/rps_cpus"
printf 'netsteer.state.enabled=0\nnetsteer.scenario.mode=off\nnetsteer.eth0.rps_cpus=f\nnetsteer.eth0.irq_cpus=8\n' > "$WORK/chk.db"
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/chk.db" MOCK_LOG="$WORK/chk.log" MOCK_APPLY_LOG="$WORK/chk_apply.log" \
	NS_STATE_DIR="$WORK/chk/state" NS_INC_DIR="$WORK/chk/etc/incidents" NS_HISTORY="$WORK/chk/etc/history.log" \
	NS_DATA_DIR="$WORK/chk/data" NS_FEED_HIST="$WORK/chk/etc/feed-history" \
	NS_NET_SYS="$WORK/chk/sys" NS_PROC="$WORK/chk/proc" NS_APPLY="$MOCKBIN/mock-apply" \
	sh "$CHK_SH"
[ ! -s "$WORK/chk_apply.log" ] \
	&& ok "check 在 mode=off/enabled=0 时跳过漂移自愈 (不再 60s 拉回)" \
	|| nok "check 在 off 态仍触发了自愈: $(cat "$WORK/chk_apply.log")"

# ==============================================================================
# 5. netsteer-bulk / netsteer-qos reapply 幂等清表 + 失败回滚运行时测试
# ==============================================================================
cat > "$MOCKBIN/nft" <<'EOF'
#!/bin/sh
echo "nft $*" >> "${MOCK_NFT_LOG:-/dev/null}"
if [ "${MOCK_NFT_FAIL:-0}" = "1" ] && [ "${1:-}" = "-f" ]; then
	echo "Error: No such file or directory" >&2
	exit 1
fi
exit 0
EOF
chmod +x "$MOCKBIN/nft"

BULK_SH="$WORK/netsteer-bulk"
sed -e 's|^\. /lib/functions\.sh|:|' \
	-e 's|RULES=/tmp/netsteer/bulk-rules\.nft|RULES='"$WORK/bulk-rules.nft"'|' \
	-e 's|LOADERR=/tmp/netsteer/bulk-nft\.err|LOADERR='"$WORK/bulk-nft.err"'|' \
	-e 's|/usr/bin/netsteer-snapshot|true|' \
	"$FILES/usr/bin/netsteer-bulk" > "$BULK_SH"

# 空列表执行 bulk reapply 必须删除残留 nft 表
: > "$WORK/bulk_empty.db"
: > "$WORK/bulk_nft.log"
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/bulk_empty.db" MOCK_NFT_LOG="$WORK/bulk_nft.log" \
	sh "$BULK_SH" reapply >/dev/null 2>&1
grep -q 'nft delete table inet netsteer_bulk' "$WORK/bulk_nft.log" \
	&& ok "bulk reapply 空列表时真实删除残留 netsteer_bulk 表" \
	|| nok "bulk reapply 空列表未删表: $(cat "$WORK/bulk_nft.log")"

# nft 彻底失败时 bulk add 必须回滚 UCI 并返回非 0
: > "$WORK/bulk_fail.db"
OUT=$(PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/bulk_fail.db" MOCK_NFT_LOG="$WORK/bulk_nft.log" MOCK_NFT_FAIL=1 \
	sh "$BULK_SH" add 192.168.11.188 2>&1); RC=$?
B_LEFT=$(MOCK_UCI_DB="$WORK/bulk_fail.db" "$MOCKBIN/uci" -q get netsteer.qos.bulk_devices || echo "")
[ "$RC" -ne 0 ] && [ -z "$B_LEFT" ] \
	&& ok "bulk add 在 nft 彻底失败时报错并回滚 UCI" \
	|| nok "bulk add 失败未回滚: rc=$RC out=$OUT uci=$B_LEFT"

# qos reapply 在 enabled=0 时必须删除残留 netsteer_qos 表
QOS_SH="$WORK/netsteer-qos"
sed -e 's#^\. /lib/functions\.sh#:#' \
	-e 's#config_load netsteer 2>/dev/null#:#' \
	-e 's#config_get v "qos" "\$1" "\$2"#v=$(uci -q get "netsteer.qos.$1" 2>/dev/null); [ -n "$v" ] || v="$2"#' \
	-e 's#RULES=/tmp/netsteer/qos-rules\.nft#RULES='"$WORK/qos-rules.nft"'#' \
	-e 's#LOADERR=/tmp/netsteer/qos-nft\.err#LOADERR='"$WORK/qos-nft.err"'#' \
	-e 's#/usr/bin/netsteer-snapshot#true#' \
	"$FILES/usr/bin/netsteer-qos" > "$QOS_SH"
printf 'netsteer.qos.enabled=0\n' > "$WORK/qos_off.db"
: > "$WORK/qos_nft.log"
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/qos_off.db" MOCK_NFT_LOG="$WORK/qos_nft.log" \
	sh "$QOS_SH" reapply >/dev/null 2>&1
grep -q 'nft delete table inet netsteer_qos' "$WORK/qos_nft.log" \
	&& ok "qos reapply 关闭态时真实删除残留 netsteer_qos 表" \
	|| nok "qos reapply 关闭态未删表: $(cat "$WORK/qos_nft.log")"

# ==============================================================================
# 6. netsteer-snapshot restore 运行时测试 (off 快照调用 apply clear / p2p off / qos & bulk reapply)
# ==============================================================================
mkdir -p "$WORK/snaps/20261125-000000-off" "$WORK/etc_cfg"
printf 'config netsteer state\n' > "$WORK/snaps/20261125-000000-off/netsteer.uci"
printf 'config queue eth1\n' > "$WORK/snaps/20261125-000000-off/sqm.uci"
printf '0\n' > "$WORK/snaps/20261125-000000-off/offloading"
printf 'off\n' > "$WORK/snaps/20261125-000000-off/mode"
printf '1700000000\n' > "$WORK/snaps/20261125-000000-off/ts"
printf 'netsteer.state.enabled=0\nnetsteer.scenario.mode=off\n' > "$WORK/snap.db"
cat > "$MOCKBIN/rec" <<'EOF'
#!/bin/sh
echo "$*" >> "${MOCK_SNAP_LOG:-/dev/null}"
EOF
chmod +x "$MOCKBIN/rec"
SNAP_SH="$WORK/netsteer-snapshot"
sed -e "s|SNAP_DIR=/etc/netsteer/snapshots|SNAP_DIR=$WORK/snaps|" \
	-e "s|PHIST=/etc/netsteer/history.log|PHIST=$WORK/snap_hist.log|" \
	-e "s|UCI=.*|UCI=$MOCKBIN/uci|" \
	-e "s|/etc/config/|$WORK/etc_cfg/|g" \
	-e "s|fw4 reload|$MOCKBIN/rec fw4-reload|" \
	-e "s|/etc/init.d/sqm restart|$MOCKBIN/rec sqm-restart|" \
	-e "s|/usr/bin/netsteer-apply|$MOCKBIN/rec netsteer-apply|g" \
	-e "s|/usr/bin/netsteer-p2p|$MOCKBIN/rec netsteer-p2p|g" \
	-e "s|/usr/bin/netsteer-qos|$MOCKBIN/rec netsteer-qos|g" \
	-e "s|/usr/bin/netsteer-bulk|$MOCKBIN/rec netsteer-bulk|g" \
	"$FILES/usr/bin/netsteer-snapshot" > "$SNAP_SH"
: > "$WORK/snap_calls.log"
PATH="$MOCKBIN:$PATH" MOCK_UCI_DB="$WORK/snap.db" MOCK_SNAP_LOG="$WORK/snap_calls.log" \
	sh "$SNAP_SH" restore 20261125-000000-off >/dev/null 2>&1
grep -q 'netsteer-apply clear' "$WORK/snap_calls.log" \
	&& grep -q 'netsteer-p2p off' "$WORK/snap_calls.log" \
	&& grep -q 'netsteer-qos reapply' "$WORK/snap_calls.log" \
	&& grep -q 'netsteer-bulk reapply' "$WORK/snap_calls.log" \
	&& ok "snapshot restore(off) 真实调用 apply clear / p2p off / qos reapply / bulk reapply" \
	|| nok "snapshot restore 清理缺失: $(cat "$WORK/snap_calls.log")"

# ==============================================================================
# 7. netsteer-bench bg 原子目录锁并发测试
# ==============================================================================
mkdir -p "$WORK/bench_dir"
cat > "$MOCKBIN/fake-bench" <<'EOF'
#!/bin/sh
echo "run $$ ppid=$PPID t=$(date +%s.%N 2>/dev/null || date +%s) lock=$(ls -a "$(dirname "$MOCK_BENCH_LOG")/bench_dir/.bench.lock" 2>/dev/null | tr '\n' ',') pidf=$(cat "$(dirname "$MOCK_BENCH_LOG")/bench_dir/.bench.lock/pid" 2>/dev/null)" >> "${MOCK_BENCH_LOG}"
sleep 0.5
EOF
chmod +x "$MOCKBIN/fake-bench"
: > "$WORK/bench_runs.log"
NETSTEER_STATE_DIR="$WORK/bench_dir" NETSTEER_BENCH_BIN="$MOCKBIN/fake-bench" MOCK_BENCH_LOG="$WORK/bench_runs.log" \
	PATH="$MOCKBIN:$PATH" sh "$FILES/usr/bin/netsteer-bench" bg &
NETSTEER_STATE_DIR="$WORK/bench_dir" NETSTEER_BENCH_BIN="$MOCKBIN/fake-bench" MOCK_BENCH_LOG="$WORK/bench_runs.log" \
	PATH="$MOCKBIN:$PATH" sh "$FILES/usr/bin/netsteer-bench" bg &
wait
sleep 0.8
BENCH_CNT=$(wc -l < "$WORK/bench_runs.log" | tr -d ' ')
[ "$BENCH_CNT" = "1" ] && [ ! -d "$WORK/bench_dir/.bench.lock" ] \
	&& ok "bench bg 并发双调用仅执行 1 次且退出后自动释放目录锁" \
	|| nok "bench bg 锁异常: runs=$BENCH_CNT lock_exists=$([ -e "$WORK/bench_dir/.bench.lock" ] && echo yes || echo no) log=$(tr '\n' ';' < "$WORK/bench_runs.log")"

# ==============================================================================
# 8. init.d disable IPKG_INSTROOT 隔离 + 关键配置与构建门禁校验
# ==============================================================================
nhas "init.d disable 不再调用不存在的 default_disable" 'default_disable' "$FILES/etc/init.d/netsteer"
nhas "ACL 最小权限: 不放行未使用的 netsteer-check" '/usr/bin/netsteer-check' "$FILES/usr/share/rpcd/acl.d/luci-app-netsteer.json"
has "apply state.json 临时文件含 PID" 'STATE_TMP=.*\$\$' "$FILES/usr/bin/netsteer-apply"
has "apply state.txt 原子替换" 'mv "\$STATE_TXT_TMP" "\$STATE_TXT"' "$FILES/usr/bin/netsteer-apply"
has "apply IRQ 回读使用 norm_hex 归一化" 'norm_hex "\$after"' "$FILES/usr/bin/netsteer-apply"
has "mode off 置 netsteer.state.enabled=0" "netsteer\.state\.enabled='0'" "$FILES/usr/bin/netsteer-mode"
has "mode 保护游戏通道不被覆写" 'set_sqm_script_safe' "$FILES/usr/bin/netsteer-mode"
has "mode 补齐 CAKE nat dual-dsthost (无字面单引号)" 'sqm\.\$1\.iqdisc_opts=nat dual-dsthost"' "$FILES/usr/bin/netsteer-mode"
has "mode 补齐 CAKE nat dual-srchost (无字面单引号)" 'sqm\.\$1\.eqdisc_opts=nat dual-srchost"' "$FILES/usr/bin/netsteer-mode"
has "mode 切回工作模式显式解除 packet_steering 停止态" 'sync-packet-steering active' "$FILES/usr/bin/netsteer-mode"
has "mode apply_p2p 校验 apply_standard 返回码" 'apply_standard >/dev/null \|\| return 1' "$FILES/usr/bin/netsteer-mode"
nhas "mode steering 不再硬编码 @queue[0]" 'sqm\.@queue\[0\]' "$FILES/usr/bin/netsteer-mode"
nhas "apply 锁不再依赖 OpenWrt 缺失的 flock" 'command -v flock|flock -w' "$FILES/usr/bin/netsteer-apply"
has "apply preset off 不压制原生 packet_steering" '\[ "\$PRESET" != "off" \]' "$FILES/usr/bin/netsteer-apply"

# 实测: 无 flock 环境下 netsteer-apply sync-packet-steering (模拟原生 OpenWrt) + mode off -> mode standard 往返解除停止态
mkdir -p "$WORK/noflock_bin" "$WORK/rt_mode"
ln -s "$MOCKBIN/uci" "$WORK/noflock_bin/uci"
ln -s "$MOCKBIN/logger" "$WORK/noflock_bin/logger"
cat > "$WORK/noflock_bin/flock" <<'EOF'
#!/bin/sh
echo "flock should NOT be called" >&2
exit 127
EOF
chmod +x "$WORK/noflock_bin/flock"
printf 'network.globals.packet_steering=1\n' > "$WORK/rt_mode/uci.db"
OUT_PS=$(PATH="$WORK/noflock_bin:$PATH" MOCK_UCI_DB="$WORK/rt_mode/uci.db" \
	NS_PS_ORIGIN="$WORK/rt_mode/ps.origin" NS_PS_STOPPED="$WORK/rt_mode/svc.stopped" \
	sh "$FILES/usr/bin/netsteer-apply" sync-packet-steering active 2>&1); RC1=$?
V1=$(MOCK_UCI_DB="$WORK/rt_mode/uci.db" "$MOCKBIN/uci" -q get network.globals.packet_steering)
OUT_PS2=$(PATH="$WORK/noflock_bin:$PATH" MOCK_UCI_DB="$WORK/rt_mode/uci.db" \
	NS_PS_ORIGIN="$WORK/rt_mode/ps.origin" NS_PS_STOPPED="$WORK/rt_mode/svc.stopped" \
	sh "$FILES/usr/bin/netsteer-apply" sync-packet-steering inactive 2>&1); RC2=$?
V2=$(MOCK_UCI_DB="$WORK/rt_mode/uci.db" "$MOCKBIN/uci" -q get network.globals.packet_steering)
OUT_PS3=$(PATH="$WORK/noflock_bin:$PATH" MOCK_UCI_DB="$WORK/rt_mode/uci.db" \
	NS_PS_ORIGIN="$WORK/rt_mode/ps.origin" NS_PS_STOPPED="$WORK/rt_mode/svc.stopped" \
	sh "$FILES/usr/bin/netsteer-apply" sync-packet-steering active 2>&1); RC3=$?
V3=$(MOCK_UCI_DB="$WORK/rt_mode/uci.db" "$MOCKBIN/uci" -q get network.globals.packet_steering)
[ "$RC1" -eq 0 ] && [ "$RC2" -eq 0 ] && [ "$RC3" -eq 0 ] && [ "$V1" = "0" ] && [ "$V2" = "1" ] && [ "$V3" = "0" ] && [ ! -f "$WORK/rt_mode/svc.stopped" ] \
	&& ok "apply 零 flock 依赖完成 active->inactive->active 完整往返 (1->0->1->0)" \
	|| nok "apply 零 flock 往返失败: rc=$RC1/$RC2/$RC3 v=$V1/$V2/$V3"
nhas "doctor 不再读错误节 netsteer.game.*" 'netsteer\.game\.' "$FILES/usr/bin/netsteer-doctor"
has "doctor 正确读 netsteer.qos.device" 'netsteer\.qos\.device' "$FILES/usr/bin/netsteer-doctor"
has "doctor 检测 packet_steering 冲突" 'packet_steering' "$FILES/usr/bin/netsteer-doctor"
nhas "bulk_off 不再 while 循环逐条 del_list" 'while \[ -n "\$\(devices_get\)" \]' "$FILES/usr/bin/netsteer-bulk"
has "build-apk.sh 统一通过 ns_as_root 打包" 'ns_as_root "\$MKPKG" mkpkg' "$ROOT/scripts/build-apk.sh"
has "build-apk.sh 赋予 99-netsteer 755" '99-netsteer' "$ROOT/scripts/build-apk.sh"
has "build-apk.sh 正向断言 user: root" 'user: root\$' "$ROOT/scripts/build-apk.sh"
nhas "build-apk.sh adbdump 不再被 || true 吞错" 'adbdump "\$OUT".*\|\| true' "$ROOT/scripts/build-apk.sh"

echo "# pass $pass  fail $fail"
[ "$fail" -eq 0 ]
