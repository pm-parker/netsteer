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
			desc: _('软中断分摊到全部 %d 核，硬中断错开应门。通用推荐：负载最均匀。'.format(NCPU)),
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
			return Promise.all(tasks);
		});
	},

	/* ---- 软中断分布卡 (首页 Memory 卡同款: 大数字 + 堆叠条 + 图例) ---- */
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
				}, _('刷新'))
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
					_('中断应门 (IRQ)'),
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
					_('中断应门 (IRQ)'),
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
			E('div', { 'class': 'netsteer-foot' }, !it.virtual ? _('点选即生效 · 中断行： 单队列网卡，内核只在所选核上应门') : _('点选即生效'))
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
			el.textContent = _('当前: %s'.format(cur ? PRESETS[cur].label : '自定义组合'));
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
			'.netsteer-help{flex:none;width:1.35em;height:1.35em;border-radius:50%;border:1px solid var(--line-2,#c1c7ce);background:var(--s2,#fff);color:var(--text-3,#5f666f);font-size:12px;font-weight:700;line-height:1.3;cursor:pointer;padding:0}',
			'.netsteer-help:hover{border-color:var(--accent,#c8f031);color:var(--text,#14171a)}',
			'.netsteer-help-pop{position:absolute;z-index:200;max-width:300px;margin:0;display:flex;flex-direction:column;gap:.1em}',
			'.netsteer-help-pop strong{font-size:var(--fs-sm,12px);color:var(--text,#14171a);margin-top:.5em}',
			'.netsteer-help-pop p{margin:.1em 0}',

			/* 徽标 (accent-soft 底, 不再大色块) */
			'.netsteer-badge{display:inline-flex;align-items:center;gap:.4em;padding:.22em .85em;border-radius:999px;border:1px solid var(--accent,#c8f031);background:var(--accent-soft,rgba(122,163,0,.13));color:var(--text,#14171a);font-size:var(--fs-sm,12px);font-weight:600}',
			'.netsteer-badge.is-custom{border-color:var(--line-2,#c1c7ce);background:var(--s3,#eef0f3);color:var(--text-2,#4a515a)}',
			'.netsteer-badge::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--accent,#c8f031)}',
			'.netsteer-badge.is-custom::before{background:var(--text-3,#5f666f)}',

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

		var root = E('div', { 'class': 'netsteer-root' }, [
			css,
			E('h2', {}, _('网络分核加速')),
			E('p', { 'class': 'netsteer-lede' }, [
				E('span', {}, _('把网络负载摊到全部 %d 个核心，多设备高速下载时不掉速、不卡顿。'.format(NCPU))),
				E('button', { 'class': 'netsteer-help', 'type': 'button', 'title': _('了解原理与用法'), 'click': ui.createHandlerFn(this, 'toggleHelp') }, '?')
			]),
			E('div', { 'class': 'netsteer-card netsteer-statusbar' }, [
				E('span', { 'class': 'netsteer-badge' + (cur ? '' : ' is-custom'), 'id': 'netsteer-badge' }, _('当前: %s'.format(curLabel))),
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
			this.renderSoftirqCard(values[1 + IFACES.length * 2] || ''),
			this.renderP2PCard(values[3 + IFACES.length * 2])
		]);

		/* 首次使用: 自动询问智能测速 */
		if (!meta.autotuneDone)
			window.setTimeout(function() { self.autotuneAsk(); }, 800);

		return root;
	}
});
