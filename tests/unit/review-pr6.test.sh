#!/bin/sh
# PR6 审查回归: 打包 root 回退、packet_steering 原值、init enable/disable cron、SQM 空项只在开启时补齐。
set -u
ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
WORK="$(mktemp -d)"
pass=0; fail=0
ok() { pass=$((pass + 1)); printf 'ok %d - %s\n' "$pass" "$1"; }
nok() { fail=$((fail + 1)); printf 'not ok - %s\n' "$1"; }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# ---------- 1. 非 root 且 unshare -r 不可用时走 sudo, 两条路都失败才 fail ----------
mkdir -p "$WORK/bin" "$WORK/nobin"
cat > "$WORK/bin/unshare" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 755 "$WORK/bin/unshare"
cat > "$WORK/bin/sudo" <<'EOF'
#!/bin/sh
# 测试桩: sudo -n true 成功, 其它命令原样执行
if [ "$1" = "-n" ]; then shift; fi
[ "$1" = "true" ] && exit 0
"$@"
EOF
chmod 755 "$WORK/bin/sudo"

OUT=$(PATH="$WORK/bin:$PATH" NS_PRINT_ROOT_RUNNER=1 "$ROOT/scripts/build-apk.sh" 2>&1) && RC=0 || RC=$?
printf '%s\n' "$OUT" | grep -qx 'sudo' && ok "unshare 失败时选择 sudo" || nok "unshare 失败时应选择 sudo (rc=$RC out=$OUT)"

cat > "$WORK/nobin/unshare" <<'EOF'
#!/bin/sh
exit 1
EOF
cat > "$WORK/nobin/sudo" <<'EOF'
#!/bin/sh
exit 1
EOF
chmod 755 "$WORK/nobin/unshare" "$WORK/nobin/sudo"
OUT=$(PATH="$WORK/nobin:/usr/bin:/bin" NS_PRINT_ROOT_RUNNER=1 "$ROOT/scripts/build-apk.sh" 2>&1) && RC=0 || RC=$?
printf '%s\n' "$OUT" | grep -qx 'fail' && [ "$RC" -ne 0 ] && ok "unshare 与 sudo 都没有时失败" || nok "无 root 手段时应 fail (rc=$RC out=$OUT)"

grep -q 'adbdump' "$ROOT/scripts/build-apk.sh" && ok "仍校验包内 root 属主" || nok "丢失 adbdump 属主门禁"
grep -q '99-netsteer' "$ROOT/scripts/build-apk.sh" && grep -q '755' "$ROOT/scripts/build-apk.sh" && ok "仍要求 hotplug 0755" || nok "丢失 hotplug 0755 门禁"

# ---------- 2. packet_steering: 开启时置 0, 关闭时按原值恢复; 重复 apply 不把 0 写成原值 ----------
export UCI_ROOT="$WORK/uci"
export NS_PS_ORIGIN="$WORK/ps.origin"
mkdir -p "$UCI_ROOT"
cat > "$WORK/bin/uci" <<'EOF'
#!/bin/sh
[ "$1" = "-q" ] && shift
cmd=$1; shift
case "$cmd" in
  get)
    [ -f "$UCI_ROOT/$1" ] || exit 1
    cat "$UCI_ROOT/$1"
    ;;
  set)
    spec=$1
    key=${spec%%=*}
    val=${spec#*=}
    val=${val#\'}; val=${val%\'}
    mkdir -p "$UCI_ROOT"
    printf '%s' "$val" > "$UCI_ROOT/$key"
    printf 'set %s\n' "$key" >> "$UCI_ROOT/.log"
    ;;
  delete)
    rm -f "$UCI_ROOT/$1"
    printf 'delete %s\n' "$1" >> "$UCI_ROOT/.log"
    ;;
  commit|show) ;;
  *) exit 1 ;;
esac
EOF
chmod 755 "$WORK/bin/uci"
export PATH="$WORK/bin:$PATH"

ps_val() {
	if [ -f "$UCI_ROOT/network.globals.packet_steering" ]; then
		cat "$UCI_ROOT/network.globals.packet_steering"
	else
		printf 'ABSENT'
	fi
}

# 原值 1
printf '1' > "$UCI_ROOT/network.globals.packet_steering"
rm -f "$NS_PS_ORIGIN"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering active >/dev/null 2>&1 || true
[ "$(ps_val)" = "0" ] && ok "开启时 packet_steering 置 0" || nok "开启后应为 0, 实际 $(ps_val)"
sed -n '2p' "$NS_PS_ORIGIN" | grep -qx '1' && ok "快照记下原值 1" || nok "快照不是原值 1: $(cat "$NS_PS_ORIGIN" 2>/dev/null)"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering active >/dev/null 2>&1 || true
sed -n '2p' "$NS_PS_ORIGIN" | grep -qx '1' && ok "重复开启不把快照改成 0" || nok "重复开启改写了快照: $(cat "$NS_PS_ORIGIN" 2>/dev/null)"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering inactive >/dev/null 2>&1 || true
[ "$(ps_val)" = "1" ] && ok "关闭后恢复原值 1" || nok "关闭后应为 1, 实际 $(ps_val)"
[ ! -f "$NS_PS_ORIGIN" ] && ok "恢复后删除快照" || nok "恢复后仍留着快照"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering inactive >/dev/null 2>&1 || true
[ "$(ps_val)" = "1" ] && ok "重复关闭保持 1" || nok "重复关闭改变了 1: $(ps_val)"

# 原本不存在
rm -f "$UCI_ROOT/network.globals.packet_steering" "$NS_PS_ORIGIN"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering active >/dev/null 2>&1 || true
[ "$(ps_val)" = "0" ] && ok "原本缺失时开启仍置 0" || nok "原本缺失开启后应为 0, 实际 $(ps_val)"
head -1 "$NS_PS_ORIGIN" | grep -qx 'absent' && ok "快照记录原本缺失" || nok "缺失未被记成 absent: $(cat "$NS_PS_ORIGIN" 2>/dev/null)"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering active >/dev/null 2>&1 || true
head -1 "$NS_PS_ORIGIN" | grep -qx 'absent' && ok "重复开启不把缺失快照改成 0" || nok "缺失快照被改写: $(cat "$NS_PS_ORIGIN" 2>/dev/null)"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering inactive >/dev/null 2>&1 || true
[ "$(ps_val)" = "ABSENT" ] && ok "关闭后回到缺失而不是留下 0" || nok "关闭后应为缺失, 实际 $(ps_val)"

# 原值就是 0
printf '0' > "$UCI_ROOT/network.globals.packet_steering"
rm -f "$NS_PS_ORIGIN"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering active >/dev/null 2>&1 || true
sed -n '2p' "$NS_PS_ORIGIN" | grep -qx '0' && ok "原值 0 也被快照且保持 0" || nok "原值 0 快照异常: $(cat "$NS_PS_ORIGIN" 2>/dev/null)"
[ "$(ps_val)" = "0" ] && ok "原值 0 开启后仍是 0" || nok "原值 0 被改成 $(ps_val)"
"$ROOT/files/usr/bin/netsteer-apply" sync-packet-steering inactive >/dev/null 2>&1 || true
[ "$(ps_val)" = "0" ] && ok "原值 0 关闭后仍是 0" || nok "原值 0 关闭后变成 $(ps_val)"

# ---------- 3. rc.common enable 会先 disable; enable 必须留下 cron, disable 必须去掉 ----------
export IPKG_INSTROOT="$WORK/root"
mkdir -p "$IPKG_INSTROOT/etc/crontabs" "$IPKG_INSTROOT/etc/rc.d" "$IPKG_INSTROOT/etc/init.d"
CRON="$IPKG_INSTROOT/etc/crontabs/root"
printf '%s\n' '0 1 * * * /usr/bin/other' > "$CRON"
cat > "$WORK/rc.common" <<EOF
#!/bin/sh
initscript=\$1
action=\${2:-}
enable() {
	disable
	name=\$(basename "\$initscript")
	[ -n "\$START" ] && ln -sfn "../init.d/\$name" "\$IPKG_INSTROOT/etc/rc.d/S\${START}\$name"
	[ -n "\$STOP" ] && ln -sfn "../init.d/\$name" "\$IPKG_INSTROOT/etc/rc.d/K\${STOP}\$name"
}
disable() {
	name=\$(basename "\$initscript")
	rm -f "\$IPKG_INSTROOT/etc/rc.d"/S[0-9][0-9]"\$name" "\$IPKG_INSTROOT/etc/rc.d"/K[0-9][0-9]"\$name"
}
. "\$initscript"
"\$action"
EOF
chmod 755 "$WORK/rc.common"
sh "$WORK/rc.common" "$ROOT/files/etc/init.d/netsteer" enable
grep -qxF '* * * * * /usr/bin/netsteer-check' "$CRON" && ok "enable 后保留 check cron" || nok "enable 后缺少 check cron: $(cat "$CRON")"
grep -qxF '37 4 * * 1 /usr/bin/netsteer-feed auto' "$CRON" && ok "enable 后保留 feed cron" || nok "enable 后缺少 feed cron: $(cat "$CRON")"
grep -qxF '0 1 * * * /usr/bin/other' "$CRON" && ok "enable 不删无关 cron" || nok "enable 动了无关 cron"
[ -L "$IPKG_INSTROOT/etc/rc.d/S70netsteer" ] && ok "enable 建立 S70 链接" || nok "缺少 S70 链接"
sh "$WORK/rc.common" "$ROOT/files/etc/init.d/netsteer" enable
[ "$(grep -c '/usr/bin/netsteer-check' "$CRON")" = "1" ] && ok "重复 enable 不重复 check 行" || nok "check cron 重复: $(cat "$CRON")"
[ "$(grep -c '/usr/bin/netsteer-feed' "$CRON")" = "1" ] && ok "重复 enable 不重复 feed 行" || nok "feed cron 重复: $(cat "$CRON")"
sh "$WORK/rc.common" "$ROOT/files/etc/init.d/netsteer" disable
grep -q '/usr/bin/netsteer-check' "$CRON" && nok "disable 后仍有 check cron" || ok "disable 移除 check cron"
grep -q '/usr/bin/netsteer-feed' "$CRON" && nok "disable 后仍有 feed cron" || ok "disable 移除 feed cron"
grep -qxF '0 1 * * * /usr/bin/other' "$CRON" && ok "disable 保留无关 cron" || nok "disable 删了无关 cron"
sh "$WORK/rc.common" "$ROOT/files/etc/init.d/netsteer" disable
grep -qxF '0 1 * * * /usr/bin/other' "$CRON" && ok "重复 disable 仍保留无关 cron" || nok "重复 disable 损坏 crontab"
sh "$WORK/rc.common" "$ROOT/files/etc/init.d/netsteer" enable
[ "$(grep -c '/usr/bin/netsteer-check' "$CRON")" = "1" ] && [ "$(grep -c '/usr/bin/netsteer-feed' "$CRON")" = "1" ] \
	&& ok "disable 后再 enable 恢复各一条 cron" || nok "再 enable 后 cron 异常: $(cat "$CRON")"

# ---------- 4. SQM 空项只在开启时补, 关闭时按缺失/空/显式值恢复 ----------
export NS_SQM_ORIGIN="$WORK/sqm.origin"
rm -f "$UCI_ROOT/.log" "$NS_SQM_ORIGIN"
rm -f "$UCI_ROOT"/sqm.wan.*
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync off wan >/dev/null 2>&1 || true
if [ -f "$UCI_ROOT/.log" ] && grep -q 'sqm.wan.iqdisc_opts\|sqm.wan.eqdisc_opts\|qdisc_advanced' "$UCI_ROOT/.log"; then
	nok "保持关闭时仍写了队列参数: $(cat "$UCI_ROOT/.log")"
else
	ok "保持关闭且无快照时不写队列参数"
fi
: > "$UCI_ROOT/.log"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync on wan >/dev/null 2>&1 || true
[ "$(cat "$UCI_ROOT/sqm.wan.iqdisc_opts" 2>/dev/null)" = "nat dual-dsthost" ] && ok "开启时补齐原本缺失的 iqdisc" || nok "iqdisc 未补齐: $(cat "$UCI_ROOT/sqm.wan.iqdisc_opts" 2>/dev/null)"
[ "$(cat "$UCI_ROOT/sqm.wan.eqdisc_opts" 2>/dev/null)" = "nat dual-srchost" ] && ok "开启时补齐原本缺失的 eqdisc" || nok "eqdisc 未补齐"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync on wan >/dev/null 2>&1 || true
grep -q 'absent' "$NS_SQM_ORIGIN" && ok "重复开启仍记得原本缺失" || nok "重复开启丢失缺失快照: $(cat "$NS_SQM_ORIGIN" 2>/dev/null)"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync off wan >/dev/null 2>&1 || true
[ ! -f "$UCI_ROOT/sqm.wan.iqdisc_opts" ] && [ ! -f "$UCI_ROOT/sqm.wan.eqdisc_opts" ] \
	&& ok "关闭后删除当初缺失的队列参数" || nok "关闭后参数仍在"
[ ! -f "$NS_SQM_ORIGIN" ] && ok "关闭后删除 SQM 快照" || nok "SQM 快照未删"
: > "$UCI_ROOT/.log"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync off wan >/dev/null 2>&1 || true
if grep -q 'sqm.wan.iqdisc_opts\|sqm.wan.eqdisc_opts' "$UCI_ROOT/.log" 2>/dev/null; then
	nok "再次关闭又写了队列参数"
else
	ok "再次关闭不再写队列参数"
fi

# 显式值保留; 空字符串与缺失区分
rm -f "$UCI_ROOT"/sqm.wan.* "$NS_SQM_ORIGIN" "$UCI_ROOT/.log"
printf '%s' 'nat keep-me' > "$UCI_ROOT/sqm.wan.iqdisc_opts"
: > "$UCI_ROOT/sqm.wan.eqdisc_opts"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync on wan >/dev/null 2>&1 || true
[ "$(cat "$UCI_ROOT/sqm.wan.iqdisc_opts")" = "nat keep-me" ] && ok "显式 iqdisc 不被覆盖" || nok "显式 iqdisc 被改成 $(cat "$UCI_ROOT/sqm.wan.iqdisc_opts" 2>/dev/null)"
[ "$(cat "$UCI_ROOT/sqm.wan.eqdisc_opts")" = "nat dual-srchost" ] && ok "空字符串 eqdisc 在开启时补默认" || nok "空 eqdisc 未补默认"
sh "$ROOT/files/usr/bin/netsteer-mode" sqm-opts-sync off wan >/dev/null 2>&1 || true
[ "$(cat "$UCI_ROOT/sqm.wan.iqdisc_opts" 2>/dev/null)" = "nat keep-me" ] && ok "关闭后显式 iqdisc 仍在" || nok "关闭后显式 iqdisc 丢失"
[ -f "$UCI_ROOT/sqm.wan.eqdisc_opts" ] && [ ! -s "$UCI_ROOT/sqm.wan.eqdisc_opts" ] \
	&& ok "关闭后空字符串 eqdisc 恢复成空而不是删除" || nok "空 eqdisc 恢复错误"

# throughput 关闭路径必须调用恢复, 不能在 sqm_migrate 里无条件补齐
awk '
  /^sqm_migrate\(\)/ {m=1}
  /^}/ {if(m){m=0}}
  m && /iqdisc_opts=/ {bad=1}
  END {exit bad?1:0}
' "$ROOT/files/usr/bin/netsteer-mode" && ok "sqm_migrate 不再无条件写 iqdisc" || nok "sqm_migrate 仍无条件写 iqdisc"
awk '
  /^apply_throughput\(\)/ {m=1}
  /^}/ {if(m){exit found?0:1}}
  m && /sqm_opts_restore/ {found=1}
' "$ROOT/files/usr/bin/netsteer-mode" && ok "throughput 关闭时走恢复" || nok "throughput 未调用 sqm_opts_restore"

echo "# pass $pass  fail $fail"
[ "$fail" -eq 0 ]
