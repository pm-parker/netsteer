#!/bin/bash
# 负载极限段: 16 线程 × 1GB range × 30s 硬窗口 + 并发 ping (全程真实满载)
set -u
SIDE="$1"
URL="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso"
TD=$(mktemp -d)
OUT="/tmp/bench_load_${SIDE}.json"

for i in $(seq 1 16); do
  START=$(( (i * 150) * 1000000 ))
  END=$(( START + 1000000000 ))
  ( curl -s -o /dev/null -w "%{speed_download} %{size_download}\n" -m 30 -r ${START}-${END} "$URL" > "$TD/spd_$i.txt" 2>&1 ) &
done
sleep 1
ping -i 0.5 -c 56 223.5.5.5 2>/dev/null | awk -F'time=' '/time=/{gsub(/ ms/,"",$2); print $2}' | sort -n > "$TD/load_rtts.txt"
wait

TOTAL_BPS=$(awk '{s+=$1} END{printf "%.0f", s}' "$TD"/spd_*.txt)
TOTAL_BYTES=$(awk '{s+=$2} END{printf "%.0f", s}' "$TD"/spd_*.txt)
N=$(wc -l < "$TD/load_rtts.txt")
LOAD_AVG=$(awk -v n=$N '{s+=$1; if(NR<=n*0.5) m50=$1} END{printf "%.2f", s/NR}' "$TD/load_rtts.txt")
LOAD_P50=$(awk -v n=$N '{a[NR]=$1} END{print a[int(NR*0.5)]}' "$TD/load_rtts.txt")
LOAD_P99=$(awk -v n=$N '{a[NR]=$1} END{print a[int(NR*0.99)]}' "$TD/load_rtts.txt")
LOAD_MAX=$(tail -1 "$TD/load_rtts.txt")

cat > "$OUT" <<EOF
{
  "side": "$SIDE",
  "load_throughput_mbps": $(echo "$TOTAL_BPS" | awk '{printf "%.1f", $1*8/1000000}'),
  "total_gb": $(echo "$TOTAL_BYTES" | awk '{printf "%.2f", $1/1000000000}'),
  "ping_samples": $N,
  "load_avg_ms": $LOAD_AVG,
  "load_p50_ms": ${LOAD_P50:-0},
  "load_p99_ms": ${LOAD_P99:-0},
  "load_max_ms": ${LOAD_MAX:-0}
}
EOF
cat "$OUT"; rm -rf "$TD"
