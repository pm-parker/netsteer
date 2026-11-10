#!/bin/sh
# netsteer-tune 单测 (D20 参数自适应公式) — 本地 mawk/bash 均可跑
DATA="$(cd "$(dirname "$0")/../.." && pwd)/files"
SRC="$DATA/usr/bin/netsteer-tune"
pass=0; fail=0
eq() { [ "$2" = "$3" ] && { pass=$((pass+1)); } || { fail=$((fail+1)); echo "FAIL: $1 (got=$2 want=$3)"; }; }

# 提取纯公式函数 (clampi/mem_mb/ncpu/tier_params), mem_mb/ncpu 由测试桩覆盖
source_funcs() {
	sed -n "/^clampi/,/^}/p; /^mem_mb/,/^}/p; /^ncpu()/,/^}/p; /^tier_params/,/^}/p" "$SRC" > /tmp/tune_src_test.sh 2>/dev/null
	. /tmp/tune_src_test.sh
}
source_funcs

# --- 公式抽验 (固定 mem 桩) ---
mem_mb() { echo 128; }
set -- $(tier_params T1)
eq "128MB T1 max" "$1" "65536"
eq "128MB T1 buckets" "$2" "16384"
eq "128MB T1 rfs" "$3" "32768"
eq "128MB T1 interval" "$4" "30"

mem_mb() { echo 512; }
set -- $(tier_params T0)
eq "512MB T0 顶格" "$1" "262144"
eq "512MB T0 buckets" "$2" "65536"

mem_mb() { echo 32; }
set -- $(tier_params T0)
eq "32MB T0 下限" "$1" "16384"

mem_mb() { echo 64; }
set -- $(tier_params T2)
eq "64MB T2 max" "$1" "32768"
eq "64MB T2 rfs" "$3" "65536"
eq "64MB T2 interval" "$4" "20"

mem_mb() { echo 256; }
set -- $(tier_params T1)
eq "256MB T1 max" "$1" "131072"

# clamp 纯函数
eq "clampi 低夹" "$(clampi 5 10 100)" "10"
eq "clampi 高夹" "$(clampi 500 10 100)" "100"
eq "clampi 非数字" "$(clampi abc 10 100)" "10"
eq "clampi 正常" "$(clampi 50 10 100)" "50"

rm -f /tmp/tune_src_test.sh
echo "PASS=$pass FAIL=$fail"
[ "$fail" -eq 0 ]
