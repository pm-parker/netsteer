#!/bin/sh
# netsteer-snapshot 单测 (v1.22.1: 快照/回滚 + 持久审计, 静态断言模式 — CI 无 uci 环境可跑)
DATA="$(cd "$(dirname "$0")/../.." && pwd)/files"
SRC="$DATA/usr/bin/netsteer-snapshot"
MODE="$DATA/usr/bin/netsteer-mode"
QOS="$DATA/usr/bin/netsteer-qos"
WIZ="$DATA/usr/bin/netsteer-wizard"
BULK="$DATA/usr/bin/netsteer-bulk"
CHK="$DATA/usr/bin/netsteer-check"
AUD="$DATA/usr/bin/netsteer-audit"
JS="$DATA/www/luci-static/resources/view/netsteer.js"
ACL="$DATA/usr/share/rpcd/acl.d/luci-app-netsteer.json"
pass=0; fail=0
ok()   { pass=$((pass+1)); printf 'ok %d - %s\n' "$pass" "$1"; }
nok()  { fail=$((fail+1)); printf 'not ok %d - %s\n' "$fail" "$1"; }
eq()   { if [ "$2" = "$3" ]; then ok "$1"; else nok "$1 (期望 '$3' 实得 '$2')"; fi; }
has()  { if grep -q "$2" "$3" 2>/dev/null; then ok "$1"; else nok "$1 (未找到: $2)"; fi; }
nhas() { if grep -q "$2" "$3" 2>/dev/null; then nok "$1 (不该出现: $2)"; else ok "$1"; fi; }

# --- 存在 + 语法 ---
[ -f "$SRC" ] && ok "netsteer-snapshot 存在" || nok "netsteer-snapshot 缺失"
sh -n "$SRC" && ok "语法正确" || nok "语法错误"

# --- 子命令齐全 ---
has "save 子命令" "save)" "$SRC"
has "auto 子命令 (去重)" "auto)" "$SRC"
has "list 子命令" "list)" "$SRC"
has "history 子命令" "history)" "$SRC"
has "restore 子命令" "restore)" "$SRC"

# --- auto 去重: 5 分钟同 label ---
has "auto 去重窗口 300s" "DEDUP=300" "$SRC"

# --- 安全设计 ---
has "restore 前自动快照 pre-restore (回滚可回滚)" "pre-restore" "$SRC"
has "restore 兜底备份 /etc/config" "pre-restore 2>/dev/null" "$SRC"
has "不整包恢复 firewall (只 set offloading)" "flow_offloading" "$SRC"
nhas "不整包 import firewall" "import firewall" "$SRC"
has "恢复后重跑 apply 对齐运行态" "netsteer-apply" "$SRC"
has "持久 history 滚动 (2000/800)" "tail -800" "$SRC"
has "保留上限 KEEP=20" "KEEP=20" "$SRC"

# --- 四通道挂载 (只读分支必须跳过) ---
has "mode 挂载 auto 快照" "netsteer-snapshot auto \"mode-" "$MODE"
has "mode 只读分支跳过 (list|status)" "list|status" "$MODE"
has "qos 挂载 (on|off|device|reapply)" "qos-\$1" "$QOS"
has "wizard 挂载 (apply)" "wizard-apply" "$WIZ"
has "bulk 挂载 (add|remove|off|reapply)" "bulk-\$1" "$BULK"

# --- check 持久双写 ---
has "check 变更双写到 /etc/netsteer/history.log" "/etc/netsteer/history.log" "$CHK"

# --- audit 透传 ---
has "audit snapshots 字段" "snapshots" "$AUD"

# --- UI ---
has "快照卡在专家页" "renderSnapshotCard" "$JS"
has "回滚按钮" "ns-snap-restore" "$JS"
has "确认弹窗 (不可误点)" "确认回滚" "$JS"
has "时间线展示" "ns-snap-history" "$JS"

# --- ACL ---
has "rpcd 白名单加 snapshot" "netsteer-snapshot" "$ACL"

echo "# pass $pass  fail $fail"
[ "$fail" -eq 0 ]
