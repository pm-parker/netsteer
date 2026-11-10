#!/bin/sh
# qos-awk.test.sh — netsteer-qos dnslog awk 采样器偏移回归测试
# 背景: v1.16.0 实检发现 upload/download substr 偏移差 1 丢首位数字 (up=123456 采成 23456),
# host/sniffHost 靠 gsub 洗引号侥幸掩盖。本测试把 awk 程序从脚本中抽出, 喂已知 fixture 验证精确截断。
# 用法: sh tests/unit/qos-awk.test.sh   (依赖: sh, awk, python3 — 与 feed.test.sh 同口径)
set -u
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QOS="$HERE/../../files/usr/bin/netsteer-qos"

pass=0; fail=0
ok()  { pass=$((pass+1)); echo "PASS: $1"; }
bad() { fail=$((fail+1)); echo "FAIL: $1"; }

# 1) 抽出 qos_dnslog_mihomo 的 awk 程序 (函数体内单引号包裹段; python3 抽取, 剥一层缩进)
AWK=$(python3 - "$QOS" <<'PYEOF'
import sys, re
src = open(sys.argv[1]).read()
m = re.search(r"qos_dnslog_mihomo\(\) \{.*?awk '(.*?)'\n\}", src, re.S)
if not m:
    sys.exit(1)
block = m.group(1)
lines = [ln[1:] if ln.startswith('\t') else ln for ln in block.split('\n')]
print('\n'.join(lines))
PYEOF
) || { echo "FAIL: cannot extract awk program from $QOS"; exit 1; }
[ -n "$AWK" ] || { echo "FAIL: awk program empty"; exit 1; }

# 2) fixture: 已知值连接 (字段顺序贴近 mihomo 真实 JSON)
FIXTURE='{"id":"a","upload":123456,"download":78901,"network":"tcp","sniffHost":"api.example.com","destinationIP":"1.2.3.4","destinationPort":"443","sourceIP":"192.168.11.123","metadata":{"host":"api.example.com"}}'
OUT=$(printf '%s\n' "$FIXTURE" | awk "$AWK")

# 3) 断言: u/v 精确 (无丢位/无前导零), q 域名无冒号前缀/无引号残留
echo "$OUT" | grep -q '"u":"123456"' && ok "upload 无丢位 (123456)" || bad "upload 截断错误: $(echo "$OUT" | grep -o '"u":"[0-9]*"')"
echo "$OUT" | grep -q '"v":"78901"'  && ok "download 无丢位 (78901)" || bad "download 截断错误: $(echo "$OUT" | grep -o '"v":"[0-9]*"')"
echo "$OUT" | grep -q '"q":"api.example.com"' && ok "sniffHost 域名精确 (无冒号/引号残留)" || bad "sniffHost 截断错误: $(echo "$OUT" | grep -o '"q":"[^"]*"')"
echo "$OUT" | grep -q '"t":"tcp"' && ok "network 正常" || bad "network 截断错误"
echo "$OUT" | grep -q '"p":"443"' && ok "destinationPort 正常" || bad "destinationPort 截断错误"

# 4) host 回退路径 (无 sniffHost 时用 metadata.host) — mihomo 真实结构 host 在 metadata 内
FIXTURE2='{"id":"b","upload":15,"download":0,"network":"udp","sourceIP":"10.0.0.5","metadata":{"host":"fallback.example"}}'
OUT2=$(printf '%s\n' "$FIXTURE2" | awk "$AWK")
echo "$OUT2" | grep -q '"q":"fallback.example"' && ok "host 回退路径精确" || bad "host 回退截断错误: $(echo "$OUT2" | grep -o '"q":"[^"]*"')"
echo "$OUT2" | grep -q '"u":"15"' && ok "小数值 upload 精确 (15, 无前导零)" || bad "小数值 upload 错误: $(echo "$OUT2" | grep -o '"u":"[0-9]*"')"

# 5) 零值与多元素 (逗号分隔合法 JSON)
FIXTURE3='{"id":"c","upload":0,"download":0,"network":"tcp","sourceIP":"192.168.11.9","metadata":{"host":"zero.example"}}'
OUT3=$(printf '%s\n%s\n' "$FIXTURE" "$FIXTURE3" | awk "$AWK")
N=$(printf '%s' "$OUT3" | grep -o '"q":' | wc -l)
[ "$N" = "2" ] && ok "多元素逗号分隔 (2 条)" || bad "多元素输出异常: $OUT3"
echo "$OUT3" | grep -q '"u":"0","v":"0"' && ok "零值 upload/download 精确" || bad "零值错误"

echo "PASS=$pass FAIL=$fail"
[ "$fail" = 0 ]
