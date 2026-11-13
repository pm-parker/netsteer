#!/bin/sh
# netsteer-bulk 单测 (v1.19 D22 设备级带宽仲裁) — 本地 mawk/bash 均可跑
DATA="$(cd "$(dirname "$0")/../.." && pwd)/files"
SRC="$DATA/usr/bin/netsteer-bulk"
QOS="$DATA/usr/bin/netsteer-qos"
pass=0; fail=0
eq() { [ "$2" = "$3" ] && { pass=$((pass+1)); } || { fail=$((fail+1)); echo "FAIL: $1 (got=$2 want=$3)"; }; }
has() { echo "$2" | grep -qF "$3" && { pass=$((pass+1)); } || { fail=$((fail+1)); echo "FAIL: $1 (missing: $3)"; }; }
nohas() { echo "$2" | grep -qF "$3" && { fail=$((fail+1)); echo "FAIL: $1 (unexpected: $3)"; } || { pass=$((pass+1)); }; }

# --- 提取纯函数: valid_ip / emit_rules ---
sed -n '/^valid_ip/,/^}/p' "$SRC" > /tmp/bulk_src_test.sh
sed -n '/^emit_rules/,/^}/p' "$SRC" >> /tmp/bulk_src_test.sh
echo 'TABLE=netsteer_bulk' >> /tmp/bulk_src_test.sh
. /tmp/bulk_src_test.sh

# --- valid_ip 回归 (与 qos/p2p 同规) ---
eq "valid 内网" "$(valid_ip 192.168.11.175 && echo y)" "y"
eq "valid 10/8" "$(valid_ip 10.0.0.5 && echo y)" "y"
eq "valid 172.16" "$(valid_ip 172.16.0.1 && echo y)" "y"
eq "valid 172.31" "$(valid_ip 172.31.255.1 && echo y)" "y"
eq "invalid 公网" "$(valid_ip 8.8.8.8 && echo y)" ""
eq "invalid 172.32" "$(valid_ip 172.32.0.1 && echo y)" ""
eq "invalid 文本" "$(valid_ip abc && echo y)" ""
eq "invalid >255" "$(valid_ip 192.168.11.999 && echo y)" ""

# --- emit_rules: 单设备 ---
R1="$(emit_rules '192.168.11.175' 'pppoe-wan')"
has "单设备 表名" "$R1" "table inet netsteer_bulk"
has "单设备 上行" "$R1" 'ip saddr 192.168.11.175 ip dscp set cs1'
has "单设备 下行" "$R1" 'ip daddr 192.168.11.175 ip dscp set cs1'
has "上行钩子" "$R1" "hook forward priority -140"
# ingress 链必须带 device: 内核 NFTA_HOOK_DEV 必填, 缺了整表加载失败 (EOPNOTSUPP)
has "下行钩子" "$R1" 'hook ingress device "pppoe-wan" priority -440'
has "counter" "$R1" "counter"

# --- emit_rules: 多设备 ---
R2="$(emit_rules '192.168.11.175 192.168.11.178' 'eth1')"
eq "多设备 上行规则数" "$(echo "$R2" | grep -c 'saddr.*set cs1')" "2"
eq "多设备 下行规则数" "$(echo "$R2" | grep -c 'daddr.*set cs1')" "2"
has "多设备 ingress 绑 eth1" "$R2" 'hook ingress device "eth1"'
nohas "多设备 无残留 pppoe" "$R2" 'pppoe-wan'

# --- emit_rules: 空列表 (防御: write_rules 空表已短路, emit 仍应产出合法空链) ---
R3="$(emit_rules '' 'pppoe-wan')"
eq "空列表 无上行规则" "$(echo "$R3" | grep -c 'set cs1')" "0"

# --- suggest 的 awk 聚合逻辑 (从 qos 提取关键字段对齐, tab 流直测同构副本) ---
cat > /tmp/bulk_sugg.awk <<'AWKEOF'
BEGIN { th = th_mb * 1024 * 1024 }
{
	if ($3 == "" || $6 == "" || $6 + 0 <= 0) next
	ip = $3
	managed = 0
	n = split(ex, a, /[ \t]+/)
	for (k = 1; k <= n; k++) if (a[k] == ip) managed = 1
	if (game_on == "1" && game_ip == ip) managed = 1
	n = split(bulk, b, /[ \t]+/)
	for (k = 1; k <= n; k++) if (b[k] == ip) managed = 1
	if (managed) next
	up[ip] += $6 + 0
	conns[ip]++
}
END {
	n = 0
	for (ip in up) {
		if (up[ip] < th && conns[ip] < 8) continue
		ips[n] = ip; ups[n] = up[ip] + 0; n++
	}
	for (i = 1; i < n; i++) {
		v = ups[i]; p = ips[i]; j = i - 1
		while (j >= 0 && ups[j] < v) { ups[j+1] = ups[j]; ips[j+1] = ips[j]; j-- }
		ups[j+1] = v; ips[j+1] = p
	}
	printf "["
	for (i = 0; i < n; i++) {
		if (i > 0) printf ","
		printf "{\"ip\":\"%s\",\"up_mb\":%.1f,\"conns\":%d}", ips[i], ups[i] / 1048576, conns[ips[i]]
	}
	printf "]\n"
}
AWKEOF
# 脚本侧 suggest awk 存在性 (副本漂移防线: 关键断言字段必须在 qos 源码里)
for TOKEN in 'conns\[ip\]++' 'up\[ip\] < th && conns\[ip\] < 8' 'ips\[n\] = ip'; do
	has "qos suggest awk 含 $TOKEN" "$(grep -c "$TOKEN" "$QOS")" "1"
done
# 用 tab 流直接测 awk 逻辑 (与脚本同构副本)
TAB='104857600	tcp	192.168.11.175	1.2.3.4	20000	104857600
2048	tcp	192.168.11.175	1.2.3.4	20001	2048
5242880	tcp	192.168.11.180	5.6.7.8	443	524288
1024	udp	192.168.11.183	9.9.9.9	443	1024
99999999	tcp	192.168.11.178	7.7.7.7	20000	99999999'
OUT=$(echo "$TAB" | awk -v th_mb=16 -v ex="" -v game_on=0 -v game_ip="" -v bulk="" -f /tmp/bulk_sugg.awk)
# .175 上行 100MB+2KB → 命中; .178 95MB → 命中; .180 0.5MB+5MB下行 → 阈值下排除; .183 排除
has "suggest 命中 .175" "$OUT" '192.168.11.175'
has "suggest 命中 .178" "$OUT" '192.168.11.178'
nohas "suggest 排除低流量 .180" "$OUT" '192.168.11.180'
nohas "suggest 排除 .183" "$OUT" '192.168.11.183'
eq "suggest 排序 .175 在前" "$(echo "$OUT" | grep -o '192.168.11.175\|192.168.11.178' | head -1)" "192.168.11.175"
# 排除表生效
OUT2=$(echo "$TAB" | awk -v th_mb=16 -v ex="192.168.11.175" -v game_on=0 -v game_ip="" -v bulk="192.168.11.178" -f /tmp/bulk_sugg.awk)
nohas "suggest 已管理不重复建议 .175" "$OUT2" '192.168.11.175'
nohas "suggest bulk 已管理不重复建议 .178" "$OUT2" '192.168.11.178'
# 游戏通道互斥显示
OUT3=$(echo "$TAB" | awk -v th_mb=16 -v ex="" -v game_on=1 -v game_ip="192.168.11.175" -v bulk="" -f /tmp/bulk_sugg.awk)
nohas "suggest game 互斥剔除" "$OUT3" '192.168.11.175'

# --- migrate 扫描逻辑 (fixture: 符号名 + 数值 8 两种手工写法) ---
mkdir -p /tmp/bulk_mig_test/nftables.d
cat > /tmp/bulk_mig_test/nftables.d/20-wangxin-bulk.nft <<'EOF'
chain mangle_wangxin_bulk {
	type filter hook prerouting priority mangle + 10; policy accept;
	ip saddr 192.168.11.175 ip dscp set 8 counter comment "wangxin-uplink CS1 bulk"
}
EOF
cat > /tmp/bulk_mig_test/nftables.d/21-sym.nft <<'EOF'
ip saddr 192.168.11.180 ip dscp set cs1 counter comment "sym"
ip saddr 192.168.11.181 ip dscp set 80 counter comment "not-bulk-80"
EOF
echo "unrelated" > /tmp/bulk_mig_test/nftables.d/10-other.nft
FOUND=$(grep -lE 'dscp set (cs1|8)( |$)' /tmp/bulk_mig_test/nftables.d/*.nft 2>/dev/null | wc -l | tr -d ' ')
eq "migrate 发现 fixture 文件" "$FOUND" "2"
IPS=$(grep -hoE 'ip saddr [0-9.]+' /tmp/bulk_mig_test/nftables.d/20-wangxin-bulk.nft /tmp/bulk_mig_test/nftables.d/21-sym.nft | awk '{print $3}')
eq "migrate 提取数值形 IP" "$(echo "$IPS" | head -1)" "192.168.11.175"
eq "migrate 提取符号形 IP" "$(echo "$IPS" | grep -c 192.168.11.180)" "1"
# 纯 set 80 (非 CS1) 文件不应被 migrate 命中
echo 'ip saddr 192.168.11.181 ip dscp set 80 counter' > /tmp/bulk_mig_test/nftables.d/22-only80.nft
ONLY=$(grep -lE 'dscp set (cs1|8)( |$)' /tmp/bulk_mig_test/nftables.d/22-only80.nft 2>/dev/null | wc -l | tr -d ' ')
eq "migrate 不命中纯 set80" "$ONLY" "0"

rm -rf /tmp/bulk_mig_test /tmp/bulk_src_test.sh /tmp/bulk_sugg.awk /tmp/bulk_sugg_pure.sh /tmp/bulk_suggest_test.sh
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
