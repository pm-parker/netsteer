/* NetSteer — 网络分核加速 (LuCI 视图)
 * 视觉: 全量跟随 Vantage 主题变量，深浅模式自动适配
 * 通用性: CPU 核数与接口列表运行时探测 (任意 ARM/x86 设备可用)
 */
'use strict';
'require view';
'require fs';
'require uci';
'require ui';

/* 直调 ubus 的轻量应用链 (rpc.declare 在本环境调用挂起，改用裸 fetch /ubus/) */
function ubusCall(obj, method, params) {
	var sid = (window.L && L.env && L.env.sessionid) || '00000000000000000000000000000000';
	return fetch('/ubus/', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify([{ jsonrpc: '2.0', id: Date.now() % 100000, method: 'call', params: [sid, obj, method, params || {}] }])
	}).then(function(r) { return r.json(); })
	  .then(function(j) {
	  	var res = (j && j[0] && j[0].result) || [];
	  	if (res[0] !== 0) throw 'ubus %s.%s 失败: %s'.format(obj, method, JSON.stringify(res).slice(0, 80));
	  	return res[1];
	  });
}

/* bench 基线 uci 节 → {off, on, mode:null}; 无任何基线数据时返 null */
function benchFromUci(cfg) {
	if (!cfg) return null;
	var num = function(v) { var n = +v; return isFinite(n) ? n : 0; };
	var pick = function(sec) {
		var s = cfg[sec];
		if (!s || !s.ts) return null;
		return { mode: s.mode, latency_ms: num(s.latency_ms), rx_bps: num(s.rx_bps), tx_bps: num(s.tx_bps), ts: num(s.ts) };
	};
	var off = pick('bench_off'), on = pick('bench_on');
	if (!off && !on) return null;
	return { off: off, on: on, mode: null };
}

/* 一条龙: 逐项 uci set → apply → confirm → 跑 apply 脚本 (全程 ~0.2s) */
function applyNow(pairs) {
	var chain = Promise.resolve();
	pairs.forEach(function(p) {
		chain = chain.then(function() {
			return ubusCall('uci', 'set', { config: 'netsteer', section: p.sec, values: p.values });
		});
	});
	return chain
		.then(function() {
			/* uci apply 在无实际变更时返回 NO_DATA ([5]) — 容忍 (配置已 staged, 直接落盘即可) */
			return ubusCall('uci', 'apply', { timeout: 90, rollback: true })
				.then(function() { return ubusCall('uci', 'confirm', {}); })
				.catch(function() { /* 无变更或 apply 不适用: 跳过确认窗口 */ });
		})
		.then(function() { return fs.exec('/usr/bin/netsteer-apply'); });
}

/* ---- 运行时环境 (load 阶段填充; 渲染/事件全部引用这两个全局) ---- */
var NCPU = 4;            /* CPU 核数 */
var IFACES = [];         /* [{dev, sec, note, virtual}] 从 uci 读 */
function cpuRange() {
	var a = [];
	for (var i = 0; i < NCPU; i++) a.push(i);
	return a;
}
function fullMask() { return (NCPU >= 32 ? 0xffffffff : (1 << NCPU) - 1).toString(16); }

function maskToCpus(mask) {
	var m = parseInt(mask, 16) || 0;
	return cpuRange().map(function(i) { return (m & (1 << i)) !== 0; });
}
function cpusToMask(cpus) {
	var m = cpus.reduce(function(acc, on, i) { return acc | (on ? (1 << i) : 0); }, 0);
	return m.toString(16);
}
function maskLabel(mask) {
	if (mask === '0' || mask === '' || mask == null) return _('关闭');
	var v = parseInt(mask, 16) || 0;
	if (v === ((1 << NCPU) - 1)) return _('全核');
	var on = cpuRange().filter(function(i) { return (v >> i) & 1; });
	if (!on.length) return _('关闭');
	if (on.length === 1) return 'C%d'.format(on[0]);
	if (on.length <= 3) return on.map(function(i) { return 'C%d'.format(i); }).join('+');
	return _('%d 核 (%s)'.format(on.length, mask));
}

function fmtCount(n) {
	if (n >= 1e8) return '%.2f亿'.format(n / 1e8);
	if (n >= 1e4) return '%.1f万'.format(n / 1e4);
	return String(n);
}

/* ---- 预设 (按核数与接口动态构建) ----
 * 第 i 个物理口中断 → C(NCPU-1-i) 错开应门; pairs 仅在 ≥2 物理口且 ≥2 核时出现 */
function getPresets() {
	var full = fullMask(), half = Math.floor(NCPU / 2);
	var lo = ((1 << half) - 1).toString(16);                     /* 低半区 C0..C(h-1) */
	var hi = ((1 << NCPU) - (1 << half)).toString(16);           /* 高半区 C(h)..C(N-1) */
	var phys = IFACES.filter(function(it) { return !it.virtual; });
	var map = {}, irqMap = {};
	IFACES.forEach(function(it) { map[it.sec] = full; });
	phys.forEach(function(it, i) {
		irqMap[it.sec] = (1 << ((NCPU - 1 - i) % NCPU)).toString(16);
	});
	var presets = {
		all: {
			label: _('全核分摊'),
			short: _('所有核一起干活，负载摊得最平。'),
			desc: _('软中断分摊到全部 %d 核，硬中断错开响应。通用推荐：负载最均匀。'.format(NCPU)),
			rec: true,
			map: map,
			irq: irqMap
		},
		off: {
			label: _('系统默认'),
			short: _('关掉分摊，恢复出厂行为。'),
			desc: _('负载回到单个核心处理。仅用于排障对比效果，日常不建议。'),
			rec: false,
			map: (function() { var m = {}; IFACES.forEach(function(it) { m[it.sec] = '0'; }); return m; })()
		}
	};
	if (phys.length >= 2 && half >= 1) {
		var pmap = {}, pirq = {};
		IFACES.forEach(function(it) {
			/* 虚拟口 (pppoe 等) 是物理流量的封装层, 保持全核参与, 不限进半区 */
			pmap[it.sec] = it.virtual ? full : ((it === phys[0]) ? lo : hi);
		});
		phys.forEach(function(it) {
			pirq[it.sec] = (1 << ((it === phys[0]) ? (half - 1) : (NCPU - 1))).toString(16);
		});
		presets.pairs = {
			label: _('收发分对'),
			short: _('WAN 和 LAN 各用一半核，互不干扰。'),
			desc: _('WAN 口用低半区核，LAN 口用高半区核。隔离性强，高负载均匀度通常不如全核分摊。'),
			rec: false,
			map: pmap,
			irq: pirq
		};
	}
	return presets;
}

/* 当前系统状态匹配哪个预设: 返回 'all'|'pairs'|'off'|null(自定义)
 * irq 数据缺失时只比对 RPS (向后兼容) */
function matchPreset(masks, irq) {
	var PRESETS = getPresets();
	var keys = Object.keys(PRESETS);
	for (var i = 0; i < keys.length; i++) {
		var p = PRESETS[keys[i]], hit = true;
		Object.keys(p.map).forEach(function(sec) {
			if (masks[sec] !== p.map[sec]) hit = false;
		});
		if (hit && p.irq && irq) {
			Object.keys(p.irq).forEach(function(sec2) {
				var it = IFACES.filter(function(x) { return x.sec === sec2; })[0];
				var got = (it && irq[it.dev] && irq[it.dev].affinity) || null;
				if (got && got !== '?' && got !== p.irq[sec2]) hit = false;
			});
		}
		if (hit) return keys[i];
	}
	return null;
}

/* /proc/softirqs → { rx: [c0..], tx: [c0..] } */
function parseSoftirq(text) {
	function row(name) {
		var m = (text || '').match(name + ':\\s+([\\s\\d]+)');
		return m ? m[1].trim().split(/\s+/).map(Number).filter(function(n) { return !isNaN(n); }) : [];
	}
	return { rx: row('NET_RX'), tx: row('NET_TX') };
}

/* 堆叠条 (Memory 卡风格): 段色循环 --v-chart-1..5, 点按/悬停看明细 */
function stackedBar(counts, unit) {
	var sum = counts.reduce(function(a, b) { return a + b; }, 0);
	var el = E('div', { 'class': 'netsteer-stack', 'role': 'img' });
	if (!sum) {
		el.appendChild(E('span', { 'class': 'netsteer-note' }, [ _('暂无数据') ]));
		return el;
	}
	counts.forEach(function(c, i) {
		if (!c) return;
		var pct = Math.max(1.5, Math.round(c * 1000 / sum) / 10);
		el.appendChild(E('div', {
			'class': 'netsteer-stack-seg',
			'style': 'width:%s%%;background:var(--v-chart-%d)'.format(pct, (i % 5) + 1),
			'title': 'CPU%d · %s%s · %s%%'.format(i, fmtCount(c), unit, pct),
			'click': function() {
				ui.showModal(_('CPU%d 明细').format(i), [
					E('p', {}, '%s%s · %s%%'.format(fmtCount(c), unit, pct))
				]);
			}
		}));
	});
	return el;
}

function legend() {
	return E('div', { 'class': 'netsteer-legend' }, cpuRange().map(function(i) {
		return E('span', { 'class': 'netsteer-legend-item' }, [
			E('i', { 'class': 'netsteer-dot', 'style': 'background:var(--v-chart-%d)'.format((i % 5) + 1) }),
			'CPU%d'.format(i)
		]);
	}));
}

/* ---- P2P 直通 (Fullcone 等效): 纯函数层 ---- */
function p2pValidIp(ip) {
	var m = (/^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/).exec(ip || '');
	if (!m) return false;
	var a = ip.split('.').map(Number);
	if (a[0] === 10 || (a[0] === 192 && a[1] === 168)) return true;
	if (a[0] === 172 && a[1] >= 16 && a[1] <= 31) return true;
	return false;
}
function p2pValidPort(p) {
	var n = parseInt(p, 10);
	return n >= 1 && n <= 65535;
}
function p2pStatusMeta(st) {
	/* st = netsteer-p2p status 的 JSON → 徽标文案与样式类 */
	if (st && st.active) return { label: '已开启 · %s'.format(st.dest_ip || '?'), cls: '' };
	return { label: '已关闭', cls: ' is-custom' };
}

/* ---- 游戏通道: tc -s 解析 + 状态机 (纯函数层, 单测覆盖) ---- */
function parseTinStats(text) {
	/* tc -s qdisc show (cake) → {mode, bandwidth, tins} 或 null
	 * cake 分桶是列式布局: 表头行 "Bulk  Best Effort [Video]  Voice" 定义列偏移,
	 * 指标行 (pkts/bytes/drops/marks…) 按列偏移切片。besteffort (无分桶) 返回 tins:null。 */
	if (!text) return null;
	var qm = /bandwidth (\S+) (diffserv\d|besteffort)/.exec(text);
	if (!qm) return null;
	var hi = text.search(/Bulk\s+Best Effort/);
	if (hi < 0) return { mode: qm[2], bandwidth: qm[1], tins: null };
	var names = [], re = /(Bulk|Best Effort|Video|Voice)/g, m;
	re.lastIndex = hi;
	while ((m = re.exec(text)) && m.index < hi + 60) {
		names.push(m[1]);
		if (names.length >= 4) break;
	}
	var key = function(n) { return n.toLowerCase().replace(/ /g, '_'); };
	var tins = {};
	names.forEach(function(n) { tins[key(n)] = {}; });
	var KEYS = ['thresh', 'target', 'interval', 'pk_delay', 'av_delay', 'sp_delay', 'backlog', 'pkts', 'bytes', 'way_inds', 'way_miss', 'way_cols', 'drops', 'marks'];
	/* 指标行按 token 位置映射到表头列 (tc 数值右对齐, 按列宽切片会被右对齐截断; token 法不依赖对齐) */
	var lines = text.split('\n');
	for (var i = 0; i < lines.length; i++) {
		var lm = /^\s+([a-z_]+)\s{2,}/.exec(lines[i]);
		if (!lm || KEYS.indexOf(lm[1]) < 0) continue;
		var toks = lines[i].trim().split(/\s+/);
		var vals = toks.slice(1);
		if (vals.length !== names.length) continue;   /* 列数不符 → 跳过该行 (防御) */
		for (var c = 0; c < names.length; c++)
			tins[key(names[c])][lm[1]] = vals[c];
	}
	return { mode: qm[2], bandwidth: qm[1], tins: tins };
}

function buildDomainMap(text) {
	/* gamedomains.txt 文本 → {suffix: category} (纯函数; 格式 "category<TAB>suffix", # 注释) */
	var m = {};
	if (!text) return m;
	String(text).split(/\r?\n/).forEach(function(line) {
		var s = line.replace(/^\s+|\s+$/g, '');
		if (!s || s.charAt(0) === '#') return;
		var sep = (s.indexOf('	') >= 1) ? '	' : (s.indexOf(' ') >= 1 ? ' ' : '');
		if (!sep) return;
		var i = s.indexOf(sep);
		var cat = s.slice(0, i);
		var suf = s.slice(i + 1).replace(/^\*?\.?/, '').replace(/^\s+/, '').replace(/\s+$/, '').toLowerCase();
		if (!cat || !suf || /\s/.test(suf)) return;
		if (m[suf]) return;
		m[suf] = cat;
	});
	return m;
}

function classifyDomain(q, map) {
	/* 查询名 → 平台类别 (最长后缀匹配); 未命中 null (纯函数) */
	if (!q || !map) return null;
	var s = String(q).replace(/\.$/, '').toLowerCase();
	for (;;) {
		if (map[s]) return map[s];
		var i = s.indexOf('.');
		if (i < 0) return null;
		s = s.slice(i + 1);
	}
}

function leaseSuggestions(leasesText) {
	/* /tmp/dhcp.leases 文本 → 疑似游戏设备 [{ip,name}] (纯函数; 主机名启发式) */
	var res = [ /ps[45]\b/, /playstation/, /xbox/, /switch/, /nintendo/, /steam/, /\bdeck\b/, /geforce/, /\brog\b/, /\bally\b/, /legion/, /console/, /victory/ ];
	var out = [];
	if (!leasesText) return out;
	String(leasesText).split(/\r?\n/).forEach(function(line) {
		var f = line.replace(/^\s+/, '').split(/\s+/);
		if (f.length < 4) return;
		var h = f[3], ip = f[2];
		if (!ip || !h || h === '*') return;
		var low = h.toLowerCase();
		for (var i = 0; i < res.length; i++)
			if (res[i].test(low)) { out.push({ ip: ip, name: h }); break; }
	});
	return out;
}

function buildIpMap(text) {
	/* gameips.txt → [{base:int, bits, cat}] (纯函数; 容错: 注释/空行/坏 CIDR/IPv6 跳过) */
	var out = [];
	(text || '').split('\n').forEach(function(line) {
		var h = line.indexOf('#');
		if (h >= 0) line = line.slice(0, h);
		line = line.trim();
		if (!line) return;
		var tab = line.indexOf('	');
		var cat = tab >= 0 ? line.slice(0, tab).trim() : '';
		var cidr = tab >= 0 ? line.slice(tab + 1).trim() : line;
		var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(cidr);
		if (!cat || !m) return;
		var bits = +m[5];
		if (bits < 8 || bits > 32) return;
		var o = [+m[1], +m[2], +m[3], +m[4]], base = 0, i;
		for (i = 0; i < 4; i++) { if (o[i] > 255) return; base = base * 256 + o[i]; }
		out.push({ base: base, bits: bits, cat: cat });
	});
	return out;
}
function classifyIp(ip, ipmap) {
	/* IPv4 → 平台类别 (最长前缀匹配); 非法输入 → null */
	var m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(ip || '').trim());
	if (!ipmap || !ipmap.length || !m) return null;
	var o = [+m[1], +m[2], +m[3], +m[4]], n = 0, i;
	for (i = 0; i < 4; i++) { if (o[i] > 255) return null; n = n * 256 + o[i]; }
	var best = null, bestBits = -1;
	for (i = 0; i < ipmap.length; i++) {
		var e = ipmap[i];
		var mask = (e.bits === 0) ? 0 : (((0xffffffff << (32 - e.bits)) & 0xffffffff));
		if ((n & mask) === (e.base & mask) && e.bits > bestBits) { best = e.cat; bestBits = e.bits; }
	}
	return best;
}
function buildPortMap(text) {
	/* gameports.txt → [{lo, hi, proto, cat}] (纯函数; 格式 cat TAB lo-hi/proto; 坏行跳过) */
	var out = [];
	(text || '').split('\n').forEach(function(line) {
		var h = line.indexOf('#');
		if (h >= 0) line = line.slice(0, h);
		line = line.trim();
		if (!line) return;
		var tab = line.indexOf('	');
		if (tab < 0) return;
		var cat = line.slice(0, tab).trim();
		var spec = line.slice(tab + 1).trim();
		var m = /^(\d+)-(\d+)\/(tcp|udp)$/.exec(spec);
		if (!cat || !m) return;
		var lo = +m[1], hi = +m[2];
		if (lo < 1 || hi > 65535 || lo > hi) return;
		out.push({ lo: lo, hi: hi, proto: m[3], cat: cat });
	});
	return out;
}
function classifyPort(port, proto, pmap) {
	/* 端口+协议 → 平台类别; 非法输入 → null */
	var p = parseInt(port, 10);
	if (!pmap || !pmap.length || !p || p < 1 || p > 65535) return null;
	proto = String(proto || '').toLowerCase();
	for (var i = 0; i < pmap.length; i++) {
		var e = pmap[i];
		if (p >= e.lo && p <= e.hi && (proto === e.proto || proto === '')) return e.cat;
	}
	return null;
}
function dnsSummary(records, map, device, ipmap, pmap) {
	/* 采样记录 → {total, hit, platforms:{cat:n}, last:[{q,cat,src}]} (纯函数)
	 * 三级识别: q 域名(src=name) → d 裸 IP(src=ip) → p+t 端口(src=port); 全未命中 cat=''
	 * device '-' 或 '' = 不过滤; q 与 d 都空的记录不计入 */
	var res = { total: 0, hit: 0, platforms: {}, last: [] };
	(records || []).forEach(function(r) {
		if (!r || (!r.q && !r.d)) return;
		if (device && device !== '-' && r.c !== device) return;
		res.total++;
		var cat = '', src = '';
		if (r.q) { cat = classifyDomain(r.q, map); if (cat) src = 'name'; }
		if (!cat && r.d) { cat = classifyIp(r.d, ipmap); if (cat) src = 'ip'; }
		if (!cat && r.p) { cat = classifyPort(r.p, r.t, pmap); if (cat) src = 'port'; }
		if (cat) {
			res.hit++;
			res.platforms[cat] = (res.platforms[cat] || 0) + 1;
		}
		res.last.push({ q: r.q || ('→' + (r.d || '') + (r.p ? ':' + r.p : '')), cat: cat || '', src: src });
	});
	if (res.last.length > 8) res.last = res.last.slice(-8);
	return res;
}

/* ---- 场景感知引擎 (D12, 对标 cFosSpeed 场景模式/bulk_detect): 纯函数层 ---- */
/* 工作会议域名 (内置常量, 数据源=各平台官方文档公开域名) */
var SENSE_WORK_DOMAINS = [
	'zoom.us', 'zoom.com', 'meet.google.com', 'hangouts.google.com',
	'teams.microsoft.com', 'teams.live.com', 'dingtalk.com', 'feishu.cn',
	'larksuite.com', 'webex.com', 'meeting.qq.com', 'voovmeeting.com',
	'tencentmeeting.com'
];
var SENSE_STUN_PORTS = { 3478: 1, 3479: 1, 19302: 1 }; /* STUN/TURN + Google Meet UDP (WebRTC 通道, 与 gameports 刻意排除的端口互补) */
var SENSE_HEAVY_BYTES = 5242880;    /* 5MB: 单连接下行累计超过此值且 down>>up → bulk */
var SENSE_HEAVY_RATIO = 20;         /* down > up*20 */
var SENSE_BULK_DOWN = 52428800;     /* 50MB: 无域名命中时的"大下行"流媒体/下载证据 */

function isConnHeavy(r) {
	/* cFosSpeed bulk_detect 对应物: 同一域名/连接区分交互流(light)与批量流(heavy) (纯函数) */
	var v = +r.v || 0, u = +r.u || 0;
	return v > SENSE_HEAVY_BYTES && (u === 0 || v > u * SENSE_HEAVY_RATIO);
}

function isWorkDomain(host) {
	if (!host) return false;
	var h = String(host).toLowerCase().replace(/\.$/, '');
	for (var i = 0; i < SENSE_WORK_DOMAINS.length; i++) {
		var d = SENSE_WORK_DOMAINS[i];
		if (h === d || h.slice(-(d.length + 1)) === '.' + d) return true;
	}
	return false;
}

function senseClassify(records, maps) {
	/* 连接采样 → 场景判定 (每场景独立证据链 + 打分, 纯函数)
	 * maps = { game: {}, gameips: [], gameports: [], stream: {}, dlports: [] }
	 * 返回 { scene, confidence, score, evidence } — scene: gaming|work|streaming|download|normal */
	maps = maps || {};
	var ev = { gaming: [], work: [], streaming: [], download: [] };
	(records || []).forEach(function(r) {
		if (!r || (!r.q && !r.d)) return;
		var host = r.q || '', heavy = isConnHeavy(r);
		var p = +r.p || 0;
		/* 三级识别链 (域名→IP段→端口) — 与 dnsSummary 同源 */
		var gameCat = host ? classifyDomain(host, maps.game) : null;
		if (!gameCat && r.d) gameCat = classifyIp(r.d, maps.gameips);
		if (!gameCat && r.p) gameCat = classifyPort(r.p, r.t, maps.gameports);
		var streamCat = host ? classifyDomain(host, maps.stream) : null;
		var stun = (r.t === 'udp') && SENSE_STUN_PORTS[p];

		/* gaming: 三级链命中且 light (对局连接是双向小流量) */
		if (gameCat && !heavy) ev.gaming.push({ via: 'chain', host: host || r.d, cat: gameCat });
		/* work: 会议域名 (强) / STUN-UDP 双向有量 (中) */
		if (isWorkDomain(host)) ev.work.push({ via: 'domain', host: host });
		else if (stun && (+r.u || 0) > 0 && (+r.v || 0) > 0) ev.work.push({ via: 'stun', host: host || ((r.d || '') + ':' + r.p) });
		/* streaming: 流媒体域名命中 / 大体量持续下行 */
		if (streamCat) ev.streaming.push({ via: 'domain', host: host, cat: streamCat, heavy: heavy });
		else if (!gameCat && heavy && (+r.v || 0) > SENSE_BULK_DOWN) ev.streaming.push({ via: 'bulk', host: host || r.d, cat: '' });
		/* download: 知名 P2P 端口 / 游戏平台域名下的 heavy 流 (平台商店下载≠对局, cFosSpeed light-heavy 分析的对症移植) */
		if (classifyPort(r.p, r.t, maps.dlports)) ev.download.push({ via: 'port', host: host || r.d, cat: 'p2p' });
		if (gameCat && heavy) ev.download.push({ via: 'game-heavy', host: host, cat: gameCat });
	});
	var nDom = function(a, v) { return a.filter(function(e) { return e.via === v; }).length; };
	var score = {
		gaming: ev.gaming.length * 2,
		work: nDom(ev.work, 'domain') * 3 + nDom(ev.work, 'stun') * 2,
		streaming: nDom(ev.streaming, 'domain') * 2 + nDom(ev.streaming, 'bulk'),
		download: ev.download.length * 3
	};
	var order = ['gaming', 'work', 'streaming', 'download']; /* 平分 tie-break: 用户收益优先序 */
	var best = 'normal', bestScore = 0, total = 0;
	order.forEach(function(s) { total += score[s]; if (score[s] > bestScore) { best = s; bestScore = score[s]; } });
	return { scene: best, confidence: total > 0 ? Math.round(bestScore * 100 / total) : 0, score: score, evidence: ev };
}

function senseDebounce(state, scene, nowSec) {
	/* 防抖状态机 (纯函数): 连续 2 个采样窗口同判定才切换, 防瞬时抖动 */
	var st = state || { scene: 'normal', cand: null, candCount: 0, since: nowSec };
	if (!scene) scene = 'normal';
	if (scene === st.scene) { st.cand = null; st.candCount = 0; return st; }
	if (scene === st.cand) {
		st.candCount++;
		if (st.candCount >= 2) return { scene: scene, cand: null, candCount: 0, since: nowSec };
	} else {
		st.cand = scene; st.candCount = 1;
	}
	return st;
}

var SENSE_SCENE_META = {
	gaming:    { icon: '◈', name: _('游戏'), cls: 'ns-scene-game' },
	work:      { icon: '☂', name: _('会议'), cls: 'ns-scene-work' },
	streaming: { icon: '▶', name: _('流媒体'), cls: 'ns-scene-stream' },
	download:  { icon: '⇩', name: _('下载'), cls: 'ns-scene-dl' },
	normal:    { icon: '·', name: _('日常'), cls: '' }
};

function gameStatusMeta(st) {
	/* st = netsteer-qos status 的 JSON → 徽标五态 (诚实降级: 标记在但整形不在 = 降级) */
	if (!st) return { cls: ' is-custom', label: _('状态未知'), state: 'unknown' };
	if (!st.enabled && !st.active) return { cls: ' is-custom', label: _('未开启'), state: 'off' };
	if (!st.enabled && st.active) return { cls: ' is-warn', label: _('有残留规则'), state: 'stale' };
	if (st.enabled && !st.active) return { cls: ' is-warn', label: _('标记缺失'), state: 'missing' };
	if (st.enabled && st.active && !st.sqm_enabled) return { cls: ' is-warn', label: _('SQM 未运行 · 直通'), state: 'no_sqm' };
	if (st.enabled && st.active && st.cake_up !== 'diffserv4') return { cls: ' is-warn', label: _('整形未切换'), state: 'degraded' };
	return { cls: '', label: _('优先中 · %s').format(st.device || '?'), state: 'on' };
}

function dnsObserverMeta(st) {
	/* DNS 观测面环境自适应 (纯函数): st.dns_observer 四态 → 徽标/说明/可选动作
	 * mihomo     = 代理内核连接表嗅探 ( nikki/openclash/clash 任一存在 )
	 * dnsmasq    = 裸路由器 + dnsmasq 查询日志已开
	 * dnsmasq_off= 裸路由器 + 日志未开 (给一键开启动作)
	 * none       = 既无代理内核也无 dnsmasq (罕见) → 观测不可用, 不影响加速通道 */
	var o = st && st.dns_observer;
	if (o === 'dnsmasq') return { state: 'dnsmasq', badge: _('查询日志'), desc: _('观察这台设备的 DNS 查询记录（dnsmasq 查询日志），标注它正在访问的游戏平台（Steam/Epic/PSN/Xbox…，识别数据来自 cache-domains 开源项目）。主机名来自查询日志，明文 DNS 才可见；样本受系统日志容量限制，短连接可能不出现——这是观测边界，不影响加速通道本身。分类在前端完成，路由器零负担。'), btn: 'off' };
	if (o === 'dnsmasq_off') return { state: 'dnsmasq_off', badge: _('未开启'), desc: _('本机未检测到代理内核，DNS 识别将走 dnsmasq 查询日志通道。需要开启查询日志（会重启 dnsmasq 约 1 秒，日志体积略增）。开启后即自动观测。'), btn: 'on' };
	if (o === 'none') return { state: 'none', badge: _('不可用'), desc: _('未检测到代理内核，也没有可用的 dnsmasq——DNS 识别不可用。这只影响平台标注，不影响加速通道本身。'), btn: null };
	return { state: 'mihomo', badge: _('实时嗅探'), desc: _('观察这台设备的实时连接，三级标注它正在访问的游戏平台（Steam/Epic/PSN/Xbox…，识别数据来自 cache-domains 与 Valve 官方 SDR 公开数据）：①连接主机名（SNI 嗅探）②裸 IP 直连（官方 IP 段匹配，覆盖无域名的游戏relay）③知名端口（3074 主机 NAT 等）。样本是活跃连接的快照，短连接可能不出现——这是观测边界，不影响加速通道本身。分类在前端完成，路由器零负担。'), btn: null };
}

/* ---- 网络体检: 依赖矩阵 + 冲突检测 + 两档方案构建 (纯函数层) ---- */
function parseIrqList(txt) {
	/* netsteer-irq get JSON → [{irq,dev,affinity,counts}] (容错: 坏行丢弃) */
	try {
		var a = JSON.parse((txt || '').trim());
		if (!Array.isArray(a)) return [];
		return a.filter(function(x) { return x && x.irq && x.dev; })
			.map(function(x) { return { irq: String(x.irq), dev: String(x.dev),
				affinity: String(x.affinity || '0'), counts: +x.counts || 0 }; });
	} catch (e) { return []; }
}
function irqMaskOfCpu(cpu) { /* cpu index → hex mask string */ return (1 << cpu).toString(16); }
function deltaSoftirq(baseText, curText) {
	/* 两次 /proc/softirqs 快照 → 增量分布 {rx:[], tx:[], rxConc, baseRxConc} */
	var b = parseSoftirq(baseText), c = parseSoftirq(curText);
	var n = Math.max(b.rx.length, c.rx.length);
	var rx = [], tx = [], i, sum = 0;
	for (i = 0; i < n; i++) {
		var d = ((c.rx[i] || 0) - (b.rx[i] || 0)); if (d < 0) d = 0;
		rx.push(d); sum += d;
	}
	for (i = 0; i < n; i++) {
		var t = ((c.tx[i] || 0) - (b.tx[i] || 0)); if (t < 0) t = 0;
		tx.push(t);
	}
	var maxI = 0, bSum = 0, bMax = 0, bMaxI = 0;
	rx.forEach(function(v, k) { if (v > rx[maxI]) maxI = k; });
	b.rx.forEach(function(v, k) { bSum += v; if (v > bMax) { bMax = v; bMaxI = k; } });
	return {
		rx: rx, tx: tx,
		total: sum,
		rxConc: sum > 0 ? Math.round(rx[maxI] * 100 / sum) : null,
		concCpu: sum > 0 ? maxI : null,
		baseRxConc: bSum > 0 ? Math.round(b.rx[bMaxI] * 100 / bSum) : null
	};
}

/* ---- v2 引擎: 数据采样 / 路径粒子 / 时序曲线 (风格与机制移植自主题仪表盘) ---- */
function netdevParse(txt) {
	/* /proc/net/dev → {iface: {rx_bps, tx_bps}} 需两次采样求差, 本函数只解析累计值 */
	var out = {};
	(txt || '').split('\n').forEach(function(line) {
		var m = line.match(/^\s*([\w.@-]+):\s*(\d+)\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+\d+\s+(\d+)/);
		if (m) out[m[1]] = { rx: +m[2], tx: +m[3] };
	});
	return out;
}
function netdevDelta(prev, cur, dtMs) {
	/* 两次累计值 → bps (回绕/重启保护: 负值或超大跳变视为无效返回 null) */
	var out = {};
	Object.keys(cur).forEach(function(k) {
		if (!prev || prev[k] === undefined) { out[k] = null; return; }
		var dr = cur[k].rx - prev[k].rx, dt = cur[k].tx - prev[k].tx;
		var s = dtMs / 1000;
		if (dr < 0 || dt < 0 || s <= 0) { out[k] = null; return; }
		if (dr / s > 25e9 || dt / s > 25e9) { out[k] = null; return; } /* >25Gbps = 回绕噪声 */
		out[k] = { rx_bps: dr * 8 / s, tx_bps: dt * 8 / s };
	});
	return out;
}
function speedTier(bps) { /* 粒子速度三档 (与主题 wires.js 同档位): 0 慢 1 中 2 快 */
	if (bps == null) return 0;
	return bps > 100e6 ? 2 : bps > 5e6 ? 1 : 0;
}
function wiresPathH(x1, y1, x2, y2) {
	/* 水平贝塞尔 (与主题 wires.curve 同形): 两节点同高时的 S 型连线 */
	var mx = (x1 + x2) / 2, pts = [], STEPS = 24;
	for (var i = 0; i <= STEPS; i++) {
		var t = i / STEPS, u = 1 - t;
		pts.push([u*u*u*x1 + 3*u*t*mx + t*t*t*x2, (u*u*u + 3*u*u*t)*y1 + (3*u*t*t + t*t*t)*y2]);
	}
	return pts;
}
function wiresResample(pts, step) {
	/* 等距重采样 + 航向角 → 粒子 keyframes (与主题 wires.resample 同法) */
	var cum = [0], i;
	for (i = 1; i < pts.length; i++)
		cum.push(cum[i-1] + Math.hypot(pts[i][0]-pts[i-1][0], pts[i][1]-pts[i-1][1]));
	var len = cum[cum.length-1];
	if (!(len > 0)) return { pts: [], len: 0 };
	var n = Math.max(1, Math.round(len/step)), j = 1, prev = null, out = [];
	for (i = 0; i <= n; i++) {
		var s2 = len * i / n;
		while (j < pts.length-1 && cum[j] < s2) j++;
		var k = j;
		while (k < pts.length-1 && cum[k] === cum[k-1]) k++;
		var seg = cum[j] - cum[j-1], f = seg > 0 ? (s2 - cum[j-1]) / seg : 0;
		var dx = pts[k][0]-pts[k-1][0], dy = pts[k][1]-pts[k-1][1];
		var deg = Math.atan2(dy, dx) * 180 / Math.PI;
		if (prev != null) { while (deg-prev > 180) deg -= 360; while (deg-prev < -180) deg += 360; }
		prev = deg;
		out.push([pts[j-1][0] + (pts[k][0]-pts[k-1][0])*f, pts[j-1][1] + (pts[k][1]-pts[k-1][1])*f, deg]);
	}
	return { pts: out, len: len };
}
function seriesPush(arr, point, windowMs, max) {
	/* 滑动窗口追加 (与主题 series.push 同法): 时间升序 + 裁剪 */
	var out = Array.isArray(arr) ? arr.slice() : [];
	if (!Array.isArray(point) || !isFinite(point[0])) return out;
	if (out.length && out[out.length-1][0] >= point[0]) return out;
	out.push(point);
	var cutoff = point[0] - (windowMs > 0 ? windowMs : Infinity);
	while (out.length && (out[0][0] < cutoff || (max > 0 && out.length > max))) out.shift();
	return out;
}
function niceCeil(v) {
	/* 图表轴 nice 值 (与主题 series.niceCeil 同法) */
	if (!isFinite(v) || v <= 0) return 1;
	var e = Math.pow(10, Math.floor(Math.log10(v))), f = v / e;
	var steps = [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10];
	for (var i = 0; i < steps.length; i++)
		if (f <= steps[i] * (1 + 1e-9)) return steps[i] * e;
	return 10 * e;
}
function seriesStatsMax(sr) {
	/* 时序数组 [[t,v],...] 的峰值 (null 忽略) */
	var m = 0;
	(sr || []).forEach(function(p) { if (p[1] != null && isFinite(p[1]) && p[1] > m) m = p[1]; });
	return m;
}
function fmtBps(bps) {
	/* cFos 风读数: 自动单位一位小数 */
	if (bps == null || !isFinite(bps)) return '—';
	var u = ['bit/s', 'kbit/s', 'Mbit/s', 'Gbit/s'], i = 0, v = bps;
	while (v >= 1000 && i < u.length-1) { v /= 1000; i++; }
	return (v >= 100 ? Math.round(v) : v >= 10 ? Math.round(v*10)/10 : Math.round(v*100)/100) + ' ' + u[i];
}

function tabStructure() {
	/* 横向 Tab 分组: 卡片归类唯一 (单测校验)。总览=仪表盘 (小白), 专家调教=手工层 */
	return [
		{ id: 'overview', name: _('总览'), cards: ['wires', 'health', 'traffic'],
			hint: _('实时网络路径、负载健康与吞吐曲线 — 出问题一眼看到在哪一段。') },
		{ id: 'smart', name: _('智能优化'), cards: ['audit', 'p2p'],
			hint: _('一键体检、场景模式与 P2P 直通——自动检测环境、推荐方案、规避冲突配置。') },
		{ id: 'game', name: _('游戏通道'), cards: ['game'],
			hint: _('指定游戏设备的专属优先通道——满载下载时游戏延迟不受拖累，实时分桶数据可验证。') },
		{ id: 'pro', name: _('专家调教'), cards: ['presets', 'ifaces', 'softirq', 'irq'],
			hint: _('分核方案、逐口 RPS/XPS、软中断分布与 IRQ 亲和 — 精确到每一颗核心。') }
	];
}

function modeDefs() {
	/* requires = 依赖键 (对照 netsteer-audit 的 deps 字段); 空 = 零依赖可用 */
	return [
		{ id: 'steering', icon: '◈', name: _('纯分核加速'), requires: [],
			desc: _('只做 RPS/XPS/IRQ 分核，不动 SQM/防火墙。零依赖，任何设备可用。CPU 多核分担转发，无整形。') },
		{ id: 'standard', icon: '⚖', name: _('均衡'), requires: ['sqm_scripts', 'kmod_cake'],
			desc: _('SQM cake 整形 + 全核分摊 + 分载关。家用默认最优：防缓冲膨胀，多设备公平，视频会议不卡。') },
		{ id: 'p2p', icon: '⇅', name: _('P2P 加速'), requires: ['sqm_scripts', 'kmod_cake'],
			desc: _('均衡基础上给指定设备开 UDP 全端口直通 (Fullcone 等效)。适合有网心云/P2P 下载机的环境，打洞成功率最大化。') },
		{ id: 'throughput', icon: '»', name: _('极速'), requires: [],
			desc: _('关 SQM、开流量分载 (Routing+NAT)。转发 CPU 大幅下降、千兆线速更容易稳住——代价是失去整形质量。') },
		{ id: 'latency', icon: '⏱', name: _('低延迟'), requires: ['sqm_scripts', 'kmod_cake'],
			desc: _('SQM 切 layer_cake 分层 + 整形值降 10%。游戏/会议优先级最高，代价是主动放弃部分带宽。') }
	];
}
function depLabels() {
	return {
		sqm_scripts: { name: _('SQM 引擎 (sqm-scripts)'), pkg: 'sqm-scripts', feed: 'packages' },
		kmod_cake: { name: _('CAKE 队列模块 (kmod-sch-cake)'), pkg: 'kmod-sch-cake', feed: 'kmods' },
		sqm_luci: { name: _('LuCI SQM 管理页 (luci-app-sqm)'), pkg: 'luci-app-sqm', feed: 'luci' },
		tc: { name: _('流量控制工具 (tc)'), pkg: 'tc', feed: 'packages' },
		nft: { name: _('nftables'), pkg: 'nft', feed: 'base' }
	};
}
function auditConflicts(a) {
	/* a = netsteer-audit 输出 JSON → [{level, title, detail, fix}]; 依赖缺失先行差异化 */
	var out = [];
	if (!a) return out;
	var d = a.deps || {}, s = a.sqm || {}, o = a.offload || {}, p = a.p2p || {};
	var hasSqm = !!d.sqm_scripts;
	if (s.enabled && o.flow)
		out.push({ level: 'conflict', title: _('SQM 与流量分载同时开启'),
			detail: _('分载 (flow offloading) 会让后续包绕过 netfilter 入站钩子，SQM 的下行整形 (cake) 对这些包失效——等于花着 CPU 跑 SQM 却管不住大部分流量。'),
			fix: _('二选一：要低延迟选"均衡/低延迟"模式（关分载）；要纯吞吐选"极速"模式（关 SQM）。') });
	if (hasSqm && s.enabled && s.cake_running && String(s.section_type) === 'sqm')
		out.push({ level: 'conflict', title: _('SQM 配置是旧结构，LuCI 页面读不到'),
			detail: _('cake 在跑但 /etc/config/sqm 的 section 类型是旧式 sqm，新版 SQM 页面只认 queue 类型，会显示"没有值"。'),
			fix: _('任意模式应用时会自动迁移为 queue 结构，无需手工处理。') });
	if (hasSqm && !d.sqm_luci && s.enabled)
		out.push({ level: 'info', title: _('LuCI SQM 管理页未安装'),
			detail: _('SQM 引擎在跑但管理页面 (luci-app-sqm) 缺失——你在 系统→防火墙 看得到整形效果，却没有可视化调整入口。'),
			fix: _('apk add luci-app-sqm（需 luci 软件源）。') });
	if (hasSqm && s.enabled && s.cake_running && !o.flow && +a.uplink_sample_kbps > 0 && +s.upload > 0) {
		var ov = +a.uplink_sample_kbps - (+s.upload);
		if (ov > +s.upload * 0.05)
			out.push({ level: 'warn', title: _('上行超售：实测 %d kbps 已超过整形值 %d kbps').format(+a.uplink_sample_kbps, +s.upload),
				detail: _('持续超出套餐速率会触发运营商城域网 QoS——丢包发生在运营商机房，路由器侧任何队列都排不到那里。cake 只能保证"不堵在自家门口"。'),
				fix: _('若重视传输质量，用"低延迟"模式把整形值降到实测的 90%；若追求跑量，保持现状即可。') });
	}
	if (p.active && p.ip && String(a.static_leases || '').indexOf(p.ip) < 0)
		out.push({ level: 'warn', title: _('P2P 直通设备 %s 没有静态租约').format(p.ip),
			detail: _('DHCP 重新分配后 IP 漂移，直通规则会打到别的设备上（安全面扩大 + P2P 失效）。'),
			fix: _('在 网络→接口→DHCP 里为该设备添加静态租约。') });
	if (+a.irqbalance)
		out.push({ level: 'warn', title: _('irqbalance 与手动分核绑定冲突'),
			detail: _('irqbalance 会周期性重排中断，覆盖 netsteer 的 IRQ 亲和设置。'),
			fix: _('禁用 irqbalance：/etc/init.d/irqbalance disable') });
	if (!hasSqm && !o.flow)
		out.push({ level: 'info', title: _('当前无 SQM 引擎也无分载，转发为逐包软路径'),
			detail: _('小核 CPU 高负载时千兆 NAT 会吃力。SQM 引擎未安装——本档推荐会给出补齐依赖后的方案。'),
			fix: _('按下方推荐操作：零依赖可先用"纯分核/极速"，补齐 sqm-scripts + kmod-sch-cake 后解锁整形。') });
	return out;
}
function modeScore(m, a) {
	/* 场景打分: 返回排序键 (小前优) */
	var s = a && a.sqm || {}, o = a && a.offload || {}, p = a && a.p2p || {};
	if (m.id === 'p2p' && (p.active || (p.ip && p.ip !== '-'))) return 0;
	if (m.id === 'standard' && s.enabled && o.flow) return 0;
	if (m.id === 'latency' && s.enabled && s.cake_running && +a.uplink_sample_kbps > 0 && +s.upload > 0 && (+a.uplink_sample_kbps - +s.upload) > +s.upload * 0.05) return 0;
	if (m.id === 'standard') return 1;
	if (m.id === 'throughput' && !s.enabled) return 1;
	if (m.id === 'latency') return 2;
	if (m.id === 'throughput') return 2;
	return 3;
}
function modeWhy(m, a) {
	var s = a && a.sqm || {}, o = a && a.offload || {}, p = a && a.p2p || {};
	if (m.id === 'p2p' && (p.active || (p.ip && p.ip !== '-'))) return _('P2P 直通设备在网 (%s)，保持直通收益最大').format(p.ip || '?');
	if (m.id === 'standard' && s.enabled && o.flow) return _('SQM 与分载正在互相打架——此模式关分载保整形，恢复正常工作');
	if (m.id === 'latency') return _('上行持续超售 (实测 %d kbps)，降速 10% 换传输质量').format(+a.uplink_sample_kbps);
	if (m.id === 'standard') return _('无特殊风险信号，均衡模式通用性最好');
	if (m.id === 'throughput') return _('不装任何东西也能拿到 CPU 降载');
	if (m.id === 'steering') return _('零依赖可用的最小升级');
	return '';
}
function depsMissing(m, a) {
	var d = (a && a.deps) || {};
	return (m.requires || []).filter(function(k) { return !d[k]; });
}
function installHint(missing, a) {
	/* 依据缺失项 + 源可用性生成安装指引 */
	var L = depLabels(), d = (a && a.deps) || {};
	var pkgs = [], feedNote = [];
	missing.forEach(function(k) {
		var it = L[k]; if (!it) return;
		pkgs.push(it.pkg);
		var feedKey = 'feed_' + it.feed;
		if (it.feed !== 'base' && !d[feedKey]) feedNote.push(it.feed);
	});
	var cmd = pkgs.length ? 'apk update && apk add ' + pkgs.join(' ') : '';
	var extra = '';
	if (feedNote.length) {
		var mirrors = 'https://mirrors.tencent.com/openwrt/releases/<版本>/packages/<架构>/';
		extra = _('（缺 %s 软件源，先用镜像补源再装：%s）').format(feedNote.join('/'), mirrors);
	}
	return { cmd: cmd, note: extra, pkgs: pkgs };
}
function buildPlan(a) {
	/* 核心: 现状可用档 + 补齐依赖档 */
	var defs = modeDefs();
	var now = [], full = [];
	defs.forEach(function(m) {
		var miss = depsMissing(m, a);
		miss.length ? full.push(m) : now.push(m);
	});
	now.sort(function(x, y) { return modeScore(x, a) - modeScore(y, a); });
	full.sort(function(x, y) { return modeScore(x, a) - modeScore(y, a); });
	var best = now[0] || defs[0];
	var candidates = now.slice(1);
	var fullBest = full[0] || null;
	var fullMiss = fullBest ? depsMissing(fullBest, a) : [];
	return {
		now: { best: best, why: modeWhy(best, a), candidates: candidates.map(function(m) { return { m: m, why: modeWhy(m, a) }; }) },
		full: fullBest ? { best: fullBest, why: modeWhy(fullBest, a), missing: fullMiss, hint: installHint(fullMiss, a) } : null
	};
}

/* cpu online ("0-3"/"0-7") → 核数 */
function parseCpuRange(txt) {
	var m = (txt || '0-3').trim().match(/(\d+)-(\d+)/);
	if (m) return Math.min(32, +m[2] - +m[1] + 1);
	var single = (txt || '').trim().split(/[\s,]+/).filter(Boolean);
	return single.length || 4;
}

/* uci get 结果 → IFACES; 读不到时退回经典三口 */
function buildIfaces(uciRes) {
	var out = [];
	var vals = (uciRes && uciRes.values) || null;
	if (vals) {
		Object.keys(vals).forEach(function(sec) {
			var s = vals[sec];
			if (s['.type'] !== 'interface') return;
			out.push({
				dev: s.iface || sec,
				sec: sec,
				note: s.note || '',
				virtual: !!s.virtual
			});
		});
	}
	if (!out.length) {
		out = [
			{ dev: 'eth0',      sec: 'eth0',      note: 'WAN 物理口', virtual: false },
			{ dev: 'eth1',      sec: 'eth1',      note: 'LAN 物理口', virtual: false },
			{ dev: 'pppoe-wan', sec: 'pppoe_wan', note: 'PPPoE 拨号口 · 重拨自动保持', virtual: true }
		];
	}
	return out;
}

return view.extend({
	/* 本页所有改动即时生效, 无 Save&Apply 概念; 覆盖基类方法干掉自动 footer 按钮组 */
	addFooter: function() {
		return E([]);
	},

	load: function() {
		/* 先探测环境 (核数 + uci 接口表), 再按接口数读运行态
		 * values 布局: [0]=meta, [1+2i]=rps, [2+2i]=xps, [1+2N]=softirqs, [2+2N]=state.json */
		return Promise.all([
			L.resolveDefault(fs.read('/sys/devices/system/cpu/online'), '0-3'),
			ubusCall('uci', 'get', { config: 'netsteer' }).catch(function() { return null; })
		]).then(function(meta) {
			var cpuTxt = (meta[0] && meta[0].data) ? meta[0].data : meta[0];
			NCPU = parseCpuRange(typeof cpuTxt === 'string' ? cpuTxt : '0-3');
			IFACES = buildIfaces(meta[1]);
			var autotuneDone = !!(meta[1] && meta[1].values && meta[1].values.global && meta[1].values.global.autotune_done);
			var tasks = [ Promise.resolve({ ncpu: NCPU, ifaces: IFACES, autotuneDone: autotuneDone }) ];
			IFACES.forEach(function(it) {
				tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus'), null));
				tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/tx-0/xps_cpus'), null));
			});
			tasks.push(L.resolveDefault(fs.read('/proc/softirqs'), ''));
			tasks.push(L.resolveDefault(fs.read('/tmp/netsteer/state.json'), null));
			/* P2P 直通状态: 独立脚本输出 JSON (脚本不在时静默降级为关) */
			tasks.push(fs.exec('/usr/bin/netsteer-p2p', ['status']).then(function(r) {
				try { return JSON.parse((r && r.stdout || '').trim()); } catch (e) { return null; }
			}).catch(function() { return null; }));
			/* 游戏通道状态 (脚本不在 = 老版本包 → 静默) */
			tasks.push(fs.exec('/usr/bin/netsteer-qos', ['status']).then(function(r) {
				try { return JSON.parse((r && r.stdout || '').trim()); } catch (e) { return null; }
			}).catch(function() { return null; }));
			return Promise.all(tasks);
		});
	},

	/* ---- 软中断分布卡 (首页 Memory 卡同款: 大数字 + 堆叠条 + 图例) ---- */
		/* ================= 总览仪表盘 (cFos Speed 定位: 一眼看到网络健康) ================= */
	loadVtCss: function() {
		/* 复用主题仪表盘的设计 token (同 overview.js 的 adoptedStyleSheets 机制) */
		if (this._vtCssP) return this._vtCssP;
		this._vtCssP = fetch(L.resource('vantage/app.css'), { cache: 'no-cache' })
			.then(function(r) { return r.ok ? r.text() : ''; })
			.then(function(text) {
				if (text && ('adoptedStyleSheets' in document) && typeof CSSStyleSheet === 'function') {
					var sheet = new CSSStyleSheet();
					sheet.replaceSync(text);
					document.adoptedStyleSheets = document.adoptedStyleSheets.concat([sheet]);
				}
			}).catch(function() {});
		return this._vtCssP;
	},

	reducedMotion: function() {
		return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
	},

	/* 加速总开关: 一键启停全部优化 + 真实 A/B 基线增益 (关闭态基线 vs 开启态实测) */
	renderMaster: function() {
		var el = E('div', { 'class': 'vt-tile ns-master', 'id': 'ns-master' }, [
			E('div', { 'class': 'vt-tile-head' }, [
				E('span', { 'class': 'vt-tile-title' }, _('加速总开关')),
				E('span', { 'class': 'vt-hint ns-master-state' }, _('读取中…'))
			]),
			E('div', { 'class': 'ns-master-body' }, [
				E('button', { 'type': 'button', 'class': 'ns-toggle', 'id': 'ns-toggle' }, [
					E('span', { 'class': 'ns-toggle-knob' })
				]),
				E('div', { 'class': 'ns-master-info' }, [
					E('p', { 'class': 'ns-master-desc' }, _('开启后应用 cake 整形 + 全核分摊 + P2P 直通；关闭则恢复系统默认，用于建立对比基线。')),
					E('p', { 'class': 'ns-master-gain', 'id': 'ns-master-gain' }, '')
				])
			])
		]);
		var selfM = this;
		/* 状态 + 基线一次拉齐 (bench 基线走 uci 通道, 稳定秒回) */
		Promise.all([
			fs.exec('/usr/bin/netsteer-mode', ['status']).then(function(r) { try { return JSON.parse((r.stdout || '').trim()); } catch (e) { return { mode: null, prev: 'p2p' }; } }),
			selfM.uciNetsteer().then(function(c) { return benchFromUci(c); }).catch(function() { return null; })
		]).then(function(res) { selfM.paintMaster(el, res[0], res[1]); });
		el.querySelector('#ns-toggle').addEventListener('click', function() { selfM.confirmToggle(el); });
		return el;
	},

	uciNetsteer: function() {
		return ubusCall('uci', 'get', { config: 'netsteer' }).then(function(sec) {
			return (sec && sec.values) || null;
		});
	},

	paintMaster: function(el, st, bench) {
		if (!el || !document.getElementById('ns-master')) return;
		var on = st && st.mode && st.mode !== 'off';
		var knob = el.querySelector('.ns-toggle');
		if (knob) knob.classList.toggle('on', !!on);
		var stateEl = el.querySelector('.ns-master-state');
		if (stateEl) stateEl.textContent = on
			? _('已开启 · %s').format(st.mode.toUpperCase())
			: _('已关闭 · 基线模式');
		var gainEl = el.querySelector('#ns-master-gain');
		if (gainEl) {
			var off = bench && bench.off, cur = bench && bench.on;
			if (off && cur && cur.latency_ms != null && off.latency_ms != null) {
				var dLat = off.latency_ms - cur.latency_ms;
				var latPct = off.latency_ms > 0 ? Math.round(dLat / off.latency_ms * 100) : 0;
				var g = [];
				if (off.latency_ms > 0 && cur.latency_ms > 0) {
					if (latPct === 0) {
						g.push(_('延迟持平（%s ms）').format(cur.latency_ms.toFixed(1)));
					} else {
						g.push(dLat >= 0
							? _('延迟 ↓%d%%（%s → %s ms）').format(latPct, off.latency_ms.toFixed(1), cur.latency_ms.toFixed(1))
							: _('延迟 ↑%d%%（%s → %s ms）').format(-latPct, off.latency_ms.toFixed(1), cur.latency_ms.toFixed(1)));
					}
				}
				if (off.rx_bps > 1e5 && cur.rx_bps > 1e5) { /* 双侧都有实流量才比吞吐 */
					var tPct = Math.round((cur.rx_bps - off.rx_bps) / off.rx_bps * 100);
					g.push(tPct >= 0 ? _('吞吐 +%d%%').format(tPct) : _('吞吐 %d%%').format(tPct));
				}
				gainEl.textContent = g.length ? _('实测增益（vs 关闭基线）：') + g.join(' · ') : _('基线已存，增益待流量上来后重测');
				gainEl.classList.add('ns-has-gain');
			} else if (on) {
				gainEl.textContent = _('增益基线未建立：关闭一次总开关自动测量基线，再开启后显示真实差值');
			} else {
				gainEl.textContent = _('基线模式中 — 约 20 秒完成基线测量');
			}
		}
	},

	confirmToggle: function(el) {
		var selfC = this;
		var knob = el.querySelector('.ns-toggle');
		var turnOn = !knob.classList.contains('on');
		var bodyMsg = turnOn
			? _('确认开启？将应用上次的加速方案（整形 + 分核 + P2P 直通），切换有几秒瞬断，完成后自动测量增益。')
			: _('确认关闭？将停用全部优化（关闭 cake 整形/分核/P2P 直通）回到系统默认，用于建立对比基线 — 约 20 秒。');
		var modal = E('div', { 'class': 'modal' }, [
			E('p', { 'class': 'ns-modal-title' }, turnOn ? _('开启加速') : _('关闭加速（建立基线）')),
			E('p', { 'class': 'ns-modal-body' }, bodyMsg),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn', 'click': function() { document.body.removeChild(modal); } }, _('取消')),
				E('button', { 'class': 'btn important', 'click': function() {
					document.body.removeChild(modal);
					selfC.applyMaster(el, turnOn);
				} }, _('确认'))
			])
		]);
		document.body.appendChild(modal);
	},

	applyMaster: function(el, turnOn) {
		var selfA = this;
		var stateEl = el.querySelector('.ns-master-state');
		var gainEl = el.querySelector('#ns-master-gain');
		if (stateEl) stateEl.textContent = _('执行中，请稍候…');
		if (gainEl) gainEl.textContent = '';
		var t0 = Math.floor(Date.now() / 1000) - 5;
		fs.exec('/usr/bin/netsteer-mode', ['status']).then(function(r0) {
			var st0 = null; try { st0 = JSON.parse((r0.stdout || '').trim()); } catch (e) {}
			var prev = (st0 && st0.prev) || 'p2p';
			return fs.exec('/usr/bin/netsteer-mode', turnOn ? [prev] : ['off']);
		}).then(function(r1) {
			/* 基线测量由 netsteer-mode 后台 spawn (不占 rpcd exec 通道) */
			if (stateEl) stateEl.textContent = _('测量基线中（约 20 秒）…');
			/* 轮询读结果: 新 bench 文件落盘即刷新增益 */
			var tries = 0;
			var timer = window.setInterval(function() {
				tries++;
				selfA.uciNetsteer().then(function(c) {
					var b = benchFromUci(c);
					var side = turnOn ? (b && b.on) : (b && b.off);
					if (b && side && side.ts >= t0) {
						window.clearInterval(timer);
						fs.exec('/usr/bin/netsteer-mode', ['status']).then(function(r3) {
							var st = null; try { st = JSON.parse((r3.stdout || '').trim()); } catch (e) {}
							selfA.paintMaster(el, st, b);
						});
					}
				}).catch(function() {});
				if (tries > 15) window.clearInterval(timer);
			}, 6000);
		}).catch(function(err) {
			if (stateEl) stateEl.textContent = _('操作失败：%s').format(String(err && err.message || err).slice(0, 80));
		});
	},

	/* 路径图: 互联网 → WAN → 核心(CPU×N) → LAN → 内网, 粒子沿贝塞尔流动 */
	renderWires: function() {
		var self = this;
		var svgNS = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(svgNS, 'svg');
		var narrow = window.matchMedia('(max-width: 640px)').matches;
		svg.setAttribute('viewBox', narrow ? '0 0 450 108' : '0 0 860 104');
		svg.setAttribute('class', 'ns-wires-svg' + (narrow ? ' ns-narrow' : ''));
		var mk = function(tag, attrs) {
			var el = document.createElementNS(svgNS, tag);
			for (var k in attrs) el.setAttribute(k, attrs[k]);
			return el;
		};
		/* 节点: 窄屏用紧凑坐标系 (viewBox 缩放文字保持可读) */
		var nodes = narrow ? [
			{ id: 'net', x: 6,   w: 86, t: _('互联网'), s: 'WAN' },
			{ id: 'cpu', x: 156, w: 118, t: _('路由核心'), s: NCPU + ' 核' },
			{ id: 'lan', x: 358, w: 86, t: _('局域网'), s: 'LAN' }
		] : [
			{ id: 'net', x: 10,   w: 96, t: _('互联网'), s: 'WAN' },
			{ id: 'cpu', x: 288,  w: 200, t: _('路由核心'), s: NCPU + ' cores' },
			{ id: 'lan', x: 754,  w: 96, t: _('局域网'), s: 'LAN' }
		];
		/* 主题同款 router 图标 (vantage ICONS.router, 24x24 stroke 风格) */
		var ROUTER_ICON = [
			'M4.5 13h15a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1Z',
			'M7 16h.01M10 16h.01',
			'M8 13 6 6.5M16 13l2-6.5'
		];
		nodes.forEach(function(n) {
			var g = mk('g', {});
			g.appendChild(mk('rect', { x: n.x, y: narrow ? 26 : 28, width: n.w, height: narrow ? 56 : 62, rx: 8,
				'class': 'ns-node' + (n.id === 'cpu' ? ' ns-node-hub' : ''), 'data-node': n.id }));
			var t1 = mk('text', { x: n.x + n.w/2, y: narrow ? 51 : 55, 'text-anchor': 'middle', 'class': 'ns-node-t' });
			t1.textContent = n.t;
			var t2 = mk('text', { x: n.x + n.w/2, y: narrow ? 69 : 74, 'text-anchor': 'middle', 'class': 'ns-node-s' });
			t2.textContent = n.s;
			g.appendChild(t1); g.appendChild(t2);
			/* 路由核心: 路由器图标放左侧 (主题色描边, 原生 24px) */
			if (n.id === 'cpu') {
				var ib = mk('g', { 'class': 'ns-node-ico',
					transform: 'translate(' + (narrow ? n.x + 8 : n.x + 16) + ',' + (narrow ? 42 : 47) + ') scale(1)' });
				ROUTER_ICON.forEach(function(d) {
					ib.appendChild(mk('path', { d: d, 'class': 'ns-node-ico-p' }));
				});
				g.appendChild(ib);
				/* 文字改左对齐, 让出图标位 */
				t1.setAttribute('x', narrow ? n.x + 38 : n.x + 48);
				t1.setAttribute('text-anchor', 'start');
				t2.setAttribute('x', narrow ? n.x + 38 : n.x + 48);
				t2.setAttribute('text-anchor', 'start');
			}
			svg.appendChild(g);
		});
		/* 连线: 左中右两段 (粒子容器) */
		[['net','cpu'], ['cpu','lan']].forEach(function(pair, i) {
			var a = nodes[i], b = nodes[i+1];
			var yc = narrow ? 54 : 59;
			var pts = wiresPathH(a.x + a.w, yc, b.x, yc);
			var d = 'M' + pts.map(function(p) { return p[0].toFixed(1) + ' ' + p[1].toFixed(1); }).join('L');
			svg.appendChild(mk('path', { d: d, 'class': 'ns-wire' }));
			var rs = wiresResample(pts, 16);
			var lane = mk('g', { 'class': 'ns-lane', 'data-lane': i ? 'lan' : 'wan' });
			/* 粒子: 沿路径流动 (速度模型与主题一致 — 恒定线速度: 32px / PERIOD[档] ms) */
			var TRIP = rs.len / 32 * 1050;
			lane.setAttribute('data-trip', String(Math.round(TRIP)));
			rs.pts.forEach(function(p, k) {
				var dot = mk('circle', { cx: 0, cy: 0, r: narrow ? 3.4 : 3, 'class': 'ns-dot' });
				lane.appendChild(dot);
				var frames = rs.pts.slice(k).concat(rs.pts.slice(0, k + 1)).map(function(q) {
					return { transform: 'translate(' + q[0].toFixed(1) + 'px,' + q[1].toFixed(1) + 'px)' };
				});
				try {
					var anim = dot.animate(frames, { duration: TRIP, iterations: Infinity, easing: 'linear' });
					if (!self.reducedMotion()) anim.play();
				} catch (e) {}
			});
			svg.appendChild(lane);
		});
		/* 速率读数 (挂在两段连线中点) */
		/* 速率读数挂线段中点 (居中, 不偏左) */
		[['wan', nodes[0], nodes[1]], ['lan', nodes[1], nodes[2]]].forEach(function(seg) {
			var mid = (seg[1].x + seg[1].w + seg[2].x) / 2;
			var t = mk('text', { x: mid, y: narrow ? 20 : 22, 'text-anchor': 'middle', 'class': 'ns-wire-rate', 'data-rate': seg[0] });
			t.textContent = '—';
			svg.appendChild(t);
		});
		return E('div', { 'class': 'vt-tile ns-wires', 'id': 'ns-wires' }, [
			E('div', { 'class': 'vt-tile-head' }, [
				E('span', { 'class': 'vt-tile-title' }, _('网络路径')),
				E('span', { 'class': 'vt-hint' }, _('粒子速度 = 实时流量 (三档)')),
			]),
			svg,
			E('p', { 'class': 'vt-hint ns-wires-foot' }, _('速率 = 各网口下载方向实时速率；粒子速度随流量三档加速'))
		]);
	},

	setWireRate: function(lane, bps) {
		var el = document.querySelector('#ns-wires [data-rate="' + lane + '"]');
		if (!el) return;
		el.textContent = fmtBps(bps);
		el.classList.toggle('ns-busy', bps != null && bps > 5e6);
		/* 速度三档与主题同基准 (恒线速): 档周期 1600/1050/600ms, rate = 1050/周期 */
		var period = bps == null ? 1600 : bps > 100e6 ? 600 : bps > 5e6 ? 1050 : 1600;
		var laneEl = document.querySelector('#ns-wires .ns-lane[data-lane="' + lane + '"]');
		if (laneEl) laneEl.querySelectorAll('.ns-dot').forEach(function(dot) {
				(dot.getAnimations ? dot.getAnimations() : []).forEach(function(a) {
					try {
						a.playbackRate = 1050 / period;
						if (a.playState === 'paused' && !self.reducedMotion()) a.play();
					} catch (e) {}
				});
			});
	},

	/* 吞吐量时序卡: 上下行双曲线 (5s 采样, 90 点窗), SVG 面积图 */
	renderTraffic: function() {
		this._series = { rx: [], tx: [], last: null };
		this._benchOff = null;
		var selfT = this;
		selfT.uciNetsteer().then(function(c) {
			var b = benchFromUci(c);
			if (b && b.off && b.off.rx_bps > 0) selfT._benchOff = b.off.rx_bps;
		}).catch(function() {});
		var svgNS2 = 'http://www.w3.org/2000/svg';
		var svg = document.createElementNS(svgNS2, 'svg');
		svg.setAttribute('viewBox', '0 0 640 130');
		svg.setAttribute('preserveAspectRatio', 'none');
		svg.setAttribute('class', 'ns-traffic-svg ns-empty');
		/* 空态骨架: 三条横向刻度线 + 占位区 (有数据后随 ns-empty 移除而隐藏) */
		[34, 66, 98].forEach(function(yy) {
			var ln = document.createElementNS(svgNS2, 'line');
			ln.setAttribute('x1', 0); ln.setAttribute('x2', 640);
			ln.setAttribute('y1', yy); ln.setAttribute('y2', yy);
			ln.setAttribute('class', 'ns-skeleton');
			svg.appendChild(ln);
		});
		var holder = document.createElementNS(svgNS2, 'rect');
		holder.setAttribute('x', 60); holder.setAttribute('y', 40);
		holder.setAttribute('width', 520); holder.setAttribute('height', 40);
		holder.setAttribute('rx', 8); holder.setAttribute('class', 'ns-skeleton-block');
		svg.appendChild(holder);
		svg.appendChild(document.createElementNS(svgNS2, 'path')).setAttribute('class', 'ns-area-rx');
		svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path')).setAttribute('class', 'ns-line-rx');
		svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path')).setAttribute('class', 'ns-area-tx');
		svg.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'path')).setAttribute('class', 'ns-line-tx');
		return E('div', { 'class': 'vt-tile ns-traffic', 'id': 'ns-traffic' }, [
			E('div', { 'class': 'vt-tile-head' }, [
				E('span', { 'class': 'vt-tile-title' }, _('吞吐量')),
				E('span', { 'class': 'vt-hint' }, _('每 5 秒采样 · 近 7.5 分钟'))
			]),
			E('div', { 'class': 'ns-traffic-nums' }, [
				E('div', { 'class': 'ns-traffic-num' }, [ E('i', { 'class': 'ns-sw', 'style': 'background:var(--vt-chart-1,var(--accent,#3563e9))' }), E('span', { 'class': 'vt-hint' }, _('下行')), E('b', { 'class': 'vt-tn ns-num-rx' }, '—') ]),
				E('div', { 'class': 'ns-traffic-num' }, [ E('i', { 'class': 'ns-sw', 'style': 'background:repeating-linear-gradient(90deg,var(--vt-chart-2,#2a78d6) 0 5px,transparent 5px 8px)' }), E('span', { 'class': 'vt-hint' }, _('上行')), E('b', { 'class': 'vt-tn ns-num-tx' }, '—') ]),
				E('div', { 'class': 'ns-traffic-num' }, [ E('i', { 'class': 'ns-sw', 'style': 'background:repeating-linear-gradient(90deg,var(--vt-accent,#c8f031) 0 2px,transparent 2px 6px)' }), E('span', { 'class': 'vt-hint' }, _('vs 基线')) ])
			]),
			svg,
			E('div', { 'class': 'vt-hint ns-traffic-foot' }, _('基线建立中 — 约 10 秒后出现第一条曲线'))
		]);
	},

	pollTraffic: function() {
		if (!document.getElementById('ns-traffic')) return;
		var self = this;
		return fs.exec('/usr/bin/netsteer-netdev', []).then(function(res) {
			var d = null;
			try { d = JSON.parse((res && res.stdout) || '{}'); } catch (e) {}
			if (!d || !d.rows) return;
			var cur = {}, i;
			for (i = 0; i < d.rows.length; i++)
				cur[d.rows[i].dev] = { rx: +d.rows[i].rx, tx: +d.rows[i].tx };
			var now = d.ts || Date.now();
			if (now < 1e12) now *= 1000; /* busybox date 只给秒 */
			var st = self._series;
			if (st.last && cur.eth0) {
				var dt = now - st.last.t;
				if (dt >= 2500 && dt <= 30000) {
					var dd = netdevDelta(st.last.d, cur, dt);
					var rx = dd.eth0 ? dd.eth0.rx_bps : null;
					var tx = dd.eth0 ? dd.eth0.tx_bps : null;
					st.rx = seriesPush(st.rx, [now, rx], 7.5 * 60 * 1000, 90);
					st.tx = seriesPush(st.tx, [now, tx], 7.5 * 60 * 1000, 90);
					self.drawTraffic();
					self.setWireRate('lan', rx);
					self.setWireRate('wan', dd.eth1 ? dd.eth1.rx_bps : null);
				}
			}
			st.last = { t: now, d: cur };
		}).catch(function() {});
	},

	drawTraffic: function() {
		var svg = document.querySelector('#ns-traffic .ns-traffic-svg');
		var st = this._series;
		if (!svg || st.rx.length < 2) return;
		svg.classList.remove('ns-empty');
		var W = 640, H = 130;
		var segs = function(sr, vmax) {
			var out = [], curSeg = null, span = st.rx[st.rx.length-1][0] - st.rx[0][0] || 1;
			sr.forEach(function(p) {
				var x = (p[0] - st.rx[0][0]) / span * W;
				var y = p[1] == null ? null : H - Math.min(1, p[1] / vmax) * (H - 8) - 2;
				if (y == null) { curSeg = null; return; }
				if (!curSeg) { curSeg = []; out.push(curSeg); }
				curSeg.push([Math.round(x*10)/10, Math.round(y*10)/10]);
			});
			return out;
		};
		var peak = niceCeil(Math.max(1e5,
			seriesStatsMax(st.rx) || 0, seriesStatsMax(st.tx) || 0) * 1.05);
		var line = function(s) {
			return s.filter(function(x) { return x.length > 1; }).map(function(x) {
				return 'M' + x.map(function(pt) { return pt[0] + ' ' + pt[1]; }).join('L');
			}).join('');
		};
		var area = function(s) {
			return s.filter(function(x) { return x.length > 1; }).map(function(x) {
				return 'M' + x[0][0] + ' ' + H + 'L' + x.map(function(pt) { return pt[0] + ' ' + pt[1]; }).join('L') + 'L' + x[x.length-1][0] + ' ' + H + 'Z';
			}).join('');
		};
		var sr = segs(st.rx, peak), stx = segs(st.tx, peak);
		/* 坐标层: 全宽网格 + y 量程 + x 时间标注 (专业图表要素) */
		var grid = svg.querySelector('.ns-grid-g');
		if (!grid) {
			grid = document.createElementNS('http://www.w3.org/2000/svg', 'g');
			grid.setAttribute('class', 'ns-grid-g');
			[0.25, 0.5, 0.75].forEach(function(f) {
				var ln = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				ln.setAttribute('x1', 0); ln.setAttribute('x2', 640);
				ln.setAttribute('class', 'ns-grid');
				ln.setAttribute('data-f', f);
				grid.appendChild(ln);
			});
			var ycap = document.createElementNS('http://www.w3.org/2000/svg', 'text');
			ycap.setAttribute('x', 636); ycap.setAttribute('text-anchor', 'end');
			ycap.setAttribute('class', 'ns-axis-y');
			ycap.setAttribute('data-role', 'peak');
			grid.appendChild(ycap);
			[['-7.5m', 4], ['-3.5m', 320], ['now', 632]].forEach(function(pair) {
				var tx = document.createElementNS('http://www.w3.org/2000/svg', 'text');
				tx.setAttribute('x', pair[1]); tx.setAttribute('y', 128);
				tx.setAttribute('text-anchor', pair[1] > 600 ? 'end' : (pair[1] < 20 ? 'start' : 'middle'));
				tx.setAttribute('class', 'ns-axis-x');
				tx.textContent = pair[0];
				grid.appendChild(tx);
			});
			svg.insertBefore(grid, svg.firstChild);
		}
		grid.querySelectorAll('.ns-grid').forEach(function(ln) {
			var f = +ln.getAttribute('data-f');
			ln.setAttribute('y1', Math.round(H - f * (H - 8) - 2));
			ln.setAttribute('y2', Math.round(H - f * (H - 8) - 2));
		});
		var ycapEl = grid.querySelector('[data-role="peak"]');
		if (ycapEl) ycapEl.textContent = fmtBps(peak);
		/* 增益层: vs 关闭基线的差值线 (真实测量, 正=超出基线的吞吐) */
		var gl = svg.querySelector('.ns-gain-line'), gz = svg.querySelector('.ns-gain-zero');
		var benchOff = this._benchOff;
		if (benchOff) {
			var y0 = H - Math.min(1, self._benchOff / peak) * (H - 8) - 2;
			if (!gz) {
				gz = document.createElementNS('http://www.w3.org/2000/svg', 'line');
				gz.setAttribute('class', 'ns-gain-zero');
				gz.setAttribute('x1', 0); gz.setAttribute('x2', 640);
				svg.appendChild(gz);
			}
			gz.setAttribute('y1', Math.round(y0)); gz.setAttribute('y2', Math.round(y0));
			if (!gl) {
				gl = document.createElementNS('http://www.w3.org/2000/svg', 'path');
				gl.setAttribute('class', 'ns-gain-line');
				svg.appendChild(gl);
			}
			/* 差值序列: y = y0 - (rx - base)/peak*(H-8), clamp */
			var gsegs = [];
			var curG = null;
			st.rx.forEach(function(p, idx) {
				if (p[1] == null) { curG = null; return; }
				var span2 = st.rx[st.rx.length-1][0] - st.rx[0][0] || 1;
				var x = (p[0] - st.rx[0][0]) / span2 * W;
				var y = y0 - (p[1] - benchOff) / peak * (H - 8);
				y = Math.max(3, Math.min(H - 3, y));
				if (!curG) { curG = []; gsegs.push(curG); }
				curG.push([Math.round(x*10)/10, Math.round(y*10)/10]);
			});
			gl.setAttribute('d', gsegs.filter(function(seg){return seg.length>1}).map(function(seg){
				return 'M' + seg.map(function(pt){return pt[0]+' '+pt[1]}).join('L');
			}).join(''));
		}
		svg.querySelector('.ns-area-rx').setAttribute('d', area(sr));
		svg.querySelector('.ns-line-rx').setAttribute('d', line(sr));
		svg.querySelector('.ns-area-tx').setAttribute('d', area(stx));
		svg.querySelector('.ns-line-tx').setAttribute('d', line(stx));
		var lastRx = st.rx[st.rx.length-1][1], lastTx = st.tx[st.tx.length-1][1];
		var nx = document.querySelector('#ns-traffic .ns-num-rx'), ntx = document.querySelector('#ns-traffic .ns-num-tx');
		if (nx) nx.textContent = fmtBps(lastRx);
		if (ntx) ntx.textContent = fmtBps(lastTx);
		var foot = document.querySelector('#ns-traffic .ns-traffic-foot');
		var pk = function(a) { return Math.max.apply(null, a.map(function(p) { return p[1] || 0; }).concat([0])); };
		if (foot) foot.textContent = _('峰值 ↓%s · ↑%s · 量程 %s').format(fmtBps(pk(st.rx)), fmtBps(pk(st.tx)), fmtBps(peak));
	},

	/* health 卡: 三格 (软中断集中度 / 整形 / 转发链路) */
	renderHealth: function(a) {
		var d = (a && a.deps) || {}, sq = (a && a.sqm) || {}, o = (a && a.offload) || {}, pp = (a && a.p2p) || {};
		var card = function(title, val, cls, hint) {
			return E('div', { 'class': 'vt-dcard ns-hc ' + (cls || '') }, [
				E('span', { 'class': 'vt-dcard-label' }, title),
				E('b', { 'class': 'vt-dcard-value vt-tn' }, val),
				E('span', { 'class': 'vt-dcard-sub' }, hint)
			]);
		};
		var softirqTxt = (a && a.softirq_conc != null)
			? a.softirq_conc + '%' : '—';
		var sqmVal = !d.sqm_scripts ? _('未安装') : (sq.cake_running ? _('cake 整形中') : (sq.enabled ? _('已启用') : _('关闭')));
		var fwd = [];
		if (o.flow) fwd.push(_('分载开'));
		if (pp.active) fwd.push(_('P2P 直通'));
		var mode = 'steering';
		return E('div', { 'class': 'vt-health ns-health' }, [
			card(_('收包集中度'), softirqTxt,
				a && a.softirq_conc != null && a.softirq_conc > (a.softirq_warn || 45) ? 'ns-bad' : 'ns-good',
				a && a.softirq_conc != null ? (a.softirq_conc > (a.softirq_warn || 45) ? _('单核偏热 — 建议调 IRQ') : _('分布均衡')) : _('采样中')),
			card(_('智能队列'), sqmVal, sq.cake_running ? 'ns-good' : '', d.sqm_scripts ? _('SQM 引擎') : _('可补装解锁')),
			card(_('转发链路'), fwd.length ? fwd.join(' · ') : _('标准转发'), 'ns-good', _('流量分载 · P2P · 分核'))
		]);
	},


	renderIrqCard: function(irqJson) {
		var self = this;
		var list = parseIrqList(irqJson);
		var kids = [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('strong', { 'class': 'netsteer-card-title' }, _('中断亲和设置')),
				E('button', {
					'class': 'netsteer-minibtn', 'type': 'button',
					'click': ui.createHandlerFn(this, 'reloadIrqCard')
				}, _('刷新'))
			]),
			E('p', { 'class': 'netsteer-note' }, _('网卡中断固定由哪些核处理。单队列网卡内核只会让掩码里的那颗核响应中断 — 把 eth0/eth1 的中断错开到不同核，配合 RPS 分摊可避免两块网卡挤同一个核。点选 CPU 芯片组合掩码后应用；改变即时生效并写入持久配置。'))
		];
		if (!list.length) {
			kids.push(E('p', { 'class': 'netsteer-note', 'style': 'color:#d35400' },
				_('未发现网卡中断（虚拟机或 USB 网卡场景常见 — 后者中断常挂在 USB 控制器下）。')));
		}
		list.forEach(function(it) {
			var chips = cpuRange().map(function(cpu) {
				var m = irqMaskOfCpu(cpu);
				var on = ((parseInt(it.affinity, 16) >> cpu) & 1) === 1;
				return E('button', {
					'class': 'netsteer-chip' + (on ? ' on' : ''),
					'type': 'button',
					'data-irq': it.irq, 'data-cpu': cpu,
					'click': function(ev) { ev.target.classList.toggle('on'); }
				}, 'C' + cpu);
			});
			kids.push(E('div', { 'class': 'netsteer-card', 'style': 'margin:8px 0', 'id': 'netsteer-irq-row-' + it.irq }, [
				E('div', { 'style': 'display:flex;justify-content:space-between;align-items:center;gap:8px' }, [
					E('span', {}, [ E('strong', {}, _('IRQ %s').format(it.irq)), ' · ' + it.dev ]),
					E('span', { 'class': 'netsteer-note' }, _('累计 %s 次').format(fmtCount(it.counts)))
				]),
				E('div', { 'class': 'netsteer-row', 'style': 'margin:.5em 0;display:flex;gap:6px;align-items:center;flex-wrap:wrap' },
					chips.concat([
						E('button', {
							'class': 'netsteer-minibtn', 'type': 'button',
							'click': ui.createHandlerFn(self, 'applyIrqMask', it.irq)
						}, _('应用'))
					])),
				E('p', { 'class': 'netsteer-note', 'id': 'netsteer-irq-res-' + it.irq, 'style': 'margin:2px 0 0 0' }, '')
			]));
		});
		return E('div', { 'class': 'netsteer-card', 'id': 'netsteer-irq-card' }, kids);
	},

	reloadIrqCard: function() {
		var self = this;
		return fs.exec('/usr/bin/netsteer-irq', ['get']).then(function(r) {
			var old = document.getElementById('netsteer-irq-card');
			if (old && old.parentNode)
				old.parentNode.replaceChild(self.renderIrqCard((r && r.stdout) || ''), old);
		});
	},

	applyIrqMask: function(irq, ev) {
		var self = this;
		var row = document.getElementById('netsteer-irq-row-' + irq);
		var mask = 0;
		if (row) row.querySelectorAll('.netsteer-chip.on').forEach(function(ch) {
			mask |= (1 << (+ch.getAttribute('data-cpu')));
		});
		var res = document.getElementById('netsteer-irq-res-' + irq);
		if (!mask) {
			if (res) { res.style.color = '#c0392b'; res.textContent = _('至少选一个 CPU'); }
			return;
		}
		var hex = mask.toString(16);
		if (res) { res.style.color = '#2471a3'; res.textContent = _('应用中…'); }
		return fs.exec('/usr/bin/netsteer-irq', ['set', irq, hex]).then(function(r) {
			var out = {};
			try { out = JSON.parse(((r && r.stdout) || '').trim()); } catch (e) {}
			/* 先 reload 拿新卡, 再往新卡的反馈位写结果 (旧节点已被替换) */
			return self.reloadIrqCard().then(function() {
				var r2 = document.getElementById('netsteer-irq-res-' + irq);
				if (!r2) return;
				if (out.ok) {
					r2.style.color = '#1e8449';
					r2.textContent = _('✓ 已生效: %s → %s%s').format(out.before || '?', out.after || hex,
						out.uci_sync ? '（已持久化）' : '');
				} else {
					r2.style.color = '#c0392b';
					r2.textContent = _('✗ %s（掩码保持 %s）').format(out.error || 'failed', out.after || out.before || '?');
				}
			});
		}).catch(function(e) {
			var r3 = document.getElementById('netsteer-irq-res-' + irq);
			if (r3) { r3.style.color = '#c0392b'; r3.textContent = String(e); }
		});
	},

renderSoftirqCard: function(text) {
		var d = parseSoftirq(text);
		var rx = d.rx.slice(0, NCPU), tx = d.tx.slice(0, NCPU);
		var rxSum = rx.reduce(function(a, b) { return a + b; }, 0);
		var conc = null, concCpu = null;
		if (rxSum > 0) {
			var maxI = 0;
			rx.forEach(function(c, i) { if (c > rx[maxI]) maxI = i; });
			conc = Math.round(rx[maxI] * 100 / rxSum);
			concCpu = maxI;
		}
		/* 均衡时各核 ~100/N%; 超过 1.8 倍视为明显集中 */
		var warnLine = Math.round(180 / NCPU);
		var concCls = (conc === null) ? '' : (conc > warnLine ? ' is-bad' : ' is-ok');
		return E('div', { 'class': 'netsteer-card netsteer-softirq', 'id': 'netsteer-softirq-card' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('strong', { 'class': 'netsteer-card-title' }, _('软中断负载分布')),
				E('button', {
					'class': 'netsteer-minibtn',
					'type': 'button',
					'click': ui.createHandlerFn(this, 'refreshSoftirq')
				}, _('刷新')),
				E('button', {
					'class': 'netsteer-minibtn',
					'type': 'button',
					'id': 'netsteer-irq-delta-btn',
					'click': ui.createHandlerFn(this, 'toggleSoftirqDelta')
				}, _('开始对比'))
			]),
			E('div', { 'class': 'netsteer-conc' }, [
				conc === null
					? E('span', { 'class': 'netsteer-big' }, '—')
					: E('span', { 'class': 'netsteer-big' + concCls }, '%d%%'.format(conc)),
				E('span', { 'class': 'netsteer-note' },
					conc === null
						? _('开机以来暂无收包计数')
						: _('收包负载集中在 CPU%d。%d 核分摊生效时应接近 %d%%；越集中越需要调整。'.format(concCpu, NCPU, Math.round(100 / NCPU))))
			]),
			E('div', { 'class': 'netsteer-sq-row' }, [
				E('span', { 'class': 'netsteer-sq-label' }, _('收包 NET_RX')),
				stackedBar(rx, ' 包'),
				E('span', { 'class': 'netsteer-sq-total' }, fmtCount(rxSum))
			]),
			E('div', { 'class': 'netsteer-sq-row' }, [
				E('span', { 'class': 'netsteer-sq-label' }, _('发包 NET_TX')),
				stackedBar(tx, ' 包'),
				E('span', { 'class': 'netsteer-sq-total' }, fmtCount(tx.reduce(function(a, b) { return a + b; }, 0)))
			]),
			legend(),
			E('div', { 'class': 'netsteer-foot' }, _('开机以来累计 · 点按或悬停色块查看各核明细'))
		]);
	},

	refreshSoftirq: function() {
		var self = this;
		return fs.read('/proc/softirqs').then(function(text) {
			var old = document.getElementById('netsteer-softirq-card');
			if (old && old.parentNode)
				old.parentNode.replaceChild(self.renderSoftirqCard(text || ''), old);
		}).catch(function(e) {
			ui.showModal(_('出错'), E('p', {}, String(e)));
		});
	},

	/* ---- 对比模式: 基线快照 → 增量分布 (验证调整效果的呈现方式) ---- */
	toggleSoftirqDelta: function(ev) {
		var self = this;
		var btn = document.getElementById('netsteer-irq-delta-btn');
		if (!this._softirqBaseline) {
			return fs.read('/proc/softirqs').then(function(text) {
				self._softirqBaseline = { text: text || '', t: Date.now() };
				if (btn) { btn.textContent = _('查看变化'); }
				var card = document.getElementById('netsteer-softirq-card');
				if (card) {
					var foot = card.querySelector('.netsteer-foot');
					var tip = document.getElementById('netsteer-irq-delta-tip');
					if (!tip && foot) {
						tip = E('p', { 'class': 'netsteer-note', 'id': 'netsteer-irq-delta-tip',
							'style': 'color:#2471a3;margin:4px 0 0 0' });
						foot.parentNode.insertBefore(tip, foot);
					}
					if (tip) tip.textContent = _('✓ 基线已记录 — 现在去调整 IRQ 亲和或跑一段流量，再点「查看变化」');
				}
			});
		}
		var base = this._softirqBaseline;
		return fs.read('/proc/softirqs').then(function(text) {
			var cur = text || '';
			var d = deltaSoftirq(base.text, cur);
			var secs = Math.max(1, Math.round((Date.now() - base.t) / 1000));
			self._softirqBaseline = null;
			if (btn) { btn.textContent = _('开始对比'); }
			var tip = document.getElementById('netsteer-irq-delta-tip');
			if (tip) {
				if (d.total === 0) {
					tip.style.color = '#d35400';
					tip.textContent = _('窗口 %d 秒内没有新收包 — 期间跑点流量再对比').format(secs);
				} else {
					tip.style.color = '#1e8449';
					tip.textContent = _('窗口 %d 秒: 新增 %s 个收包 → %d%% 集中在 CPU%d（此前全程集中度 %s）')
						.format(secs, fmtCount(d.total), d.rxConc, d.concCpu,
							d.baseRxConc === null ? '—' : d.baseRxConc + '%');
				}
			}
			/* 增量条替换 NET_RX 行的堆叠 (直观看到"新流量"的分布) */
			var card = document.getElementById('netsteer-softirq-card');
			if (card && d.total > 0) {
				var rows = card.querySelectorAll('.netsteer-sq-row');
				if (rows[0]) {
					var lbl = rows[0].querySelector('.netsteer-sq-label');
					var total = rows[0].querySelector('.netsteer-sq-total');
					var barWrap = rows[0].querySelector('.netsteer-stack');
					if (lbl && total && barWrap && barWrap.parentNode) {
						lbl.textContent = _('收包增量 Δ');
						barWrap.parentNode.replaceChild(stackedBar(d.rx.slice(0, NCPU), ' 包'), barWrap);
						total.textContent = fmtCount(d.total);
					}
				}
			}
		}).catch(function(e) {
			ui.showModal(_('出错'), E('p', {}, String(e)));
		});
	},

	/* ---- 接口卡: 现值 + CPU 芯片点选 ---- */
	renderIface: function(it, values, idx, state) {
		var self = this;
		var rpsNow = ((values[idx * 2] || '0') + '').trim() || '0';
		var xpsNow = ((values[idx * 2 + 1] || '0') + '').trim() || '0';
		var rpsCpus = maskToCpus(rpsNow), xpsCpus = maskToCpus(xpsNow);
		/* IRQ 现值: state.json 由 netsteer-apply 维护, 只给有硬件中断的口写记录
		 * (虚拟口/未应用时无记录 → 占位行) */
		var irqNow = (state && state[it.dev] && state[it.dev].affinity) || null;
		var irqRow;
		if (irqNow) {
			var irqOn = irqNow ? maskToCpus(irqNow) : cpuRange().map(function() { return false; });
			irqRow = E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('中断响应核 (IRQ)'),
					E('em', { 'class': 'netsteer-mask netsteer-irq-mask' }, irqNow ? maskLabel(irqNow) : _('—'))
				]),
				E('div', { 'class': 'netsteer-chips' }, cpuRange().map(function(i) {
					return E('button', {
						'class': 'netsteer-chip' + (irqOn[i] ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'irq', 'data-cpu': i,
						'title': 'CPU%d'.format(i),
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
			]);
		} else {
			irqRow = E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('中断响应核 (IRQ)'),
					E('em', { 'class': 'netsteer-mask' }, it.virtual ? _('虚拟接口 · 无硬件中断') : _('—'))
				])
			]);
		}
		return E('div', { 'class': 'netsteer-card' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('strong', { 'class': 'netsteer-card-title' }, it.dev),
				E('span', { 'class': 'netsteer-note' }, it.note)
			]),
			E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('收包 (RPS)'),
					E('em', { 'class': 'netsteer-mask' }, maskLabel(rpsNow))
				]),
				E('div', { 'class': 'netsteer-chips' }, rpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'rps', 'data-cpu': i,
						'title': 'CPU%d'.format(i),
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
			]),
			E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('发包 (XPS)'),
					E('em', { 'class': 'netsteer-mask' }, maskLabel(xpsNow))
				]),
				E('div', { 'class': 'netsteer-chips' }, xpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'xps', 'data-cpu': i,
						'title': 'CPU%d'.format(i),
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
			]),
			irqRow,
			E('div', { 'class': 'netsteer-foot' }, !it.virtual ? _('点选即生效 · 中断行： 单队列网卡，内核只会由所选核响应') : _('点选即生效'))
		]);
	},

	/* 芯片点选: 切换 on → 重算掩码 → 即时应用 (直调 ubus, 无 staged → 无悬浮条) */
	toggleCpu: function(ev) {
		var self = this;
		var node = ev.currentTarget;
		var sec = node.getAttribute('data-sec');
		var kind = node.getAttribute('data-kind');
		if (kind === 'irq') {
			/* IRQ 单选 (radio): 单队列网卡实际只在一个核应门，点谁谁独占 */
			document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="irq"]'.format(sec))
				.forEach(function(c) { c.classList.remove('on'); });
			node.classList.add('on');
		} else {
			node.classList.toggle('on');
		}
		var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="%s"]'.format(sec, kind));
		var arr = cpuRange().map(function() { return false; });
		chips.forEach(function(chip) {
			if (chip.classList.contains('on'))
				arr[+chip.getAttribute('data-cpu')] = true;
		});
		var maskLabelEl = node.closest('.netsteer-row').querySelector('.netsteer-mask');
		var opt = {};
		opt[kind + '_cpus'] = cpusToMask(arr);
		return applyNow([{ sec: sec, values: opt }])
			.then(function() {
				if (maskLabelEl) maskLabelEl.textContent = maskLabel(cpusToMask(arr));
				self.refreshBadge();
			})
			.catch(function(e) {
				node.classList.toggle('on');
				ui.showModal(_('出错'), E('p', {}, String(e)));
			});
	},

	/* 点芯片/预设后更新「当前模式」徽标 (读真实运行态: rps sysfs + IRQ state 文件) */
	refreshBadge: function() {
		var self = this;
		var el = document.getElementById('netsteer-badge');
		if (!el) return Promise.resolve();
		var tasks = IFACES.map(function(it) {
			return L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus'), '0')
				.then(function(v) { return ((v && v.data) ? v.data : String(v || '0')).trim(); });
		});
		tasks.push(L.resolveDefault(fs.read('/tmp/netsteer/state.json'), null));
		return Promise.all(tasks).then(function(res) {
			var stateTxt = res.pop();
			var m = {};
			IFACES.forEach(function(it, i) { m[it.sec] = res[i]; });
			var irq = null;
			try { irq = JSON.parse(stateTxt || ''); } catch (e) { irq = null; }
			var cur = matchPreset(m, irq);
			var PRESETS = getPresets();
			el.textContent = _('当前：%s'.format(cur ? PRESETS[cur].label : '自定义组合'));
			el.classList.toggle('is-custom', !cur);
			Object.keys(PRESETS).forEach(function(name) {
				var btn = document.querySelector('.netsteer-preset[data-preset="%s"]'.format(name));
				if (btn) btn.classList.toggle('on', cur === name);
			});
			/* 就地同步 IRQ 芯片与掩码文字 (apply 后 state.json 已刷新) */
			if (irq) self.syncIrchipsFromState(irq);
		});
	},

	/* 按 state.json 就地同步 IRQ 行显示 (不 reload) */
	syncIrchipsFromState: function(irq) {
		IFACES.forEach(function(it) {
			var st = irq[it.dev];
			if (!st || !st.affinity) return;
			var on = maskToCpus(st.affinity);
			var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="irq"]'.format(it.sec));
			chips.forEach(function(chip, i) { chip.classList.toggle('on', on[i]); });
			var row = chips.length ? chips[0].closest('.netsteer-row') : null;
			var el = row ? row.querySelector('.netsteer-irq-mask') : null;
			if (el) el.textContent = maskLabel(st.affinity);
		});
	},

	/* ---- 预设切换 (按名) ---- */
	applyPresetByName: function(name, silent) {
		var self = this;
		var PRESETS = getPresets();
		var preset = PRESETS[name];
		if (!preset) return Promise.resolve();
		var pairs = IFACES.map(function(it) {
			var opt = { rps_cpus: preset.map[it.sec] };
			if (!it.virtual) opt.xps_cpus = preset.map[it.sec];
			return { sec: it.sec, values: opt };
		});
		/* IRQ 摆位 (off 预设不含 irq 字段 = 中断不动) */
		Object.keys(preset.irq || {}).forEach(function(sec) {
			pairs.push({ sec: sec, values: { irq_cpus: preset.irq[sec] } });
		});
		return applyNow(pairs).then(function() {
			/* 不整页 reload: 就地同步芯片高亮/掩码文字/徽标 */
			IFACES.forEach(function(it) {
				['rps', 'xps'].forEach(function(kind) {
					if (it.virtual && kind === 'xps') return;
					var mask = preset.map[it.sec];
					var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="%s"]'.format(it.sec, kind));
					var on = maskToCpus(mask);
					chips.forEach(function(chip, i) {
						chip.classList.toggle('on', on[i]);
					});
					var row = chips.length ? chips[0].closest('.netsteer-row') : null;
					var maskLabelEl = row ? row.querySelector('.netsteer-mask') : null;
					if (maskLabelEl) maskLabelEl.textContent = maskLabel(mask);
				});
			});
			if (!silent) {
				ui.showModal(_('已切换: %s'.format(preset.label)), E('p', { 'class': 'netsteer-note' }, preset.desc));
				window.setTimeout(function() { ui.hideModal(); }, 2200);
			}
			self.refreshBadge();
		});
	},

	applyPreset: function(ev) {
		var name = ev && ev.currentTarget ? ev.currentTarget.getAttribute('data-preset') : null;
		return this.applyPresetByName(name, false)
			.catch(function(e) { ui.showModal(_('出错'), E('p', {}, String(e))); });
	},

	/* ---- 智能测速: 由本页面发起真实下载穿越路由器, 采样各配置下的软中断集中度 ---- */
	sampleSoftirq: function(seconds) {
		function read() {
			return fs.read('/proc/softirqs').then(function(t) {
				var d = parseSoftirq(t || '');
				return d.rx.slice(0, NCPU);
			});
		}
		var ctl = new AbortController();
		for (var i = 0; i < 6; i++) {
			fetch('https://dldir1v6.qq.com/weixin/Windows/WeChatSetup.exe', { mode: 'no-cors', signal: ctl.signal, cache: 'no-store' }).catch(function() {});
		}
		var a;
		return read().then(function(v0) {
			a = v0;
			return new Promise(function(resolve) { setTimeout(resolve, seconds * 1000); });
		}).then(function() {
			return read().then(function(b) {
				ctl.abort();
				var delta = cpuRange().map(function(i) { return Math.max(0, (b[i] || 0) - (a[i] || 0)); });
				var total = delta.reduce(function(x, y) { return x + y; }, 0);
				if (total < 100000) return { ok: false, reason: _('采样期间流量不足') };
				var maxI = 0;
				delta.forEach(function(c, i) { if (c > delta[maxI]) maxI = i; });
				return { ok: true, conc: Math.round(delta[maxI] * 100 / total), cpu: maxI, total: total };
			});
		});
	},

	markAutotuneDone: function() {
		/* global section 可能已存在 (apply 用它存 rfs_sock_flow_entries, type=steering) — 不动 .type */
		return ubusCall('uci', 'set', { config: 'netsteer', section: 'global', values: { autotune_done: '1' } })
			.catch(function() {
				return ubusCall('uci', 'add', { config: 'netsteer', type: 'netsteer', name: 'global', values: { autotune_done: '1' } });
			})
			.then(function() { return ubusCall('uci', 'commit', { config: 'netsteer' }); })
			.catch(function() {});
	},

	runAutotune: function() {
		var self = this;
		var PRESETS = getPresets();
		var seq = ['all'];
		if (PRESETS.pairs) seq.push('pairs');
		var results = {};

		function setStatus(txt) {
			var el = document.getElementById('netsteer-tune-status');
			if (el) el.textContent = txt;
		}

		ui.showModal(_('智能测速推荐'), [
			E('p', { 'class': 'netsteer-note' }, _('依次试用候选方案，用真实下载流量测量各方案下的负载分布，完成后推荐最均匀的一个。测速期间配置会被临时切换，结束后自动恢复。整个过程约半分钟，期间请保持本页面打开。')),
			E('p', { 'id': 'netsteer-tune-status' }, _('准备中…'))
		]);

		/* 记录测速前配置 (测完无论成败恢复, 防中途关页面停在测试值) */
		return ubusCall('uci', 'get', { config: 'netsteer' }).then(function(res) {
			var saved = {};
			var vals = (res && res.values) || {};
			Object.keys(vals).forEach(function(sec) {
				var s = vals[sec];
				if (s['.type'] !== 'interface') return;
				saved[sec] = { rps_cpus: s.rps_cpus, xps_cpus: s.xps_cpus, irq_cpus: s.irq_cpus };
			});
			return saved;
		}).then(function(saved) {
			function restore() {
				var pairs = Object.keys(saved).map(function(sec) { return { sec: sec, values: saved[sec] }; });
				return applyNow(pairs).then(function() { self.refreshBadge(); }).catch(function() {});
			}
			var chain = Promise.resolve();
			seq.forEach(function(name) {
				chain = chain.then(function() {
					setStatus(_('正在测: %s … (约 15 秒)'.format(PRESETS[name].label)));
					return self.applyPresetByName(name, true)
						.then(function() { return new Promise(function(r) { setTimeout(r, 1200); }); })
						.then(function() { return self.sampleSoftirq(12); })
						.then(function(r) { results[name] = r; });
				});
			});
			return chain.then(function() {
				return restore().then(function() {
					var rows = seq.filter(function(n) { return results[n] && results[n].ok; });
					if (!rows.length) {
						ui.showModal(_('测速未完成'), E('p', { 'class': 'netsteer-note' }, _('采样期间流量不足，请稍后在网络使用高峰期重试，或直接选择"全核分摊"。(配置已恢复)')));
						self.markAutotuneDone();
						return;
					}
					rows.sort(function(x, y) { return results[x].conc - results[y].conc; });
					var best = rows[0];
					var table = E('table', { 'class': 'netsteer-tune-table' }, [
						E('tr', {}, [ E('th', {}, _('方案')), E('th', {}, _('集中度')), E('th', {}, _('评价')) ])
					]);
					rows.forEach(function(n, i) {
						var r = results[n];
						table.appendChild(E('tr', {}, [
							E('td', {}, PRESETS[n].label + (n === best ? ' ★' : '')),
							E('td', {}, '%d%%'.format(r.conc)),
							E('td', {}, i === 0 ? _('最均匀，推荐') : _('略集中'))
						]));
					});
					ui.showModal(_('测速结果'), [
						E('p', { 'class': 'netsteer-note' }, _('数值 = 收包负载最大单核占比，越低越均匀（%d 核理论最优 %d%%）。测速配置已恢复为测速前的状态。'.format(NCPU, Math.round(100 / NCPU)))),
						table,
						E('div', { 'class': 'right' }, [
							E('button', {
								'class': 'btn cbi-button-neutral',
								'click': function() { ui.hideModal(); self.markAutotuneDone(); }
							}, _('保持测前配置')),
							' ',
							E('button', {
								'class': 'btn cbi-button-positive important',
								'click': function() {
									ui.hideModal();
									self.markAutotuneDone();
									self.applyPresetByName(best, false);
								}
							}, _('采纳推荐 (%s)'.format(PRESETS[best].label)))
						])
					]);
				});
			}).catch(function(e) {
				return restore().then(function() {
					ui.showModal(_('出错'), E('p', {}, String(e) + ' (配置已恢复)'));
				});
			});
		}).catch(function(e) {
			ui.showModal(_('出错'), E('p', {}, String(e)));
		});
	},

	autotuneAsk: function() {
		/* 首次使用: 询问是否自动测速 */
		var self = this;
		ui.showModal(_('首次使用建议'), [
			E('p', { 'class': 'netsteer-note' }, _('检测到首次使用。建议跑一次智能测速：用真实流量测量各方案的负载分布，自动推荐最适合本机的方案（约半分钟）。')),
			E('div', { 'class': 'right' }, [
				E('button', {
					'class': 'btn cbi-button-neutral',
					'click': function() { ui.hideModal(); self.markAutotuneDone(); }
				}, _('稍后再说')),
				' ',
				E('button', {
					'class': 'btn cbi-button-positive important',
					'click': function() { ui.hideModal(); self.runAutotune(); }
				}, _('开始测速'))
			])
		]);
	},

	/* ---- 网络体检 + 场景模式卡 ---- */
	renderAuditCard: function() {
		var self = this;
		return E('div', { 'class': 'netsteer-card', 'id': 'netsteer-audit' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('span', { 'class': 'netsteer-card-title' }, _('网络体检 · 场景模式')),
				E('button', {
					'class': 'netsteer-minibtn', 'type': 'button', 'id': 'netsteer-audit-btn',
					'click': ui.createHandlerFn(self, 'runAudit')
				}, _('开始体检'))
			]),
			E('p', { 'class': 'netsteer-note', 'id': 'netsteer-audit-hint' }, _('分三层检测依赖/配置/冲突并生成环境报告；方案分「现状最优 + 候选」与「补齐依赖后最优」两档（检测约 4 秒，只读不改配置）。'))
		]);
	},

	runAudit: function(ev) {
		var self = this;
		var btn = document.getElementById('netsteer-audit-btn');
		if (btn) { btn.disabled = true; btn.textContent = _('检测中…'); }
		return fs.exec('/usr/bin/netsteer-audit', []).then(function(r) {
			var a = null;
			try { a = JSON.parse((r && r.stdout || '').trim()); } catch (e) {}
			return self.renderAuditResult(a);
		}).catch(function(e) {
			ui.addNotification(null, E('p', {}, _('体检失败: %s').format(String(e))), 'error');
		}).finally(function() {
			if (btn) { btn.disabled = false; btn.textContent = _('重新体检'); }
		});
	},

	renderAuditResult: function(a) {
		var self = this;
		var card = document.getElementById('netsteer-audit');
		if (!card) return;
		var kids = [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('span', { 'class': 'netsteer-card-title' }, _('网络体检 · 环境报告')),
				E('button', { 'class': 'netsteer-minibtn', 'type': 'button',
					'click': ui.createHandlerFn(self, 'runAudit') }, _('重新体检'))
			])
		];
		if (!a) {
			kids.push(E('p', { 'class': 'netsteer-note', 'style': 'color:#c0392b' }, _('体检数据解析失败，请重试。')));
			card.replaceWith(this.renderAuditCardShell(kids));
			return;
		}
		var d = a.deps || {};
		var L = depLabels();
		/* -- ① 依赖层报告 -- */
		var depRows = Object.keys(L).map(function(k) {
			var ok = !!d[k];
			var feedOk = L[k].feed === 'base' || d['feed_' + L[k].feed];
			var hint = ok ? '' : (feedOk ? _('可在线安装') : _('需先配置 %s 软件源').format(L[k].feed));
			return E('div', { 'style': 'padding:2px 0' }, [
				E('span', { 'style': 'color:%s;font-weight:600'.format(ok ? '#1e8449' : '#c0392b') }, ok ? '✓ ' : '✗ '),
				L[k].name,
				hint ? E('span', { 'class': 'netsteer-note' }, ' — ' + hint) : E('span')
			]);
		});
		kids.push(E('div', { 'style': 'border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:8px 12px;margin:6px 0' },
			[E('div', { 'style': 'font-weight:600;margin-bottom:4px' }, _('① 依赖层'))].concat(depRows)));
		/* -- ② 配置/运行层报告 -- */
		var hasSqm = !!d.sqm_scripts;
		var sqmLine = hasSqm
			? _('SQM: %s · %s/%s kbps · cake %s').format(
					a.sqm && a.sqm.cake_running ? _('运行中') : (a.sqm && a.sqm.enabled ? _('已启用未运行') : _('未启用')),
					a.sqm ? a.sqm.download : '-', a.sqm ? a.sqm.upload : '-',
					a.sqm && a.sqm.cake_running ? _('活跃') : _('停止'))
			: _('SQM 引擎未安装（可补装后解锁整形类模式）');
		var upLine = +a.uplink_sample_kbps > 0
			? _('上行实测: %d kbps').format(+a.uplink_sample_kbps)
			: _('上行实测: 采样失败 (后台负载时常见)');
		kids.push(E('div', { 'style': 'border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:8px 12px;margin:6px 0' }, [
			E('div', { 'style': 'font-weight:600;margin-bottom:4px' }, _('② 配置与运行')),
			E('div', { 'style': 'padding:2px 0' }, sqmLine),
			E('div', { 'style': 'padding:2px 0' }, _('流量分载: %s · P2P 直通: %s · 分核: %s').format(
				a.offload && a.offload.flow ? _('开') : _('关'),
				a.p2p && a.p2p.active ? (a.p2p.ip || '') : _('关'),
				+a.irqbalance ? 'irqbalance' : 'netsteer')),
			E('div', { 'style': 'padding:2px 0' }, upLine),
			a.sqm && a.sqm.cake_running && a.sqm.drop >= 0
				? E('div', { 'style': 'padding:2px 0' }, _('cake 累计: 丢包 %s · 超限 %s').format(a.sqm.drop, a.sqm.overlimit))
				: E('span')
		]));
		/* -- ③ 冲突/风险 -- */
		var conf = auditConflicts(a);
		var CLS = { conflict: '#c0392b', warn: '#d35400', info: '#2471a3' };
		var confBlock = [E('div', { 'style': 'font-weight:600;margin-bottom:4px' }, _('③ 冲突与风险 (%d)').format(conf.length))];
		if (!conf.length) confBlock.push(E('div', { 'style': 'color:#1e8449' }, _('✓ 未发现冲突或风险项')));
		conf.forEach(function(c) {
			confBlock.push(E('div', { 'style': 'border-left:3px solid %s;padding:4px 8px;margin:6px 0;background:rgba(0,0,0,.03)'.format(CLS[c.level] || '#888') }, [
				E('div', { 'style': 'font-weight:600;color:%s'.format(CLS[c.level] || '#888') }, c.title),
				E('div', { 'class': 'netsteer-note' }, c.detail),
				c.fix ? E('div', { 'class': 'netsteer-note', 'style': 'color:#2471a3' }, '→ ' + c.fix) : E('span')
			]));
		});
		kids.push(E('div', { 'style': 'border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:8px 12px;margin:6px 0' }, confBlock));
		/* -- ④ 方案: 现状最优 + 候选 -- */
		var plan = buildPlan(a);
		var planBlock = [E('div', { 'style': 'font-weight:600;margin-bottom:4px' }, _('④ 方案推荐'))];
		planBlock.push(E('div', { 'style': 'font-weight:600;color:#1e8449;margin:6px 0 2px' }, _('现状最优：%s%s').format(plan.now.best.icon, plan.now.best.name)));
		planBlock.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0' }, plan.now.best.desc));
		if (plan.now.why) planBlock.push(E('p', { 'class': 'netsteer-note', 'style': 'color:#1e8449;margin:.2em 0' }, _('推荐理由: %s').format(plan.now.why)));
		planBlock.push(E('button', { 'class': 'netsteer-minibtn', 'type': 'button',
			'click': ui.createHandlerFn(self, 'applyModeConfirm', plan.now.best.id, a) }, _('应用「%s」').format(plan.now.best.name)));
		if (plan.now.candidates.length) {
			planBlock.push(E('div', { 'style': 'font-weight:600;margin:10px 0 2px' }, _('候选方案')));
			plan.now.candidates.forEach(function(c) {
				planBlock.push(E('div', { 'style': 'border:1px solid rgba(0,0,0,.15);border-radius:8px;padding:6px 10px;margin:6px 0' }, [
					E('div', { 'style': 'font-weight:600' }, c.m.icon + ' ' + c.m.name),
					E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0' }, c.m.desc),
					c.why ? E('p', { 'class': 'netsteer-note', 'style': 'color:#1e8449;margin:.2em 0' }, _('推荐理由: %s').format(c.why)) : E('span'),
					E('button', { 'class': 'netsteer-minibtn', 'type': 'button',
						'click': ui.createHandlerFn(self, 'applyModeConfirm', c.m.id, a) }, _('应用'))
				]));
			});
		}
		/* -- ⑤ 补齐依赖后的最优 -- */
		if (plan.full) {
			var f = plan.full;
			var missNames = f.missing.map(function(k) { return (depLabels()[k] || {}).name || k; }).join('、');
			var hintBlock = [
				E('div', { 'style': 'font-weight:600;color:#2471a3;margin:10px 0 2px' }, _('补齐依赖后的最优：%s%s').format(f.best.icon, f.best.name)),
				E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0' }, f.best.desc),
				E('p', { 'class': 'netsteer-note', 'style': 'color:#d35400;margin:.2em 0' }, _('需补齐：%s').format(missNames))
			];
			if (f.hint.cmd) hintBlock.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0' },
				_('SSH 执行：%s').format(f.hint.cmd)));
			if (f.hint.note) hintBlock.push(E('p', { 'class': 'netsteer-note', 'style': 'color:#2471a3;margin:.2em 0' }, f.hint.note));
			hintBlock.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0;color:#666' },
				_('装好后重新体检，此方案会移入"现状最优"。')));
			planBlock.push(E('div', { 'style': 'border:1px dashed #2471a3;border-radius:8px;padding:6px 10px;margin:8px 0' }, hintBlock));
		}
		kids.push(E('div', { 'style': 'border:1px solid rgba(0,0,0,.12);border-radius:8px;padding:8px 12px;margin:6px 0' }, planBlock));
		card.replaceWith(this.renderAuditCardShell(kids));
	},

	renderAuditCardShell: function(kids) {
		return E('div', { 'class': 'netsteer-card', 'id': 'netsteer-audit' }, kids);
	},

	applyModeConfirm: function(mode, audit, ev) {
		var self = this;
		var m = null;
		modeDefs().forEach(function(x) { if (x.id === mode) m = x; });
		var miss = depsMissing(m, audit);
		if (miss.length) {
			var names = miss.map(function(k) { return (depLabels()[k] || {}).name || k; }).join('、');
			return ui.showModal(_('无法应用'), E('p', { 'class': 'netsteer-note' },
				_('「%s」需要：%s。请先补齐依赖（见体检报告）。').format(m.name, names)));
		}
		var extra = '';
		if (mode === 'p2p') {
			var ip = (audit && audit.p2p && audit.p2p.ip && audit.p2p.ip !== '-') ? audit.p2p.ip : '192.168.11.175';
			extra = _('（直通设备: %s）').format(ip);
		}
		return ui.showModal(_('确认应用「%s」模式').format(m.name), [
			E('p', { 'class': 'netsteer-note' }, m.desc + extra),
			E('p', { 'class': 'netsteer-note', 'style': 'color:#c0392b' }, _('即将修改 SQM / 防火墙分载 / P2P 直通设置，网络会瞬断 1-2 秒。')),
			E('div', { 'class': 'right' }, [
				E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal.bind(ui) }, _('取消')),
				' ',
				E('button', { 'class': 'btn cbi-button-positive important', 'click': function() {
					ui.hideModal();
					fs.exec('/usr/bin/netsteer-mode', [mode]).then(function() { return self.load(); })
						.then(function() {
							ui.addNotification(null, E('p', {}, _('「%s」模式已应用').format(m.name)), 'info');
						})
						.catch(function(e) { ui.showModal(_('出错'), E('p', {}, String(e))); });
				} }, _('应用'))
			])
		]);
	},

	/* ---- P2P 直通卡 (Fullcone 等效: UDP 全端口入站 DNAT) ---- */
	renderP2PCard: function(st) {
		var self = this;
		var meta = p2pStatusMeta(st);
		var defIp = (st && st.dest_ip && st.dest_ip !== '-') ? st.dest_ip : ((st && st.uci_ip) || '192.168.11.175');
		var defPorts = (st && st.ports && st.ports !== '-') ? String(st.ports) : '1024-65535';
		var ps = defPorts.split('-');
		var card = E('div', { 'class': 'netsteer-card', 'id': 'netsteer-p2p' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('span', { 'class': 'netsteer-card-title' }, _('P2P 直通 (Fullcone 等效)')),
				E('span', { 'class': 'netsteer-badge' + meta.cls, 'id': 'netsteer-p2p-badge' }, _(meta.label))
			]),
			E('p', { 'class': 'netsteer-note' }, _('给指定设备开放 UDP 全端口入站（防火墙原生 DNAT 规则）。配合系统 NAT 的端口保留特性，效果等同 Fullcone NAT——P2P 下载、网心云类设备的打洞成功率显著提升。仅放行 UDP，TCP 不受影响。')),
			E('div', { 'class': 'netsteer-row', 'style': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:.6em 0' }, [
				E('label', { 'class': 'netsteer-note', 'for': 'netsteer-p2p-ip' }, _('设备 IP')),
				E('input', { 'id': 'netsteer-p2p-ip', 'type': 'text', 'value': defIp, 'size': 14, 'style': 'min-height:32px' }),
				E('label', { 'class': 'netsteer-note', 'for': 'netsteer-p2p-ports' }, _('端口')),
				E('input', { 'id': 'netsteer-p2p-ports', 'type': 'text', 'value': defPorts, 'size': 12, 'style': 'min-height:32px' }),
				E('button', {
					'class': 'netsteer-minibtn', 'type': 'button',
					'click': ui.createHandlerFn(self, 'p2pToggle', st)
				}, (st && st.active) ? _('关闭') : _('开启'))
			]),
			E('p', { 'class': 'netsteer-foot' }, _('注意：该设备的 UDP 端口将对公网开放，请确保设备上的服务可信。规则可在 系统→防火墙 页面查看。'))
		]);
		return card;
	},

	p2pToggle: function(st, ev) {
		/* 开→关 / 关→开; 开时读输入框并前端校验 (shell 端再校验一道) */
		var self = this;
		var turningOn = !(st && st.active);
		var chain;
		if (turningOn) {
			var ip = (document.getElementById('netsteer-p2p-ip') || {}).value || '';
			var ports = ((document.getElementById('netsteer-p2p-ports') || {}).value || '1024-65535').trim();
			var m = (/^(\d+)-(\d+)$/).exec(ports);
			if (!p2pValidIp(ip.trim()))
				return ui.showModal(_('IP 无效'), [E('p', { 'class': 'netsteer-note' }, _('请输入 RFC1918 内网地址，例如 192.168.11.175')), E('div', { 'class': 'right' }, [E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal.bind(ui) }, _('知道了'))])]);
			if (!m || !p2pValidPort(m[1]) || !p2pValidPort(m[2]) || +m[1] > +m[2])
				return ui.showModal(_('端口无效'), [E('p', { 'class': 'netsteer-note' }, _('格式: 起-止，如 1024-65535')), E('div', { 'class': 'right' }, [E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal.bind(ui) }, _('知道了'))])]);
			/* 权威操作 = 脚本 exec (自带首装自愈); uci 记录尽力而为, 失败不阻断 */
			chain = fs.exec('/usr/bin/netsteer-p2p', ['on', ip.trim(), m[1], m[2]])
				.then(function() {
					return ubusCall('uci', 'set', { config: 'netsteer', section: 'p2p', values: { enabled: '1', dest_ip: ip.trim(), port_start: m[1], port_end: m[2] } }).catch(function() {});
				});
		} else {
			chain = fs.exec('/usr/bin/netsteer-p2p', ['off'])
				.then(function() {
					return ubusCall('uci', 'set', { config: 'netsteer', section: 'p2p', values: { enabled: '0' } }).catch(function() {});
				});
		}
		return chain.then(function() { return self.load(); })
			.then(function(values) {
				var newSt = values[3 + IFACES.length * 2];
				/* 整卡重渲染 (按钮文案/IP/端口预填都随状态走, 只改 badge 会留下旧按钮) */
				var old = document.getElementById('netsteer-p2p');
				if (old) old.replaceWith(this.renderP2PCard(newSt));
				ui.addNotification(null, E('p', {}, turningOn ? _('P2P 直通已开启') : _('P2P 直通已关闭')), 'info');
			}.bind(this))
			.catch(function(e) { ui.showModal(_('出错'), E('p', {}, String(e))); });
	},

	/* ---- 游戏设备优先通道卡 (设备级 DSCP cs4 → cake diffserv4 video tin) ---- */
	renderGameCard: function(st) {
		var self = this;
		var meta = gameStatusMeta(st);
		var dmeta = dnsObserverMeta(st);
		var defIp = (st && st.device && st.device !== '-') ? st.device : '';
		self._gameDevice = (st && st.device) || '-';
		var dnsChildren = [
			E('div', { 'style': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
				E('strong', { 'class': 'netsteer-note', 'style': 'margin:0' }, _('DNS 识别')),
				E('span', { 'class': 'netsteer-badge', 'id': 'ns-game-dns-badge' }, dmeta.badge)
			]),
			E('p', { 'class': 'netsteer-note', 'style': 'margin:.3em 0 .2em' }, dmeta.desc)
		];
		if (dmeta.btn)
			dnsChildren.push(E('div', { 'id': 'ns-game-dns-actions', 'style': 'margin:.3em 0' }, [
				E('button', {
					'id': 'ns-game-dns-toggle',
					'class': 'netsteer-minibtn', 'type': 'button',
					'click': ui.createHandlerFn(self, 'gameDnsEnToggle', dmeta.btn)
				}, dmeta.btn === 'on' ? _('开启查询日志') : _('关闭查询日志'))
			]));
		dnsChildren.push(E('div', { 'id': 'ns-game-dns-body' }, [E('p', { 'class': 'netsteer-note' }, _('等待采样…'))]));
		var card = E('div', { 'class': 'netsteer-card', 'id': 'netsteer-game' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('span', { 'class': 'netsteer-card-title' }, _('游戏设备优先通道')),
				E('span', { 'class': 'netsteer-badge' + meta.cls, 'id': 'netsteer-game-badge' }, _(meta.label))
			]),
			/* 场景感知卡 (D12): 当前网络在干什么 — 全设备连接采样, 每场景独立判定逻辑 */
			E('div', { 'class': 'netsteer-card', 'style': 'margin:.5em 0;padding:.6em .8em' }, [
				E('div', { 'style': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap' }, [
					E('strong', { 'class': 'netsteer-note', 'style': 'margin:0' }, _('场景感知')),
					E('span', { 'id': 'ns-feed-status', 'class': 'netsteer-note', 'style': 'margin-left:auto' }, _('识别数据集加载中…'))
				]),
				E('div', { 'id': 'ns-sense-body', 'style': 'margin-top:.3em' }, [E('p', { 'class': 'netsteer-note' }, _('等待连接采样…'))])
			]),
			E('p', { 'class': 'netsteer-note' }, _('指定一台游戏设备（主机/PC），它的全部流量在双向 cake 整形中进入高优先 video 桶：满载下载、视频流占用带宽时，游戏包仍然优先发出。原理与华硕「游戏加速 LAN 口」同类：设备级 DSCP 标记 (CS4) + diffserv4 分桶 + 上行 ACK 自动提权。下方分桶速率是真实 tc 计数，开了就有 Video 行，可自行验证。')),
			E('div', { 'id': 'ns-game-suggest', 'style': 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin:.4em 0' }, []),
			E('div', { 'class': 'netsteer-row', 'style': 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:.6em 0' }, [
				E('label', { 'class': 'netsteer-note', 'for': 'netsteer-game-ip' }, _('设备 IP')),
				E('input', { 'id': 'netsteer-game-ip', 'type': 'text', 'value': defIp, 'size': 14, 'style': 'min-height:32px', 'placeholder': _('游戏主机的内网 IP，如 192.168.1.100') }),
				E('button', {
					'id': 'netsteer-game-toggle',
					'class': 'netsteer-minibtn', 'type': 'button',
					'click': ui.createHandlerFn(self, 'gameToggle', st)
				}, (st && st.enabled) ? _('关闭') : _('开启'))
			]),
			E('p', { 'class': 'netsteer-note', 'id': 'ns-game-cakeinfo', 'style': 'color:var(--text-2,#4a515a)' },
				(st && st.cake_up) ? _('整形实况：上行 %s · 下行 %s').format(st.cake_up, st.cake_down || '-') : _('整形实况：等待采样…')),
			E('div', { 'id': 'ns-game-live' }, [
				E('p', { 'class': 'netsteer-note', 'style': 'margin:.5em 0 .2em' }, E('strong', {}, _('出口延迟曲线（每 8s 采样，滚动 5 分钟）'))),
				E('div', { 'id': 'ns-game-spark' }, [E('p', { 'class': 'netsteer-note' }, _('等待采样…'))]),
				E('p', { 'class': 'netsteer-note', 'id': 'ns-game-lat', 'style': 'margin:.2em 0' }, ''),
				E('div', { 'id': 'ns-game-tins' }, [E('p', { 'class': 'netsteer-note' }, _('分桶数据等待采样…'))])
			]),
			E('div', { 'id': 'ns-game-dns', 'style': 'margin:.6em 0;padding-top:.5em;border-top:1px dashed var(--line-2,#c1c7ce)' }, dnsChildren),
			E('p', { 'class': 'netsteer-foot' }, _('诚实边界：仅 IPv4 流量标记（游戏主机/PC 的绝大多数流量走 v4）；需 SQM cake 在跑（均衡/低延迟/P2P 模式）；极速模式与总开关关闭会停掉整形，此时通道自动降级并在徽标上如实显示；同一设备上如果用 Steam 下游戏，下载也走优先桶——cake 的流隔离保证游戏包延迟不受大流排队影响，带宽按流公平分享。'))
		]);
		window.setTimeout(function() { self.gameDetectSuggest(); }, 400);
		return card;
	},

	gameDnsEnToggle: function(btn, ev) {
		/* dnsmasq 查询日志开关 (仅 dnsmasq_off/dnsmasq 观测面出现; 重启 dnsmasq ~1s) */
		var self = this;
		return fs.exec('/usr/bin/netsteer-qos', ['dns-en', btn])
			.then(function() { return self.load(); })
			.then(function(values) {
				var newSt = values[4 + IFACES.length * 2];
				var old = document.getElementById('netsteer-game');
				if (old) old.replaceWith(self.renderGameCard(newSt));
				ui.addNotification(null, E('p', {}, btn === 'on' ? _('DNS 查询日志已开启') : _('DNS 查询日志已关闭')), 'info');
			})
			.catch(function(e) { ui.showModal(_('出错'), E('p', {}, String(e))); });
	},

	gameToggle: function(st, ev) {
		var self = this;
		var turningOn = !(st && st.enabled);
		var chain;
		if (turningOn) {
			var ip = ((document.getElementById('netsteer-game-ip') || {}).value || '').trim();
			if (!p2pValidIp(ip))
				return ui.showModal(_('IP 无效'), [E('p', { 'class': 'netsteer-note' }, _('请输入游戏主机的 RFC1918 内网地址，例如 192.168.1.100')), E('div', { 'class': 'right' }, [E('button', { 'class': 'btn cbi-button-neutral', 'click': ui.hideModal.bind(ui) }, _('知道了'))])]);
			chain = fs.exec('/usr/bin/netsteer-qos', ['on', ip])
				.then(function() {
					return ubusCall('uci', 'set', { config: 'netsteer', section: 'qos', values: { enabled: '1', device: ip } }).catch(function() {});
				});
		} else {
			chain = fs.exec('/usr/bin/netsteer-qos', ['off'])
				.then(function() {
					return ubusCall('uci', 'set', { config: 'netsteer', section: 'qos', values: { enabled: '0' } }).catch(function() {});
				});
		}
		return chain.then(function() { return self.load(); })
			.then(function(values) {
				var newSt = values[4 + IFACES.length * 2];
				var old = document.getElementById('netsteer-game');
				if (old) old.replaceWith(this.renderGameCard(newSt));
				self._gameTinPrev = null;   /* 分桶计数基线随开关重置 */
				ui.addNotification(null, E('p', {}, turningOn ? _('游戏通道已开启（SQM 整形切换会有 1-2 秒瞬断）') : _('游戏通道已关闭，整形恢复原脚本')), 'info');
			}.bind(this))
			.catch(function(e) { ui.showModal(_('出错'), E('p', {}, String(e))); });
	},

	gameDetectSuggest: function() {
		/* DHCP 主机名启发式 → 疑似游戏设备 chips (点击回填 IP 输入框); 60s 节流 */
		var self = this;
		var el = document.getElementById('ns-game-suggest');
		if (!el) return;
		var now = Date.now();
		if (self._gameSuggestTs && now - self._gameSuggestTs < 60000) return;
		self._gameSuggestTs = now;
		fs.exec('/usr/bin/netsteer-qos', ['detect']).then(function(r) {
			var el2 = document.getElementById('ns-game-suggest');
			if (!el2) return;
			var list = [];
			try { list = JSON.parse(((r && r.stdout) || '').trim()) || []; } catch (e) {}
			if (!list.length) return;
			var kids = [E('span', { 'class': 'netsteer-note', 'style': 'align-self:center' }, _('疑似游戏设备：'))];
			list.slice(0, 4).forEach(function(d) {
				kids.push(E('button', { 'class': 'netsteer-minibtn', 'type': 'button', 'click': function() {
					var ip = document.getElementById('netsteer-game-ip');
					if (ip) ip.value = d.ip;
				} }, '%s · %s'.format(d.name, d.ip)));
			});
			el2.replaceChildren(E('div', { 'style': 'display:flex;gap:6px;flex-wrap:wrap;align-items:center' }, kids));
		}).catch(function() {});
	},

	loadGameDomains: function() {
		/* 五个数据文件加载一次并缓存: 域名表 + L2 IP 段表 + 端口表 + 流媒体域名 + 下载端口 (场景感知 D11/D12) */
		var self = this;
		if (self._domainMapP) return self._domainMapP;
		self._domainMapP = Promise.all([
			fs.read('/usr/share/netsteer/gamedomains.txt').catch(function() { return ''; }),
			fs.read('/usr/share/netsteer/gameips.txt').catch(function() { return ''; }),
			fs.read('/usr/share/netsteer/gameports.txt').catch(function() { return ''; }),
			fs.read('/usr/share/netsteer/streamdomains.txt').catch(function() { return ''; }),
			fs.read('/usr/share/netsteer/downloadports.txt').catch(function() { return ''; })
		]).then(function(txts) {
			self._domainMap = buildDomainMap(txts[0] || '');
			self._ipmap = buildIpMap(txts[1] || '');
			self._pmap = buildPortMap(txts[2] || '');
			self._streamMap = buildDomainMap(txts[3] || '');
			self._dlportMap = buildPortMap(txts[4] || '');
			/* 数据集版本 (feed 更新后刷新页面即生效, D11) */
			self._dataVersion = null;
			fs.read('/usr/share/netsteer/manifest.tsv').then(function(t) {
				var m = / v=([^ ]+) /.exec(String(t).split('\n')[0] || '');
				if (m) self._dataVersion = m[1];
			}).catch(function() {});
			return self._domainMap;
		});
		return self._domainMapP;
	},

	pollSense: function(recs) {
		/* 场景感知: 采样 → 判定 → 防抖 → 渲染 (D12) */
		var self = this;
		self.loadGameDomains().then(function() {
			var res = senseClassify(recs, {
				game: self._domainMap, gameips: self._ipmap, gameports: self._pmap,
				stream: self._streamMap, dlports: self._dlportMap
			});
			self._senseState = senseDebounce(self._senseState, res.scene, Math.floor(Date.now() / 1000));
			self.paintSense(res);
		}).catch(function(e) {
			try { console.error('netsteer-sense:', e); } catch (e2) {}
			var el = document.getElementById('ns-sense-body');
			if (el) el.replaceChildren(E('p', { 'class': 'netsteer-note' }, _('场景感知异常: ') + e));
		});
	},

	paintSense: function(res) {
		var el = document.getElementById('ns-sense-body');
		if (!el) return;
		var st = this._senseState || { scene: 'normal', since: Math.floor(Date.now() / 1000) };
		var meta = SENSE_SCENE_META[st.scene] || SENSE_SCENE_META.normal;
		var head = E('div', { 'style': 'display:flex;align-items:center;gap:10px;flex-wrap:wrap' }, [
			E('span', { 'class': 'netsteer-badge' + (meta.cls ? ' ' + meta.cls : ''), 'style': 'font-size:15px' }, meta.icon + ' ' + meta.name),
			res && res.scene !== st.scene
				? E('span', { 'class': 'netsteer-note' }, _('下一窗口确认: %s (防抖中)').format((SENSE_SCENE_META[res.scene] || SENSE_SCENE_META.normal).name))
				: E('span', { 'class': 'netsteer-note' }, res ? _('置信度 %d%% · 采样窗口连续一致才切换').format(res.confidence) : '')
		]);
		var kids = [head];
		if (res) {
			var lines = [];
			['gaming', 'work', 'streaming', 'download'].forEach(function(s) {
				var e = (res.evidence[s] || []).slice(0, 2);
				e.forEach(function(x) {
					var tag = { chain: _('游戏链'), domain: _('域名'), stun: _('STUN'), bulk: _('大流量'), port: _('端口'), 'game-heavy': _('平台大下载') }[x.via] || x.via;
					lines.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.1em 0;font-size:12px' },
						'%s %s · %s%s'.format((SENSE_SCENE_META[s] || {}).icon || '', (SENSE_SCENE_META[s] || {}).name || s, x.host || '', x.cat ? (' [' + x.cat + ']') : '') + ' · ' + tag));
				});
			});
			if (lines.length) kids.push(E('div', { 'style': 'margin-top:4px' }, lines.slice(0, 6)));
			else kids.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.2em 0' }, _('当前无显著场景特征 (普通上网/空闲)——识别数据覆盖游戏平台、会议、流媒体与 P2P 下载。')));
		}
		el.replaceChildren(E('div', {}, kids));
	},

	feedCheck: function(ev) {
		/* 数据源: 检查更新 → 有更新则确认后应用 (D11) */
		var self = this;
		var btn = document.getElementById('ns-feed-btn');
		if (btn) btn.disabled = true;
		fs.exec('/usr/bin/netsteer-feed', ['check']).then(function(r) {
			var out = null;
			try { out = JSON.parse((r.stdout || '').trim()); } catch (e) {}
			btn.disabled = false;
			if (!out || out.error) {
				alert(_('数据源不可达: %s').format(out && out.detail || 'network'));
				return;
			}
			if (!out.update_available) {
				alert(_('数据集已是最新 (%s)。').format(out.remote_version || '-'));
				self.paintFeedStatus();
				return;
			}
			var names = (out.changed || []).map(function(c) { return c.file; }).join(', ');
			if (!confirm(_('发现数据集更新: %s\n\n远端版本 %s → 本地 %s\n更新文件: %s\n\n应用更新? (sha256 校验, 失败自动保留现状)').format('', out.remote_version, out.installed_version, names)))
				return;
			fs.exec('/usr/bin/netsteer-feed', ['update']).then(function(r2) {
				var u = null;
				try { u = JSON.parse((r2.stdout || '').trim()); } catch (e) {}
				alert(u && u.count > 0
					? _('已更新 %d 个数据文件 → 版本 %s%s').format(u.count, u.version || '-', u.failed ? _('\n部分失败: ') + u.failed : '')
					: (u && u.failed ? _('更新失败: %s (已保留现有数据集)').format(u.failed) : _('无变更'))); 
				/* 数据热生效: 清缓存重载 + 状态行刷新 */
				self._domainMapP = null; self.loadGameDomains();
				self.paintFeedStatus();
			});
		}).catch(function() { btn.disabled = false; alert(_('检查失败: 无法执行 netsteer-feed')); });
	},

	paintFeedStatus: function() {
		var el = document.getElementById('ns-feed-status');
		if (!el) return;
		var self = this;
		fs.exec('/usr/bin/netsteer-feed', ['status']).then(function(r) {
			var s = null;
			try { s = JSON.parse((r.stdout || '').trim()); } catch (e) {}
			var v = (s && s.installed_version) || self._dataVersion || _('随包内置');
			var integ = s && s.integrity;
			el.replaceChildren(
				E('span', { 'class': 'netsteer-note' }, _('识别数据集: %s%s').format(v, integ === false ? _(' (本地已修改)') : '')),
				E('button', {
					'class': 'btn cbi-button cbi-button-apply', 'id': 'ns-feed-btn',
					'style': 'margin-left:8px;font-size:12px;padding:2px 10px',
					'click': L.bind(self.feedCheck, self)
				}, _('检查数据更新'))
			);
		}).catch(function() {
			el.replaceChildren(E('span', { 'class': 'netsteer-note' }, _('识别数据集: %s').format(self._dataVersion || _('随包内置'))));
		});
	},

	paintGameDns: function(sum) {
		var el = document.getElementById('ns-game-dns-body');
		if (!el || !sum) return;
		if (!sum.total) {
			el.replaceChildren(E('p', { 'class': 'netsteer-note' }, _('暂无该设备的活跃连接记录（快照只含活跃连接；设备空闲或走加密 DNS 时不显示——这是观测边界，不影响加速通道本身）。')));
			return;
		}
		var cats = Object.keys(sum.platforms).sort(function(a, b) { return sum.platforms[b] - sum.platforms[a]; });
		var chips = [E('span', { 'class': 'netsteer-note', 'style': 'align-self:center' }, _('活跃连接 %d 条 · 命中平台：').format(sum.total))];
		cats.forEach(function(c) {
			chips.push(E('span', { 'class': 'netsteer-badge', 'style': 'margin:2px' }, '%s ×%d'.format(c, sum.platforms[c])));
		});
		var kids = [E('div', { 'style': 'display:flex;gap:4px;flex-wrap:wrap;align-items:center' }, chips)];
		var srcTag = { name: _('域名'), ip: _('IP 段'), port: _('端口') };
		sum.last.slice(-3).reverse().forEach(function(r) {
			kids.push(E('p', { 'class': 'netsteer-note', 'style': 'margin:.1em 0;font-size:12px' },
				(r.cat ? '[%s] '.format(r.cat) : '') + r.q + (r.cat && r.src && srcTag[r.src] ? ' · ' + srcTag[r.src] : '')));
		});
		el.replaceChildren(E('div', {}, kids));
	},

	gameSparkSvg: function(series) {
		/* 延迟序列 → SVG polyline (滚动 5 分钟窗, 时间比例 x 轴) */
		if (!series || series.length < 2) return null;
		var W = 300, H = 64, win = 300000, now = Date.now();
		var pts = series.filter(function(p) { return now - p.t <= win; });
		if (pts.length < 2) return null;
		var vmax = Math.max(50, Math.max.apply(null, pts.map(function(p) { return p.v; })) * 1.15);
		var t0 = pts[0].t, t1 = pts[pts.length - 1].t, span = Math.max(t1 - t0, 1);
		var d = pts.map(function(p, i) {
			var x = (p.t - t0) / span * W;
			var y = H - (p.v / vmax) * (H - 6) - 2;
			return x.toFixed(1) + ',' + y.toFixed(1);
		}).join(' ');
		return E('svg', { 'viewBox': '0 0 ' + W + ' ' + H, 'style': 'width:100%;height:64px', 'preserveAspectRatio': 'none' }, [
			E('polyline', { 'points': d, 'fill': 'none', 'stroke': 'var(--accent,#c8f031)', 'stroke-width': '2' })
		]);
	},

	pollGame: function() {
		var self = this;
		Promise.all([
			fs.exec('/usr/bin/netsteer-qos', ['tins']).catch(function() { return null; }),
			fs.exec('/usr/bin/netsteer-qos', ['probe']).catch(function() { return null; }),
			fs.exec('/usr/bin/netsteer-qos', ['dnslog', '200']).catch(function() { return null; })
		]).then(function(res) {
			var pr = null;
			try { pr = JSON.parse(((res[1] && res[1].stdout) || '').trim()); } catch (e) {}
			if (pr && pr.latency_ms != null) {
				if (!self._gameLat) self._gameLat = [];
				seriesPush(self._gameLat, { t: Date.now(), v: pr.latency_ms }, 300000, 150);
			}
			var txt = (res[0] && res[0].stdout) || '';
			var parts = txt.split('#DOWN');
			var up = parseTinStats((parts[0] || '').replace(/^#UP[^\n]*\n/, ''));
			var dn = parseTinStats((parts[1] || '').replace(/^[^\n]*\n/, ''));
			self.paintGame(up, dn, pr);
			var recs = [];
			try { recs = JSON.parse(((res[2] && res[2].stdout) || '').trim()) || []; } catch (e) {}
			self.loadGameDomains().then(function(map) {
				self.paintGameDns(dnsSummary(recs, map, self._gameDevice, self._ipmap, self._pmap));
			});
			/* 场景感知 (D12): 同一份采样喂判定引擎 (全设备视角, 不按游戏设备过滤) */
			self.pollSense(recs);
			if (!self._feedPainted) { self._feedPainted = true; self.paintFeedStatus(); }
		});
	},

	gameTinRows: function(up, dn, prev, ts) {
		/* 双向分桶解析结果 → 表格行数据 [{tin, upRate, dnRate, upPkts, dnPkts, drops}] (纯计算) */
		var rows = [];
		var names = [];
		['bulk', 'best_effort', 'video', 'voice'].forEach(function(n) {
			if ((up && up.tins && up.tins[n]) || (dn && dn.tins && dn.tins[n])) names.push(n);
		});
		var dt = prev && prev.ts ? Math.max(ts - prev.ts, 1) : 0;
		names.forEach(function(n) {
			var u = up && up.tins ? up.tins[n] : null;
			var d = dn && dn.tins ? dn.tins[n] : null;
			var pu = u ? parseInt(u.pkts, 10) || 0 : 0;
			var pd = d ? parseInt(d.pkts, 10) || 0 : 0;
			var bu = u ? parseInt(u.bytes, 10) || 0 : 0;
			var bd = d ? parseInt(d.bytes, 10) || 0 : 0;
			var upRate = dt && prev.tins && prev.tins.up && prev.tins.up[n]
				? Math.max(bu - (prev.tins.up[n].bytes || 0), 0) * 8 / dt : null;
			var dnRate = dt && prev.tins && prev.tins.dn && prev.tins.dn[n]
				? Math.max(bd - (prev.tins.dn[n].bytes || 0), 0) * 8 / dt : null;
			var upPkts = dt && prev.tins && prev.tins.up && prev.tins.up[n]
				? Math.max(pu - (prev.tins.up[n].pkts || 0), 0) : null;
			var dnPkts = dt && prev.tins && prev.tins.dn && prev.tins.dn[n]
				? Math.max(pd - (prev.tins.dn[n].pkts || 0), 0) : null;
			rows.push({
				tin: n,
				upRate: upRate, dnRate: dnRate,
				upPkts: upPkts, dnPkts: dnPkts,
				upPktsTot: pu, dnPktsTot: pd,
				drops: (u ? parseInt(u.drops, 10) || 0 : 0) + (d ? parseInt(d.drops, 10) || 0 : 0)
			});
		});
		return rows;
	},

	paintGame: function(up, dn, pr) {
		var self = this;
		var ts = Date.now();
		var infoEl = document.getElementById('ns-game-cakeinfo');
		if (infoEl && up) {
			infoEl.textContent = _('整形实况：上行 %s %s · 下行 %s %s').format(
				up.mode || '-', up.bandwidth || '', dn ? dn.mode || '-' : '-', dn ? dn.bandwidth || '' : '');
		}
		var sparkEl = document.getElementById('ns-game-spark');
		if (sparkEl) {
			var svg = self.gameSparkSvg(self._gameLat);
			if (svg) sparkEl.replaceChildren(svg);
		}
		var latEl = document.getElementById('ns-game-lat');
		if (latEl && self._gameLat && self._gameLat.length) {
			var arr = self._gameLat, last = arr[arr.length - 1].v;
			var sum = 0, mx = 0;
			arr.forEach(function(p) { sum += p.v; mx = Math.max(mx, p.v); });
			var tg = (pr && pr.target) ? ' · ' + _('经 %s').format(pr.target) : '';
			latEl.textContent = _('最近 %s ms · 均值 %s ms · 峰值 %s ms（%d 个采样）%s').format(
				last.toFixed(1), (sum / arr.length).toFixed(1), mx.toFixed(1), arr.length, tg);
		}
		var tinsEl = document.getElementById('ns-game-tins');
		if (tinsEl) {
			var prev = self._gameTinPrev || null;
			var rows = self.gameTinRows(up, dn, prev, ts);
			self._gameTinPrev = { ts: ts, tins: { up: up && up.tins, dn: dn && dn.tins } };
			var namesZh = { bulk: 'Bulk 后台', best_effort: 'Best Effort 默认', video: 'Video 优先（游戏设备）', voice: 'Voice 最高' };
			if (rows.length) {
				var trs = rows.map(function(r) {
					return E('tr', {}, [
						E('td', {}, _(namesZh[r.tin] || r.tin)),
						E('td', {}, r.upRate != null ? fmtBps(r.upRate) : '—'),
						E('td', {}, r.dnRate != null ? fmtBps(r.dnRate) : '—'),
						E('td', {}, r.upPkts != null ? fmtCount(r.upPkts) + ' 包/采样' : fmtCount(r.upPktsTot) + ' 累计'),
						E('td', {}, r.dnPkts != null ? fmtCount(r.dnPkts) + ' 包/采样' : fmtCount(r.dnPktsTot) + ' 累计')
					]);
				});
				var table = E('table', { 'class': 'netsteer-game-tins table', 'style': 'width:100%;font-size:12px;border-collapse:collapse;margin:.3em 0' }, [
					E('tr', {}, [_('分桶'), _('上行速率'), _('下行速率'), _('上行包'), _('下行包')].map(function(h) {
						return E('th', { 'style': 'text-align:left;padding:.25em .5em;border-bottom:1px solid var(--line-2,#c1c7ce)' }, h);
					}))
				].concat(trs));
				tinsEl.replaceChildren(table);
			}
		}
	},

	/* 问号浮窗: 原理与用法 */
	toggleHelp: function(ev) {
		var old = document.getElementById('netsteer-help-pop');
		if (old) { old.remove(); return; }
		var pop = E('div', { 'id': 'netsteer-help-pop', 'class': 'netsteer-card netsteer-help-pop' }, [
			E('strong', {}, _('它解决什么问题')),
			E('p', { 'class': 'netsteer-note' }, _('路由器每个数据包都要 CPU 处理。系统默认压在单个核心——高速下载、多设备并发时单核打满，表现为网速上不去、网页卡顿、延迟波动。')),
			E('strong', {}, _('它做什么')),
			E('p', { 'class': 'netsteer-note' }, _('基于内核 RPS / RFS / XPS 机制，把网络负载分摊到全部 %d 个核心：吞吐更高，高峰期更流畅。'.format(NCPU))),
			E('strong', {}, _('怎么用')),
			E('p', { 'class': 'netsteer-note' }, _('选一个方案立即生效；断电重启自动恢复；随时可切回系统默认。逐核点选可自定义。'))
		]);
		document.body.appendChild(pop);
		var btn = ev.currentTarget;
		var x = btn.getBoundingClientRect();
		pop.style.left = Math.max(12, Math.min(x.left - 260, window.innerWidth - 320)) + 'px';
		pop.style.top = (x.bottom + 8 + window.scrollY) + 'px';
		function close(e) {
			if (!pop.contains(e.target) && e.target !== btn) {
				pop.remove();
				document.removeEventListener('click', close);
			}
		}
		setTimeout(function() { document.addEventListener('click', close); }, 50);
	},

	render: function(values) {
		var self = this;
		/* meta 在 values[0] (load 阶段已填 NCPU/IFACES) */
		var meta = values[0];
		NCPU = meta.ncpu; IFACES = meta.ifaces;
		var PRESETS = getPresets();
		/* 当前模式判定: 各口 rps 现值 (sysfs) + IRQ state 匹配预设 */
		var masks = {};
		IFACES.forEach(function(it, i) { masks[it.sec] = ((values[1 + i * 2] || '0') + '').trim(); });
		var state = null;
		try { state = JSON.parse(values[2 + IFACES.length * 2] || ''); } catch (e) { state = null; }
		var cur = matchPreset(masks, state);
		var curLabel = cur ? PRESETS[cur].label : _('自定义组合');

		var css = E('style', { 'type': 'text/css' }, [
			/* 卡片 (首页 Overview 同款: s1 面 + line 描边 + r 圆角 + 极浅阴影) */
			'.netsteer-card{background:var(--s1,#f8f9fa);border:1px solid var(--line,#d6dade);border-radius:var(--r,6px);padding:var(--sp-4,16px);box-shadow:0 1px 2px rgba(0,0,0,.05)}',
			'.netsteer-card-head{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2,8px);margin-bottom:var(--sp-3,12px)}',
			'.netsteer-card-title{font-size:var(--fs-md,14px);font-weight:600;color:var(--text,#14171a)}',
			'.netsteer-note{color:var(--text-3,#5f666f);font-size:var(--fs-sm,12px);font-weight:400}',
			'.netsteer-foot{color:var(--text-3,#5f666f);font-size:var(--fs-sm,12px);margin-top:var(--sp-2,8px)}',

			/* 头部说明 (一句话 + 问号浮窗) */
			'.netsteer-lede{max-width:64em;color:var(--text-2,#4a515a);font-size:var(--fs-md,14px);line-height:1.6;margin:.3em 0 .1em 0;display:flex;align-items:center;gap:.45em}',
			'.netsteer-root .netsteer-help{flex:none;width:19px;height:19px;aspect-ratio:1/1;border-radius:50%;border:1px solid var(--line-2,#c1c7ce);background:var(--s2,#fff);color:var(--text-3,#5f666f);font-size:12px;font-weight:700;line-height:1.2;display:inline-flex;align-items:center;justify-content:center;text-align:center;cursor:pointer;padding:0}',
			'.netsteer-root .netsteer-help:hover{border-color:var(--accent,#c8f031);color:var(--text,#14171a)}',
			'.netsteer-help-pop{position:absolute;z-index:200;max-width:300px;margin:0;display:flex;flex-direction:column;gap:.1em}',
			'.netsteer-help-pop strong{font-size:var(--fs-sm,12px);color:var(--text,#14171a);margin-top:.5em}',
			'.netsteer-help-pop p{margin:.1em 0}',

			/* 徽标 (accent-soft 底, 不再大色块) */
			'.netsteer-badge{display:inline-flex;align-items:center;gap:.4em;padding:.22em .85em;border-radius:999px;border:1px solid var(--accent,#c8f031);background:var(--accent-soft,rgba(122,163,0,.13));color:var(--text,#14171a);font-size:var(--fs-sm,12px);font-weight:600}',
			'.netsteer-badge.is-custom{border-color:var(--line-2,#c1c7ce);background:var(--s3,#eef0f3);color:var(--text-2,#4a515a)}',
			'.netsteer-badge.is-warn{border-color:#d8a531;background:rgba(216,165,49,.13);color:#8a6a10}',
			'.netsteer-badge::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--accent,#c8f031)}',
			'.netsteer-badge.is-custom::before{background:var(--text-3,#5f666f)}',
			'.netsteer-badge.is-warn::before{background:#d8a531}',

			/* 状态条 */
			'.netsteer-statusbar{display:flex;align-items:center;gap:var(--sp-3,12px);margin-bottom:var(--sp-3,12px);flex-wrap:wrap}',

			/* 预设卡 */
			'.netsteer-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(220px,100%),1fr));gap:var(--sp-3,12px);margin:.6em 0 1em 0}',
			'.netsteer-preset{display:block;text-align:left;background:var(--s1,#f8f9fa);border:1px solid var(--line,#d6dade);border-radius:var(--r,6px);padding:var(--sp-3,12px) var(--sp-4,16px);cursor:pointer;font:inherit;color:var(--text-2,#4a515a);transition:border-color .15s,background .15s}',
			'.netsteer-preset:hover{border-color:var(--line-2,#c1c7ce)}',
			'.netsteer-preset.on{border-color:var(--accent,#c8f031);background:var(--accent-soft,rgba(122,163,0,.13))}',
			'.netsteer-preset-name{display:flex;align-items:center;gap:.5em;font-size:var(--fs-md,14px);font-weight:600;color:var(--text,#14171a);margin-bottom:.3em}',
			'.netsteer-preset.on .netsteer-preset-name{color:var(--text,#14171a)}',
			'.netsteer-preset-desc{font-size:var(--fs-sm,12px);line-height:1.5;color:var(--text-3,#5f666f)}',
			'.netsteer-preset.on .netsteer-preset-desc{color:var(--text-2,#4a515a)}',
			'.netsteer-tag{font-size:.72em;font-weight:600;padding:.1em .5em;border-radius:999px;background:var(--accent,#c8f031);color:var(--accent-ink,#151b00)}',

			/* 接口卡行 + 芯片 */
			'.netsteer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(300px,100%),1fr));gap:var(--sp-3,12px);margin:.6em 0 1.2em 0}',
			'.netsteer-row{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2,8px);margin:.5em 0}',
			'.netsteer-rowlabel{display:flex;flex-direction:column;gap:.15em;font-size:var(--fs-sm,12px);color:var(--text-2,#4a515a)}',
			'.netsteer-mask{font-style:normal;font-family:var(--mono,ui-monospace,monospace);font-size:.92em;color:var(--text-3,#5f666f)}',
			'.netsteer-chips{display:flex;flex-wrap:wrap;gap:.3em}',
			'.netsteer-chip{min-width:2.3em;padding:.28em .5em;border-radius:999px;border:1px solid var(--line-2,#c1c7ce);background:var(--s2,#fff);color:var(--text-3,#5f666f);cursor:pointer;font-size:var(--fs-sm,12px);font-family:var(--mono,ui-monospace,monospace);transition:all .15s}',
			'.netsteer-chip:hover{border-color:var(--accent,#c8f031)}',
			'.netsteer-chip.on{background:var(--accent-soft,rgba(122,163,0,.13));border-color:var(--accent,#c8f031);color:var(--text,#14171a);font-weight:600}',

			/* 软中断分布 (Memory 卡同款) */
			'.netsteer-softirq{margin:.6em 0}',
			'.netsteer-minibtn{border:1px solid var(--line-2,#c1c7ce);background:var(--s2,#fff);color:var(--text-2,#4a515a);border-radius:var(--r-sm,4px);padding:.2em .7em;font-size:var(--fs-sm,12px);cursor:pointer}',
			'.netsteer-minibtn:hover{border-color:var(--accent,#c8f031);color:var(--text-2,#4a515a)}',
			'.netsteer-conc{display:flex;align-items:baseline;gap:.7em;margin:.2em 0 .8em 0}',
			'.netsteer-big{font-size:26px;font-weight:700;font-family:var(--mono,ui-monospace,monospace);color:var(--text,#14171a);line-height:1}',
			'.netsteer-big.is-ok{color:var(--ok,#0b7f6c)}',
			'.netsteer-big.is-bad{color:var(--warn,#9a5b00)}',
			'.netsteer-sq-row{display:grid;grid-template-columns:9.5em 1fr 5em;align-items:center;gap:var(--sp-3,12px);margin:.55em 0}',
			'.netsteer-sq-label{font-size:var(--fs-sm,12px);color:var(--text-2,#4a515a)}',
			'.netsteer-sq-total{font-family:var(--mono,ui-monospace,monospace);font-size:var(--fs-sm,12px);color:var(--text-2,#4a515a);text-align:right}',
			'.netsteer-stack{display:flex;height:14px;border-radius:999px;background:var(--s3,#eef0f3);overflow:hidden}',
			'.netsteer-stack-seg{height:100%;min-width:2px}',
			'.netsteer-stack-seg:hover{filter:brightness(1.12)}',
			'.netsteer-legend{display:flex;gap:1.1em;margin-top:.7em;flex-wrap:wrap}',
			'.netsteer-legend-item{display:inline-flex;align-items:center;gap:.35em;font-size:var(--fs-sm,12px);color:var(--text-3,#5f666f)}',
			'.netsteer-dot{display:inline-block;width:.7em;height:.7em;border-radius:2px}',

			/* 测速结果表 */
			'.netsteer-tune-table{width:100%;border-collapse:collapse;margin:.6em 0}',
			'.netsteer-tune-table th,.netsteer-tune-table td{padding:.35em .6em;border-bottom:1px solid var(--line-2,#e3e6ea);font-size:var(--fs-sm,12px);text-align:left}',
			'.netsteer-tune-table th{color:var(--text-3,#5f666f);font-weight:600}',

			/* v2 窄屏路径图: 文字可读性优先 */
			'.ns-wires-svg.ns-narrow .ns-node-t{font-size:17px}',
			'.ns-wires-svg.ns-narrow .ns-node-s{font-size:12px}',
			'.ns-wires-svg.ns-narrow .ns-wire-rate{font-size:13px}',
			/* 吞吐空态骨架 */
			'.ns-skeleton{stroke:var(--vt-line,#d6dade);stroke-width:1;stroke-dasharray:4 5}',
			'.ns-skeleton-block{fill:none}',
			'.ns-traffic-svg:not(.ns-empty) .ns-skeleton, .ns-traffic-svg:not(.ns-empty) .ns-skeleton-block{display:none}',
			'.ns-traffic-svg.ns-empty .ns-area-rx,.ns-traffic-svg.ns-empty .ns-line-rx,.ns-traffic-svg.ns-empty .ns-area-tx,.ns-traffic-svg.ns-empty .ns-line-tx{display:none}',
			/* 提示字对比度提升 + 移动底部安全区 */
			'.netsteer-root .vt-hint{color:var(--vt-text-2,var(--text-2,#4a515a))}',
			'@media (max-width: 640px){',
			'	.netsteer-root{padding-bottom:calc(120px + env(safe-area-inset-bottom, 0px))}',
			'	.ns-traffic-nums{gap:14px}',
			'	.vt-tile-head .vt-hint{display:none}',
			'}',
			/* v2 总览: 复用主题 vt token; 主题未加载时有兜底色 */
			'.ns-wires{padding:14px 18px 10px}',
			'.ns-wires-svg{width:100%;height:auto;display:block}',
			'.ns-master-body{display:flex;align-items:center;gap:18px;padding:4px 0}',
			'.netsteer-root .ns-toggle{flex:none;width:58px!important;height:32px!important;border-radius:16px!important;border:1px solid var(--vt-line,var(--line,#d6dade))!important;background:var(--vt-surface-3,var(--s2,#eceef1))!important;position:relative!important;cursor:pointer;transition:background .25s;padding:0!important;display:block!important;appearance:none!important}',
			'.netsteer-root .ns-toggle.on{background:var(--vt-accent,#c8f031)!important;border-color:var(--vt-accent-line,var(--vt-accent,#c8f031))!important}',
			'.netsteer-root .ns-toggle-knob{position:absolute!important;top:3px!important;left:3px!important;width:24px!important;height:24px!important;border-radius:50%!important;background:var(--vt-surface,#fff)!important;box-shadow:0 1px 4px rgba(0,0,0,.25);transition:left .22s;display:block!important}',
			'.netsteer-root .ns-toggle.on .ns-toggle-knob{left:29px!important}',
			'.ns-master-info{min-width:0;flex:1}',
			'.ns-master-desc{font-size:12.5px;color:var(--vt-text-3,var(--text-3,#5f666f));margin:0 0 4px}',
			'.ns-master-gain{font-size:13px;font-weight:600;color:var(--vt-text,var(--text,#14171a));margin:0}',
			'.ns-master-gain.ns-has-gain{color:var(--vt-accent-line,var(--vt-accent,#5a7d0a))}',
			'.ns-modal-title{font-size:15px;font-weight:700;margin:0 0 8px}',
			'.ns-modal-body{font-size:13px;margin:0 0 14px;line-height:1.55}',
			'.ns-gain-line{fill:none;stroke:var(--vt-accent,#c8f031);stroke-width:1.4;stroke-dasharray:1 3;opacity:.9}',
			'.ns-gain-zero{stroke:var(--vt-line,#d6dade);stroke-width:.8;stroke-dasharray:2 4}',
			'.ns-legend-gain{color:var(--vt-accent-line,var(--vt-accent,#5a7d0a))}',
'.ns-node{fill:var(--vt-surface,var(--s1,#f8f9fa));stroke:var(--vt-line,var(--line,#d6dade));stroke-width:1.5;transition:stroke .3s}',
			'.ns-node-hub{stroke:var(--vt-accent-line,var(--vt-accent,#c8f031));stroke-width:2}',
			'.ns-node-ico-p{fill:none;stroke:var(--vt-accent-line,var(--vt-accent,#c8f031));stroke-width:1.7;stroke-linecap:round;stroke-linejoin:round}',
			'.ns-node-t{font-size:14px;font-weight:600;fill:var(--vt-text,var(--text,#14171a))}',
			'.ns-node-s{font-size:10.5px;fill:var(--vt-text-3,var(--text-3,#5f666f))}',
			'.ns-wire{fill:none;stroke:var(--vt-line,var(--line,#d6dade));stroke-width:2;stroke-dasharray:1 0}',
			'.ns-dot{fill:var(--vt-accent,var(--accent,#3563e9))}',
			'.ns-wire-rate{font-size:11px;font-weight:600;fill:var(--vt-text-2,var(--text-2,#4a515a));font-family:var(--vt-mono,var(--mono,ui-monospace,monospace));font-variant-numeric:tabular-nums}',
			'.ns-wire-rate.ns-busy{fill:var(--vt-accent,var(--accent,#3563e9))}',
			'.ns-wires-foot{margin:4px 0 0}',
			'.ns-health{display:grid;gap:10px;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));margin:10px 0}',
			'.ns-hc .vt-dcard-value{font-size:var(--vt-fs-xl,20px);font-weight:680;letter-spacing:-.015em}',
			'.ns-hc.ns-good .vt-dcard-value{color:var(--vt-ok,var(--ok,#0b7f6c))}',
			'.ns-hc.ns-bad .vt-dcard-value{color:var(--vt-err,var(--err,#c42b2b))}',
			'.ns-hc.ns-bad{animation:vt-in .3s ease}',
			'.ns-traffic{padding:14px 18px}',
			'.ns-traffic-nums{display:flex;gap:22px;margin:2px 0 8px}',
			'.ns-traffic-nums b{font-size:var(--vt-fs-lg,16px);margin-left:6px;font-weight:650}',
			'.ns-traffic-svg{width:100%;height:120px;display:block}',
			'.ns-area-rx{fill:var(--vt-chart-1,var(--accent,#3563e9));opacity:.14}',
			'.ns-line-rx{fill:none;stroke:var(--vt-chart-1,var(--accent,#3563e9));stroke-width:1.6}',
			'.ns-area-tx{fill:var(--vt-chart-2,#2a78d6);opacity:.12}',
			'.ns-line-tx{fill:none;stroke:var(--vt-chart-2,#2a78d6);stroke-width:1.6;stroke-dasharray:3 2}',
			'.ns-traffic-num{display:flex;align-items:center;gap:6px}',
			'.ns-sw{width:14px;height:3px;border-radius:2px;flex:none}',
			'.ns-sw-tx{background-image:linear-gradient(90deg,currentColor 55%,transparent 55%);background-size:5px 3px}','.ns-traffic-foot{margin:6px 0 0}',
			'.ns-grid{stroke:var(--vt-line,#d6dade);stroke-width:1;stroke-dasharray:3 6;opacity:.55}',
			'.ns-axis-y{font-size:11px;fill:var(--vt-text-3,#5f666f);font-family:var(--vt-mono,monospace);text-anchor:end}',
			'.ns-axis-x{font-size:10.5px;fill:var(--vt-text-3,#5f666f);opacity:.8}',
			'.vt-tile-head{display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px}',
			'.vt-tile-title{font-size:var(--vt-fs-md,14px);font-weight:640}',

			/* 横向 Tab */
			'.netsteer-tabs{display:flex;gap:4px;border-bottom:2px solid var(--line,#d6dade);margin:10px 0 4px;flex-wrap:wrap}',
			'.netsteer-tab{appearance:none;border:none;background:transparent;padding:8px 14px;font-size:var(--fs-md,14px);font-weight:600;color:var(--text-3,#5f666f);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px}',
			'.netsteer-tab:hover{color:var(--text,#14171a)}',
			'.netsteer-tab.on{color:var(--text,#14171a);border-bottom-color:var(--vt-accent-line,var(--vt-accent,#c8f031))}',
			'.netsteer-tabpanel{padding-top:6px}',

			/* 移动端: 触控热区放大 + 布局防挤 + 避开主题固定底栏 */
			'@media (max-width: 640px){',
			'.netsteer-root{padding-bottom:96px}',
			'.netsteer-statusbar{flex-direction:column;align-items:flex-start;gap:6px}',
			'.netsteer-chip{min-width:2.9em;min-height:44px;padding:.5em .55em}',
			'.netsteer-row{flex-wrap:wrap;row-gap:.45em}',
			'.netsteer-sq-row{grid-template-columns:6.2em 1fr 3.8em;gap:8px}',
			'.netsteer-lede{font-size:13px;line-height:1.55}',
			'.netsteer-big{font-size:22px}',
			'.netsteer-conc{margin:.1em 0 .6em 0}',
			'h2{font-size:20px}',
			'}'
		].join(''));

		/* Tab 面板内容 */
		var panelSteer = E('div', { 'class': 'netsteer-tabpanel', 'id': 'netsteer-panel-pro' }, [
			E('p', { 'class': 'netsteer-lede' }, [
				E('span', {}, _('把网络负载摊到全部 %d 个核心，多设备高速下载时不掉速、不卡顿。'.format(NCPU))),
				E('button', { 'class': 'netsteer-help', 'type': 'button', 'title': _('了解原理与用法'), 'click': ui.createHandlerFn(this, 'toggleHelp') }, '?')
			]),
			E('div', { 'class': 'netsteer-card netsteer-statusbar' }, [
				E('span', { 'class': 'netsteer-badge' + (cur ? '' : ' is-custom'), 'id': 'netsteer-badge' }, _('当前：%s'.format(curLabel))),
				E('button', {
					'class': 'netsteer-minibtn',
					'type': 'button',
					'click': ui.createHandlerFn(this, 'runAutotune')
				}, _('智能测速推荐')),
				E('span', { 'class': 'netsteer-note' }, _('选一个方案，或逐核自定义'))
			]),
			E('div', { 'class': 'netsteer-presets' }, Object.keys(PRESETS).map(function(name) {
				var p = PRESETS[name];
				return E('button', {
					'class': 'netsteer-preset' + (cur === name ? ' on' : ''),
					'data-preset': name,
					'title': p.desc,
					'click': ui.createHandlerFn(self, 'applyPreset')
				}, [
					E('div', { 'class': 'netsteer-preset-name' }, [ p.label, p.rec ? E('span', { 'class': 'netsteer-tag' }, _('推荐')) : '' ]),
					E('div', { 'class': 'netsteer-preset-desc' }, p.short)
				]);
			})),
			E('div', { 'class': 'netsteer-grid' }, IFACES.map(function(it, i) {
				return self.renderIface(it, values.slice(1), i, state);
			})),
			E('div', { 'style': 'height:12px' }),
			this.renderSoftirqCard(values[1 + IFACES.length * 2] || ''),
			E('div', { 'id': 'netsteer-irq-card-slot' }, [ this.renderIrqCard('') ])
		]);
				/* IRQ 列表异步填入 (不阻塞首屏) */
		var self2 = this;
		fs.exec('/usr/bin/netsteer-irq', ['get']).then(function(r) {
			var slot = document.getElementById('netsteer-irq-card-slot');
			if (slot) slot.replaceChildren(self2.renderIrqCard((r && r.stdout) || ''));
		});
/* 主题 token + 总览面板 (wires/health/traffic) */
		this.loadVtCss();
		var panelOverview = E('div', { 'class': 'netsteer-tabpanel', 'id': 'netsteer-panel-overview' }, [
			this.renderMaster(),
			this.renderWires(),
			E('div', { 'id': 'ns-health-slot' }, [ this.renderHealth(null) ]),
			this.renderTraffic()
		]);
		/* 体检数据异步喂 health (audit 3s 采样不阻塞首屏) */
		var selfOv = this;
		fs.exec('/usr/bin/netsteer-audit', []).then(function(r) {
			var a = null;
			try { a = JSON.parse((r && r.stdout || '').trim()); } catch (e) {}
						var slot = document.getElementById('ns-health-slot');
			if (slot) slot.replaceChildren(selfOv.renderHealth(a));
		});
		var panelSmart = E('div', { 'class': 'netsteer-tabpanel', 'id': 'netsteer-panel-smart' }, [
			this.renderP2PCard(values[3 + IFACES.length * 2]),
			this.renderAuditCard()
		]);
		var panelGame = E('div', { 'class': 'netsteer-tabpanel', 'id': 'netsteer-panel-game' }, [
			this.renderGameCard(values[4 + IFACES.length * 2])
		]);
		var PANELS = { overview: panelOverview, smart: panelSmart, game: panelGame, pro: panelSteer };

		/* Tab 菜单 (hash 记忆当前页) */
		var TABS = tabStructure();
		var initial = (location.hash || '').replace('#tab-', '');
		var active = TABS.some(function(t) { return t.id === initial; }) ? initial : TABS[0].id;
		var menu = E('div', { 'class': 'netsteer-tabs', 'role': 'tablist' }, TABS.map(function(t) {
			return E('button', {
				'class': 'netsteer-tab' + (t.id === active ? ' on' : ''),
				'type': 'button',
				'role': 'tab',
				'data-tab': t.id,
				'click': function(ev) {
					TABS.forEach(function(x) { PANELS[x.id].style.display = x.id === t.id ? '' : 'none'; });
					document.querySelectorAll('.netsteer-tab').forEach(function(el) { el.classList.toggle('on', el.getAttribute('data-tab') === t.id); });
					history.replaceState(null, '', '#tab-' + t.id);
				}
			}, t.name);
		}));
		Object.keys(PANELS).forEach(function(id) { PANELS[id].style.display = id === active ? '' : 'none'; });

		
		var root = E('div', { 'class': 'netsteer-root vt-app' }, [
			css,
			E('h2', {}, _('网络加速 NetSteer')),
			menu,
			panelOverview,
			panelSmart,
			panelGame,
			panelSteer
		]);
		/* 总览 5s 轮询 (可见时) + visibility 节流 */
		var pollFn = function() {
			if (document.getElementById('netsteer-panel-overview') && document.getElementById('netsteer-panel-overview').style.display !== 'none' && !document.hidden)
				self.pollTraffic();
		};
		window.setInterval(pollFn, 5000);
		window.setTimeout(pollFn, 300);
		/* 游戏通道 8s 轮询 (probe 延迟采样 + tin 分桶速率) */
		var pollGameFn = function() {
			var pg = document.getElementById('netsteer-panel-game');
			if (pg && pg.style.display !== 'none' && !document.hidden)
				self.pollGame();
		};
		window.setInterval(pollGameFn, 8000);
		window.setTimeout(pollGameFn, 1200);
		menu.addEventListener('click', function(ev) {
			var b = ev.target.closest ? ev.target.closest('.netsteer-tab') : null;
			if (!b) return;
			var tid = b.getAttribute('data-tab');
		});

		/* 首次使用: 自动询问智能测速 */
		if (!meta.autotuneDone)
			window.setTimeout(function() { self.autotuneAsk(); }, 800);

		return root;
	}
});
