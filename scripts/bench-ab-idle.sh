#!/bin/bash
# netsteer A/B 极限压测 — 在沙箱执行 (流量真实穿 R5C NAT 转发路径)
# 用法: bench_ab.sh <off|on>  → 输出 JSON 到 /tmp/bench_<side>.json
set -u
SIDE="$1"
URL="https://mirrors.tuna.tsinghua.edu.cn/ubuntu-releases/24.04/ubuntu-24.04.3-live-server-amd64.iso"
PING_TARGET="223.5.5.5"
OUT="/tmp/bench_${SIDE}.json"
TD=$(mktemp -d)

# --- 1) 空载延迟: 60 包 @0.2s ---
ping -i 0.2 -c 60 -q $PING_TARGET > "$TD/idle_ping.txt" 2>&1
IDLE=$(awk -F'/' '/rtt|round-trip/{printf "%.2f %.2f %.2f", $5, $6, $7}' "$TD/idle_ping.txt")
IDLE_AVG=$(echo $IDLE | awk '{print $1}'); IDLE_MAX=$(echo $IDLE | awk '{print $2}'); IDLE_MDEV=$(echo $IDLE | awk '{print $3}')
IDLE_P99=$(awk -F'time=' '/time=/{gsub(/ ms/,"",$2); print $2}' <(ping -i 0.2 -c 60 $PING_TARGET 2>/dev/null) | sort -n | awk '{a[NR]=$1} END{print a[int(NR*0.99)]}')

# --- 2) 极限负载: 16 线程下载 30s + 并发 ping 50 包 ---
for i in $(seq 1 16); do
  START=$((i * 100000000))
  END=$((START + 99999999))
  ( curl -s -o /dev/null -w "%{speed_download}\n" -m 30 -r ${START}-${END} "$URL" > "$TD/spd_$i.txt" 2>&1 ) &
done
CURL_PIDS=$!
sleep 1
ping -i 0.5 -c 50 $PING_TARGET 2>/dev/null | awk -F'time=' '/time=/{gsub(/ ms/,"",$2); print $2}' | sort -n > "$TD/load_rtts.txt"
wait
TOTAL_BPS=$(cat "$TD"/spd_*.txt | awk '{s+=$1} END{printf "%.0f", s}')
LOAD_AVG=$(awk '{s+=$1} END{printf "%.2f", s/NR}' "$TD/load_rtts.txt")
LOAD_P99=$(awk '{a[NR]=$1} END{print a[int(NR*0.99)]}' "$TD/load_rtts.txt")
LOAD_MAX=$(tail -1 "$TD/load_rtts.txt")
LOAD_LOSS=$(grep -c 'timeout\|unreachable' <(ping -i 0.5 -c 50 $PING_TARGET 2>&1) || true)

cat > "$OUT" <<EOF
{
  "side": "$SIDE",
  "idle_avg_ms": $IDLE_AVG,
  "idle_max_ms": $IDLE_MAX,
  "idle_mdev_ms": $IDLE_MDEV,
  "idle_p99_ms": ${IDLE_P99:-0},
  "load_throughput_bps": $TOTAL_BPS,
  "load_throughput_mbps": $(echo "$TOTAL_BPS" | awk '{printf "%.1f", $1*8/1000000}'),
  "load_avg_ms": $LOAD_AVG,
  "load_p99_ms": ${LOAD_P99:-0},
  "load_max_ms": ${LOAD_MAX:-0},
  "ts": $(date +%s)
}
EOF
cat "$OUT"
rm -rf "$TD"
