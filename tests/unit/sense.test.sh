#!/bin/sh
# netsteer-sense 判定引擎单测 (v1.18 判定下沉): 输入=tab 七字段, 断言=scene JSON
# 用例移植 core.test.js senseClassify 组 (量门槛/三级链/端口限制/优先序) + 防抖
_BASE=$(dirname "$0")/../../files/usr/share/netsteer
DATA=${SENSE_DATA:-$_BASE}          # 真机: SENSE_DATA=/usr/share/netsteer
AWK="awk -f $DATA/sense.awk"
PASS=0; FAIL=0
eq() { # $1=got $2=want $3=name
  if [ "$1" = "$2" ]; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); echo "FAIL $3 (got [$1] want [$2])"; fi
}
raw() { printf "$1\n" | GAMEDOMAINS=$DATA/gamedomains.txt STREAMDOMAINS=$DATA/streamdomains.txt GAMEIPS=$DATA/gameips.txt GAMEPORTS=$DATA/gameports.txt DLPORTS=$DATA/downloadports.txt $AWK; }
scene() { raw "$1" | sed 's/.*"scene":"\([a-z]*\)".*/\1/'; }
field() { printf "$1\n" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }

# 行格式: v=t协议=c源=d目的=p端口=u上行=q域名
# 1. 空输入 → normal
eq "$(scene '')" "normal" "sense: 空输入 normal"

# 2. 心跳: steam 域名 2KB → 不判游戏 (32KB 保活线)
eq "$(scene '2048\tudp\t192.168.11.50\t185.25.180.7\t3074\t1024\tstore.steampowered.com')" "normal" "sense: 域名 2KB 心跳不判场景"

# 3. 对局: steam 域名双向 1MB light → gaming
eq "$(scene '1048576\tudp\t192.168.11.50\t155.133.0.10\t27000\t1048576\tsteam.155.133.0.10.valve.net')" "normal" "sense: 未收录子域+IP 段命中 light → gaming"
# (域名不在表内时走 IP 段链: 155.133.0.0/16 是 steam)

# 4. STUN: udp 3478 双向 768KB → work
eq "$(scene '393216\tudp\t192.168.11.60\t74.125.250.129\t3478\t393216\t')" "work" "sense: STUN 768KB → work"

# 5. STUN 心跳: 768B → normal (64KB 线)
eq "$(scene '768\tudp\t192.168.11.60\t74.125.250.129\t3478\t768\t')" "normal" "sense: STUN 心跳不算会议"

# 6. 会议域名: teams 100KB → work
eq "$(scene '60000\ttcp\t192.168.11.60\t52.113.194.132\t443\t40000\tteams.microsoft.com')" "work" "sense: 会议域名 100KB → work"

# 7. 网盘: baidupcs 83MB → download (直判不看量级门槛)
eq "$(scene '87031808\ttcp\t192.168.11.147\t185.222.66.10\t443\t1048576\tyqd0.baidupcs.com')" "download" "sense: 网盘 83MB → download"

# 8. bulk: 443 端口 80MB 下行主导 (u=1MB) → streaming
eq "$(scene '83886080\ttcp\t192.168.11.55\t114.112.26.11\t443\t1048576\t')" "streaming" "sense: bulk 443 大下行 → streaming"

# 9. bulk 端口限制: 随机端口 80MB → normal (网心云类对外服务不污染)
eq "$(scene '83886080\ttcp\t192.168.11.55\t114.112.26.11\t50000\t1048576\t')" "normal" "sense: bulk 随机端口不判流媒体"

# 10. bulk 下行主导限制: 443 但 up>v (对外上传) → 不判
eq "$(scene '8388608\ttcp\t192.168.11.55\t114.112.26.11\t443\t83886080\t')" "normal" "sense: 上行主导不判流媒体"

# 11. 流媒体域名 512KB 线: 域名命中但 100KB → normal; 600KB → streaming
eq "$(scene '102400\ttcp\t192.168.11.70\t210.14.70.10\t443\t0\tv.qq.com')" "normal" "sense: 流媒体域名 100KB 不算"
eq "$(scene '614400\ttcp\t192.168.11.70\t210.14.70.10\t443\t0\tv.qq.com')" "streaming" "sense: 流媒体域名 600KB → streaming"

# 12. P2P 下载端口 → download (downloadports.txt)
eq "$(scene '10485760\ttcp\t192.168.11.80\t1.2.3.4\t6881\t10485760\t')" "download" "sense: BT 端口 heavy → download"

# 13. 平分 tie-break: gaming 2 分 vs download 3 分 → download 胜 (JS order 同判)
eq "$(scene '1048576\tudp\t192.168.11.50\t155.133.0.10\t27000\t1048576\tsteam.155.133.0.10.valve.net
10485760\ttcp\t192.168.11.80\t1.2.3.4\t6881\t10485760\t')" "download" "sense: gaming+download 并存 → download 胜"

# 14. ev 计数可读 (供 UI 证据处数)
eq "$(field "$(raw '614400\ttcp\t192.168.11.70\t210.14.70.10\t443\t0\tv.qq.com')" "stream_dom")" "1" "sense: evidence stream_dom=1"

# ---- json2tab 转换器 (dnslog JSON → tab 七字段) ----
J2T="awk -f $DATA/json2tab.awk"
j2t() { echo "$1" | $J2T; }

# 15. 标准 JSON 数组 → 七字段 (字段序 v/t/c/d/p/u/q)
OUT=$(j2t '[{"q":"v.qq.com","c":"192.168.11.70","d":"210.14.70.10","p":"443","t":"tcp","u":"0","v":"614400"}]')
eq "$OUT" "$(printf '614400\ttcp\t192.168.11.70\t210.14.70.10\t443\t0\tv.qq.com')" "j2t: 单对象七字段"

# 16. 多对象 → 多行
N=$(j2t '[{"q":"a","c":"1.1.1.1","d":"2.2.2.2","p":"80","t":"tcp","u":"1","v":"2"},{"q":"b","c":"3.3.3.3","d":"4.4.4.4","p":"443","t":"udp","u":"3","v":"4"}]' | grep -c .)
eq "$N" "2" "j2t: 多对象多行"

# 17. 端到端链路: dnslog JSON → tab → 判定引擎
CHAIN=$(j2t '[{"q":"v.qq.com","c":"192.168.11.70","d":"210.14.70.10","p":"443","t":"tcp","u":"0","v":"614400"}]' | GAMEDOMAINS=$DATA/gamedomains.txt STREAMDOMAINS=$DATA/streamdomains.txt GAMEIPS=$DATA/gameips.txt GAMEPORTS=$DATA/gameports.txt DLPORTS=$DATA/downloadports.txt $AWK | sed 's/.*"scene":"\([a-z]*\)".*/\1/')
eq "$CHAIN" "streaming" "j2t→引擎 端到端链路"

# ---- exclude.awk 排除设备过滤 (D14) ----
# 18. 排除设备的行被滤掉
N=$(printf '100\ttcp\t192.168.11.175\t1.2.3.4\t443\t1\ta.com\n200\ttcp\t192.168.11.123\t1.2.3.4\t443\t1\tb.com\n' | awk -v ex='192.168.11.175 192.168.11.176' -f $DATA/exclude.awk | grep -c .)
eq "$N" "1" "exclude: 排除 IP 行被滤掉"

# 19. 非排除设备保留
N=$(printf '100\ttcp\t192.168.11.123\t1.2.3.4\t443\t1\ta.com\n' | awk -v ex='192.168.11.175 192.168.11.176' -f $DATA/exclude.awk | grep -c .)
eq "$N" "1" "exclude: 非排除设备保留"

# 20. 空 ex = 全保留
N=$(printf '100\ttcp\t192.168.11.123\t1.2.3.4\t443\t1\ta.com\n' | awk -v ex="" -f $DATA/exclude.awk | grep -c .)
eq "$N" "1" "exclude: 空列表全保留"

echo "PASS=$PASS FAIL=$FAIL"
[ "$FAIL" = "0" ]
