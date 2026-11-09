# NetSteer: 排除设备过滤 (tab 七字段流第 3 字段=源 IP; D14 设备排除, 网心云类设备根治)
# 用法: awk -v ex="192.168.11.175 192.168.11.176" -f exclude.awk
BEGIN {
	n = split(ex, a, /[ ,]+/)
	for (i = 1; i <= n; i++) if (a[i] != "") skip[a[i]] = 1
}
!($3 in skip)
