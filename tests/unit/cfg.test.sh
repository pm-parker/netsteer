#!/bin/sh
# netsteer-cfg / 自动切换交互 单测 (v1.19.1: uci.apply 坏通道修复 + 开关交互统一)
DATA="$(cd "$(dirname "$0")/../.." && pwd)/files"
SRC="$DATA/usr/bin/netsteer-cfg"
JS="$DATA/www/luci-static/resources/view/netsteer.js"
pass=0; fail=0
ok()   { pass=$((pass+1)); printf 'ok %d - %s\n' "$pass" "$1"; }
nok()  { fail=$((fail+1)); printf 'not ok %d - %s\n' "$fail" "$1"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (期望 '$3' 实得 '$2')"; fi; }
has()  { if grep -q "$2" "$3" 2>/dev/null; then ok "$1"; else nok "$1 (未找到: $2)"; fi; }
nhas() { if grep -q "$2" "$3" 2>/dev/null; then nok "$1 (不该出现: $2)"; else ok "$1"; fi; }

# --- netsteer-cfg: 脚本存在 + 语法 ---
[ -f "$SRC" ] && ok "netsteer-cfg 存在" || nok "netsteer-cfg 缺失"
sh -n "$SRC" 2>/dev/null && ok "netsteer-cfg 语法正确" || nok "netsteer-cfg 语法错误"

# --- rpcd PATH 环境防线: uci 必须绝对路径 (rpcd exec 的 PATH 不含 /sbin) ---
has "uci 用绝对路径 (rpcd exec 兼容)" "UCI=/sbin/uci" "$SRC"
has "uci 绝对路径兜底探测" "/usr/sbin/uci" "$SRC"
has "set 分支用 \"\$UCI\"" "\"\$UCI\" set" "$SRC"
has "commit 分支用 \"\$UCI\"" "\"\$UCI\" commit netsteer" "$SRC"
nhas "不再有裸 uci set 调用 (会吃 rpcd PATH 坑)" "&& uci set" "$SRC"
nhas "前端不再调 ubus uci.apply" "ubusCall('uci', 'apply'" "$JS"
nhas "前端不再调 ubus uci.set" "ubusCall('uci', 'set'" "$JS"
nhas "前端不再调 ubus uci.commit" "ubusCall('uci', 'commit'" "$JS"
has "前端有 cfgSet 统一入口" "function cfgSet(section, values)" "$JS"

# --- v1.19.1 IA: 自动切换并入智能模式 (删独立卡, 默认开启) ---
nhas "独立自动切换卡已删除" "renderLinkedCard" "$JS"
nhas "paintLinked 已删除" "paintLinked" "$JS"
nhas "条件 null 不再进 E() 数组 (null 文字 bug)" "? null : E(" "$JS"
has "场景卡带联动说明" "检测到看视频 / 打游戏时，自动切换到更合适的模式" "$JS"
has "联动默认开启 (后端缺省 1)" "qos_get sense_linked 1" "$DATA/usr/bin/netsteer-qos"
has "总开关 off 时联动不接管" "\[ \"\$cur\" = \"off\" \] && return 0" "$DATA/usr/bin/netsteer-qos"
nhas "off 不在接管列表 (防拉起)" "standard|latency|off|" "$DATA/usr/bin/netsteer-qos"

printf '1..%d\n' $((pass+fail))
echo "# pass $pass  fail $fail"
[ "$fail" -eq 0 ]
