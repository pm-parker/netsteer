# NetSteer 场景判定引擎 (awk, v1.18 判定下沉)
# 输入: 七字段 TAB 行 (v=下行字节, t=协议, c=源IP, d=目的IP, p=目的端口, u=上行字节, q=域名)
#       — 与 netsteer-qos `dnslog-raw` 输出一致
# 输出: 单行 JSON {scene, score:{gaming,work,streaming,download}, ev:{...}}
# 规则 = JS senseClassify 1:1 移植 (量门槛三档/三级识别链/打分/优先序), 单测 tests/unit/sense.test.sh
# 运行: awk -f sense.awk [-v topN=N]  (busybox awk 兼容: 无 gawk 扩展, CIDR 用除法免位运算)

BEGIN {
	# ---- 常量 (与 JS SENSE_* 对齐) ----
	HEAVY_BYTES = 5242880      # 5MB 单连接 heavy 线
	HEAVY_RATIO = 20           # down > up*20 → heavy
	BULK_DOWN = 52428800       # 50MB: 无域名大下行证据线
	MIN_KEEPALIVE = 32768      # 32KB 保活线
	WORK_MIN = 65536           # 64KB 会议/STUN 线
	STREAM_MIN = 524288        # 512KB 流媒体真实下行线

	# ---- 数据集 (环境变量注入, 缺省走 apk 安装路径) ----
	gd = (ENVIRON["GAMEDOMAINS"] != "" ? ENVIRON["GAMEDOMAINS"] : "/usr/share/netsteer/gamedomains.txt")
	sd = (ENVIRON["STREAMDOMAINS"] != "" ? ENVIRON["STREAMDOMAINS"] : "/usr/share/netsteer/streamdomains.txt")
	gi = (ENVIRON["GAMEIPS"] != "" ? ENVIRON["GAMEIPS"] : "/usr/share/netsteer/gameips.txt")
	gp = (ENVIRON["GAMEPORTS"] != "" ? ENVIRON["GAMEPORTS"] : "/usr/share/netsteer/gameports.txt")
	dp = (ENVIRON["DLPORTS"] != "" ? ENVIRON["DLPORTS"] : "/usr/share/netsteer/downloadports.txt")
	while ((getline line < gd) > 0) if (parse_dom(line)) gmap[suf] = cat
	close(gd)
	while ((getline line < sd) > 0) if (parse_dom(line)) smap[suf] = cat
	close(sd)
	ipn = 0; pn = 0; dn = 0
	while ((getline line < gi) > 0) if (parse_cidr(line)) { ipn++; ipbase[ipn] = cbase; ipbits[ipn] = cbits; ipcat[ipn] = ccat }
	close(gi)
	while ((getline line < gp) > 0) if (parse_ports(line)) { pn++; pmaplo[pn] = plo; pmaphi[pn] = phi; pmapproto[pn] = pproto; pmapcat[pn] = pcat }
	close(gp)
	while ((getline line < dp) > 0) if (parse_ports(line)) { dn++; dlo[dn] = plo; dhi[dn] = phi; dproto[dn] = pproto }
	close(dp)

	# ---- 内置列表 (与 JS 同源; 会议域名/STUN/网盘 CDN) ----
	split("zoom.us zoom.com meet.google.com hangouts.google.com teams.microsoft.com teams.live.com dingtalk.com feishu.cn larksuite.com webex.com meeting.qq.com voovmeeting.com tencentmeeting.com", workd, " ")
	for (w in workd) work[workd[w]] = 1
	stun[3478] = 1; stun[3479] = 1; stun[19302] = 1
	dl_suf[1] = ".baidupcs.com"; dl_suf[2] = ".bcsp2p.baidu.com"
}

# ---- 解析 helpers (数据文件格式: cat TAB 识别体, # 注释) ----
function strip_comment(line) { i = index(line, "#"); return i ? substr(line, 1, i-1) : line }
function parse_dom(line,   s, tab) {  # cat/suf 故意全局: BEGIN 建表在函数返回后取值
	s = strip_comment(line); gsub(/^[ \t]+|[ \t]+$/, "", s); if (s == "") return 0
	tab = index(s, "\t"); if (!tab) tab = index(s, " "); if (tab < 1) return 0
	cat = substr(s, 1, tab-1); suf = substr(s, tab+1)
	sub(/^[ \t]+/, "", suf); sub(/[ \t]+$/, "", suf); sub(/^\*\./, "", suf); sub(/^\./, "", suf)
	suf = tolower(suf)
	return (cat != "" && suf != "" && suf !~ /[ \t]/)
}
function parse_cidr(line,   s, tab, cat, cidr, n, a, k, v) {
	s = strip_comment(line); gsub(/^[ \t]+|[ \t]+$/, "", s); if (s == "") return 0
	tab = index(s, "\t"); if (tab < 1) return 0
	cat = substr(s, 1, tab-1); gsub(/^[ \t]+|[ \t]+$/, "", cat)
	cidr = substr(s, tab+1); gsub(/^[ \t]+|[ \t]+$/, "", cidr)
	if (cat == "" || cidr !~ /^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+\/[0-9]+$/) return 0
	n = split(cidr, a, "/"); cbits = a[2] + 0
	if (cbits < 8 || cbits > 32) return 0
	if (split(a[1], v, ".") != 4) return 0
	cbase = 0                      # 每条记录独立累加 (不清零会跨记录继续乘 256)
	for (k = 1; k <= 4; k++) { if (v[k] + 0 > 255) return 0; cbase = cbase * 256 + v[k] }
	ccat = cat                     # 调用方读 ccat; cat 是局部变量, 必须显式导出
	return 1
}
function parse_ports(line,   s, tab, cat, spec, a) {
	s = strip_comment(line); gsub(/^[ \t]+|[ \t]+$/, "", s); if (s == "") return 0
	tab = index(s, "\t"); if (tab < 1) return 0
	cat = substr(s, 1, tab-1); gsub(/^[ \t]+|[ \t]+$/, "", cat)
	spec = substr(s, tab+1); gsub(/^[ \t]+|[ \t]+$/, "", spec)
	if (cat == "" || spec !~ /^[0-9]+-[0-9]+\/(tcp|udp)$/) return 0
	split(spec, a, "-"); plo = a[1] + 0
	split(a[2], a, "/"); phi = a[1] + 0; pproto = a[2]
	if (plo < 1 || phi > 65535 || plo > phi) return 0
	pcat = cat                     # 同上: 调用方读 pcat, cat 是局部变量
	return 1
}

# ---- 识别 helpers (与 JS 同语义) ----
function classify_dom(q, map,   s, i) { # 最长后缀匹配: 逐级剥父域
	if (q == "") return ""
	s = tolower(q); sub(/\.$/, "", s)
	while (1) {
		if (s in map) return map[s]
		i = index(s, "."); if (i == 0) return ""
		s = substr(s, i+1)
	}
}
function ends_with(h, s) { return (length(h) >= length(s) && substr(h, length(h)-length(s)+1) == s) }
function is_work(q,   h, d) { # h==d 或以 .d 结尾 (JS isWorkDomain)
	if (q == "") return 0
	h = tolower(q); sub(/\.$/, "", h)
	for (d in work) if (h == d || ends_with(h, "." d)) return 1
	return 0
}
function is_dl(q,   i) { if (q == "") return 0; for (i in dl_suf) if (ends_with(tolower(q), dl_suf[i])) return 1; return 0 }
function ip2num(ip,   a, k, n, v) { # 非法→-1 (纯除法免位运算)
	if (split(ip, a, ".") != 4) return -1
	n = 0
	for (k = 1; k <= 4; k++) { v = a[k] + 0; if (v < 0 || v > 255 || a[k] !~ /^[0-9]+$/) return -1; n = n * 256 + v }
	return n
}
function classify_ip(d,   n, i, e, best, bestbits, shift, nb, eb) { # 最长前缀: 取高 bits 位相等即命中
	n = ip2num(d); if (n < 0 || ipn == 0) return ""
	best = ""; bestbits = -1
	for (i = 1; i <= ipn; i++) {
		shift = 2 ^ (32 - ipbits[i])
		nb = int(n / shift); eb = int(ipbase[i] / shift)
		if (nb == eb && ipbits[i] > bestbits) { best = ipcat[i]; bestbits = ipbits[i] }
	}
	return best
}
function classify_port(p, t,   i, pn_, pt_) { # 端口+协议 (游戏表)
	pn_ = p + 0; if (pn_ < 1 || pn_ > 65535) return ""
	pt_ = tolower(t)
	for (i = 1; i <= pn; i++)
		if (pn_ >= pmaplo[i] && pn_ <= pmaphi[i] && (pt_ == pmapproto[i] || pt_ == "")) return pmapcat[i]
	return ""
}
function is_dlport(p, t,   i, pn_, pt_) { # 下载端口表 (只判命中不分类)
	pn_ = p + 0; if (pn_ < 1 || pn_ > 65535) return 0
	pt_ = tolower(t)
	for (i = 1; i <= dn; i++)
		if (pn_ >= dlo[i] && pn_ <= dhi[i] && (pt_ == dproto[i] || pt_ == "")) return 1
	return 0
}

# ---- 主判定 (JS senseClassify 1:1) ----
{
	sub(/\r$/, "")   # 只剥 CR (尾空字段是合法七字段之尾, 严禁剥 	 — q 空行=裸 IP 流量, 剥了就丢)
	if ($0 == "") next
	n = split($0, f, "	"); if (n < 7) next
	v = f[1] + 0; t = tolower(f[2]); c = f[3]; d = f[4]; p = f[5] + 0; u = f[6] + 0; q = f[7]
	if (q == "" && d == "") next

	host = q
	heavy = (v > HEAVY_BYTES && (u == 0 || v > u * HEAVY_RATIO))

	gameCat = (q != "") ? classify_dom(q, gmap) : ""
	if (gameCat == "" && d != "") gameCat = classify_ip(d)
	if (gameCat == "" && p > 0) gameCat = classify_port(p, t)
	streamCat = (q != "") ? classify_dom(q, smap) : ""
	st = (t == "udp" && (p in stun))

	traffic = u + v
	# gaming: 三级链命中且 light 且超保活线
	if (gameCat != "" && !heavy && traffic >= MIN_KEEPALIVE) ev_gaming++
	# work: 会议域名 / STUN-UDP 需双向 ≥64KB
	if (is_work(q) && traffic >= WORK_MIN) ev_work_dom++
	else if (st && traffic >= WORK_MIN) ev_work_stun++
	# streaming: 流媒体域名需真实下行 ≥512KB; bulk 只认 80/443/1935 且下行主导
	if (streamCat != "" && v >= STREAM_MIN) ev_stream_dom++
	else if (gameCat == "" && heavy && v > BULK_DOWN && v > u * 10 && (p == 80 || p == 443 || p == 1935)) ev_stream_bulk++
	# download: P2P 端口 / 游戏平台 heavy / 网盘域名
	if (is_dlport(p, t)) ev_download++
	if (gameCat != "" && heavy) ev_download++
	if (is_dl(q) && traffic >= MIN_KEEPALIVE) ev_download++
}

END {
	sc_gaming = ev_gaming * 2
	sc_work = ev_work_dom * 3 + ev_work_stun * 2
	sc_streaming = ev_stream_dom * 2 + ev_stream_bulk
	sc_download = ev_download * 3
	# 平分 tie-break 优先序: gaming > work > streaming > download (JS order 迭代同序)
	best = "normal"; bestScore = 0
	if (sc_gaming > bestScore) { best = "gaming"; bestScore = sc_gaming }
	if (sc_work > bestScore) { best = "work"; bestScore = sc_work }
	if (sc_streaming > bestScore) { best = "streaming"; bestScore = sc_streaming }
	if (sc_download > bestScore) { best = "download"; bestScore = sc_download }
	total = sc_gaming + sc_work + sc_streaming + sc_download
	printf "{\"scene\":\"%s\",\"score\":{\"gaming\":%d,\"work\":%d,\"streaming\":%d,\"download\":%d},\"ev\":{\"gaming\":%d,\"work_dom\":%d,\"work_stun\":%d,\"stream_dom\":%d,\"stream_bulk\":%d,\"download\":%d}}\n",
		best, sc_gaming, sc_work, sc_streaming, sc_download, ev_gaming, ev_work_dom, ev_work_stun, ev_stream_dom, ev_stream_bulk, ev_download
}
