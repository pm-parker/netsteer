#!/bin/sh
# audit-fixes.test.sh — 安全加固与审计回归测试 (CI 无 uci/root 环境可直接运行)
set -u

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
FILES="$ROOT/files"
pass=0; fail=0

ok()   { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$1"; }
nok()  { fail=$((fail + 1)); printf 'not ok %d - %s\n' "$pass" "$1"; }
has()  { grep -qE "$2" "$3" 2>/dev/null && ok "$1" || nok "$1 (missing: $2 in $3)"; }
nhas() { grep -qE "$2" "$3" 2>/dev/null && nok "$1 (unexpected: $2 in $3)" || ok "$1"; }

WORK="$(mktemp -d /tmp/nsauditXXXXXX)"
trap 'rm -rf "$WORK"' EXIT

# ---- 1. netsteer-cfg 注入面校验 + get 整节/单键 ----
OUT=$(sh "$FILES/usr/bin/netsteer-cfg" set "firewall.@defaults[0]" "input" "ACCEPT" 2>&1); RC=$?
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg 拒绝跨包 section 注入 (firewall.@defaults[0])" \
	|| nok "cfg 未拒绝跨包 section: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-cfg" set "qos" "a.b" "1" 2>&1); RC=$?
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg 拒绝含点 key 注入" \
	|| nok "cfg 未拒绝含点 key: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-cfg" get "qos;id" "enabled" 2>&1); RC=$?
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"ok":false' \
	&& ok "cfg get 拒绝非法 section" \
	|| nok "cfg get 未拒绝非法 section: rc=$RC out=$OUT"

has "cfg get 支持不传 key 读整节" 'show "netsteer\.\$2"' "$FILES/usr/bin/netsteer-cfg"

# ---- 2. netsteer-irq 路径穿越校验 / 写成功再同步 UCI / 中断求和仅前 NCPU 列 ----
OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "../../../tmp/evil" "f" 2>&1); RC=$?
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 拒绝路径穿越 irq" \
	|| nok "irq set 未拒绝路径穿越: rc=$RC out=$OUT"

OUT=$(sh "$FILES/usr/bin/netsteer-irq" set "104" "1234567890abcdef1" 2>&1); RC=$?
[ "$RC" -ne 0 ] && echo "$OUT" | grep -q '"ok":0' \
	&& ok "irq set 拒绝超宽 mask" \
	|| nok "irq set 未拒绝超宽 mask: rc=$RC out=$OUT"

# 验证中断求和只统计前 NCPU 列 (忽略描述里的 0 / PCI 地址数字)
printf '           CPU0       CPU1       CPU2       CPU3\n104:          10         20         30         40  ITS-PCI-MSIX-0001:11:00.0   999 Edge      eth0\n' > "$WORK/interrupts"
CNT=$(awk -v i="104" -v nc="4" '$1==i":" {lim=nc+1; if(lim>NF) lim=NF; for(k=2;k<=lim;k++) s+=$k; print s+0; exit}' "$WORK/interrupts")
[ "$CNT" = "100" ] && ok "irq counts 仅累加前 NCPU 列 ($CNT)" || nok "irq counts 误计入描述列数字 (got=$CNT want=100)"

# 验证 cmd_set 仅在 after == mask 分支内调用 uci commit
UCI_LINE=$(grep -n 'uci commit netsteer' "$FILES/usr/bin/netsteer-irq" | head -1 | cut -d: -f1)
IF_LINE=$(grep -n 'if \[ "\$after" = "\$mask" \]' "$FILES/usr/bin/netsteer-irq" | head -1 | cut -d: -f1)
[ -n "$UCI_LINE" ] && [ -n "$IF_LINE" ] && [ "$UCI_LINE" -gt "$IF_LINE" ] \
	&& ok "irq set 仅在内核接受写入后再同步 UCI" \
	|| nok "irq set UCI 同步位置异常 (if=$IF_LINE uci=$UCI_LINE)"

# ---- 3. netsteer-qos 无 eval / external-controller 带引号正则 / sense.state 第4行保留 ----
nhas "qos 彻底消除 eval 调用" '^[[:space:]]*eval ' "$FILES/usr/bin/netsteer-qos"

# 实测 external-controller 端口提取正则 (兼容 IPv6 + 单双引号 + 无引号)
for tc in \
	"external-controller: '[::]:9090'|9090" \
	'external-controller: "[::]:19090"|19090' \
	'external-controller: 0.0.0.0:9099|9099' \
	'external-controller: 127.0.0.1:9091 |9091'; do
	line="${tc%|*}"
	want="${tc#*|}"
	got=$(printf '%s\n' "$line" | sed -n "s/^external-controller:.*:\([0-9][0-9]*\)[\"' 	]*$/\1/p" | head -1)
	[ "$got" = "$want" ] && ok "qos external-controller 解析 ($line -> $got)" || nok "qos external-controller 解析失败 ($line got=$got want=$want)"
done

has "qos_sense 保留第 4 行 linked_prev" 'linked_prev=\$\(sed -n 4p' "$FILES/usr/bin/netsteer-qos"
nhas "qos_sense_link 不再追加破坏第 4 行" 'echo "\$prev" >> "\$SENSE_STATE"' "$FILES/usr/bin/netsteer-qos"
has "qos_dnslog_mihomo 限制返回条数 top" 'awk -v top="\$n"' "$FILES/usr/bin/netsteer-qos"
has "qos nft ingress 绑定 device" 'hook ingress device "\$2" priority -450' "$FILES/usr/bin/netsteer-qos"

# ---- 4. netsteer-check feed 恢复含 manifest.tsv / off 跳过漂移 / incidents & history 轮转 ----
has "check feed 恢复同步拷贝 manifest.tsv" 'manifest\.tsv' "$FILES/usr/bin/netsteer-check"
has "check 在 enabled=0 时跳过漂移自愈" 'netsteer\.state\.enabled' "$FILES/usr/bin/netsteer-check"
has "check 在 mode=off 时跳过漂移自愈" 'netsteer\.scenario\.mode.*off' "$FILES/usr/bin/netsteer-check"
has "check 对 incidents 目录做 20 份轮转" 'tail -n \+21' "$FILES/usr/bin/netsteer-check"
has "check 对持久 history.log 做 2000/800 轮转" 'tail -800 "\$NS_HISTORY"' "$FILES/usr/bin/netsteer-check"

# ---- 5. netsteer-apply 原子写 + packet_steering 冲突处理 ----
has "apply state.json 临时文件含 PID" 'STATE_TMP=.*\$\$' "$FILES/usr/bin/netsteer-apply"
has "apply state.txt 原子替换" 'mv "\$STATE_TXT_TMP" "\$STATE_TXT"' "$FILES/usr/bin/netsteer-apply"
has "apply 自动关闭原生 packet_steering 防打架" 'network\.globals\.packet_steering' "$FILES/usr/bin/netsteer-apply"

# ---- 6. netsteer-mode off / gaming 保护 / CAKE nat ----
has "mode off 置 netsteer.state.enabled=0" "netsteer\.state\.enabled='0'" "$FILES/usr/bin/netsteer-mode"
has "mode 保护游戏通道不被覆写" 'set_sqm_script_safe' "$FILES/usr/bin/netsteer-mode"
has "mode 补齐 CAKE nat dual-dsthost" "iqdisc_opts='nat dual-dsthost'" "$FILES/usr/bin/netsteer-mode"
has "mode 补齐 CAKE nat dual-srchost" "eqdisc_opts='nat dual-srchost'" "$FILES/usr/bin/netsteer-mode"
nhas "mode steering 不再硬编码 @queue[0]" 'sqm\.@queue\[0\]' "$FILES/usr/bin/netsteer-mode"

# ---- 7. netsteer-doctor / netsteer-bulk / netsteer-bench / init.d / ACL ----
nhas "doctor 不再读错误节 netsteer.game.*" 'netsteer\.game\.' "$FILES/usr/bin/netsteer-doctor"
has "doctor 正确读 netsteer.qos.device" 'netsteer\.qos\.device' "$FILES/usr/bin/netsteer-doctor"
has "doctor 检测 packet_steering 冲突" 'packet_steering' "$FILES/usr/bin/netsteer-doctor"
nhas "bulk_off 不再 while 循环逐条 del_list" 'while \[ -n "\$\(devices_get\)" \]' "$FILES/usr/bin/netsteer-bulk"
has "bench bg 增加单实例锁" '\.bench\.lock' "$FILES/usr/bin/netsteer-bench"
has "init.d 幂等挂载 netsteer-check cron" '/usr/bin/netsteer-check' "$FILES/etc/init.d/netsteer"
has "init.d disable 清理 cron" '^disable\(\)' "$FILES/etc/init.d/netsteer"
has "ACL 包含 netsteer-check" '/usr/bin/netsteer-check' "$FILES/usr/share/rpcd/acl.d/luci-app-netsteer.json"

# ---- 8. build-apk.sh root 属主保障 + 99-netsteer 权限 ----
has "build-apk.sh 赋予 99-netsteer 755" '99-netsteer' "$ROOT/scripts/build-apk.sh"
has "build-apk.sh 使用 unshare -r 归零属主" 'unshare -r' "$ROOT/scripts/build-apk.sh"
has "build-apk.sh 校验证明包内仅 root 属主" 'adbdump' "$ROOT/scripts/build-apk.sh"

echo "# pass $pass  fail $fail"
[ "$fail" -eq 0 ]
