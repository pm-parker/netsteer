/* NetSteer — 网络分核加速 (LuCI 视图)
 * 视觉: 全量跟随 Vantage 主题变量，深浅模式自动适配
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
		.then(function() { return ubusCall('uci', 'apply', { timeout: 90, rollback: true }); })
		.then(function() { return ubusCall('uci', 'confirm', {}); })
		.then(function() { return fs.exec('/usr/bin/netsteer-apply'); })
}

/* 接口 → uci section 名映射 (uci section 名不含连字符) */
var IFACES = [
	{ dev: 'eth0',      sec: 'eth0',      note: 'WAN 物理口' },
	{ dev: 'eth1',      sec: 'eth1',      note: 'LAN 物理口' },
	{ dev: 'pppoe-wan', sec: 'pppoe_wan', note: 'PPPoE 拨号口 · 重拨自动保持' }
];

function maskToCpus(mask) {
	var m = parseInt(mask, 16) || 0;
	return [0, 1, 2, 3].map(function(i) { return (m & (1 << i)) !== 0; });
}

function cpusToMask(cpus) {
	var m = cpus.reduce(function(acc, on, i) { return acc | (on ? (1 << i) : 0); }, 0);
	return m.toString(16);
}

function maskLabel(mask) {
	if (mask === 'f') return _('全核');
	if (mask === '0') return _('关闭');
	if (mask === '1') return _('C0');
	if (mask === '2') return _('C1');
	if (mask === '4') return _('C2');
	if (mask === '8') return _('C3');
	if (mask === '3') return _('C0+C1');
	if (mask === 'c') return _('C2+C3');
	return _('自定义 (%s)'.format(mask));
}

function fmtCount(n) {
	if (n >= 1e8) return '%.2f亿'.format(n / 1e8);
	if (n >= 1e4) return '%.1f万'.format(n / 1e4);
	return String(n);
}

/* ---- 预设定义 (applyPreset 与当前模式判定共用) ----
 * irq: 硬中断应门核摆位 (实测 A/B 定型: eth0→C3 eth1→C2, 集中度 48.5%→43.0%, 四核 10/7/43/40 最均匀) */
var PRESETS = {
	all: {
		label: _('全核分摊'),
		short: _('四个核一起干活，负载摊得最平。'),
		desc: _('软中断分摊到 CPU0-3, 硬中断应门错开 (WAN→C3, LAN→C2)。通用推荐: 实测四核负载最均匀。'),
		rec: true,
		map: { eth0: 'f', eth1: 'f', pppoe_wan: 'f' },
		irq: { eth0: '8', eth1: '4' }
	},
	pairs: {
		label: _('收发分对'),
		short: _('WAN 和 LAN 各用两个核，互不干扰。'),
		desc: _('WAN 口用 C0+C1, LAN 口用 C2+C3。实测集中度 47% (全核分摊 44%), 高负载场景不如全核分摊均匀，适合想按口隔离试玩的场景。'),
		rec: false,
		map: { eth0: '3', eth1: 'c', pppoe_wan: 'f' },
		irq: { eth0: '2', eth1: '8' }
	},
	off: {
		label: _('系统默认'),
		short: _('关掉分摊，恢复出厂行为。'),
		desc: _('负载回到单个核心处理。仅用于排障对比效果，日常不建议。'),
		rec: false,
		map: { eth0: '0', eth1: '0', pppoe_wan: '0' }
	}
};

/* 当前系统状态匹配哪个预设: 返回 'all'|'pairs'|'off'|null(自定义)
 * irq 数据缺失时只比对 RPS (向后兼容) */
function matchPreset(masks, irq) {
	var keys = Object.keys(PRESETS);
	for (var i = 0; i < keys.length; i++) {
		var p = PRESETS[keys[i]], m = p.map, hit = true;
		Object.keys(m).forEach(function(sec) {
			if (masks[sec] !== m[sec]) hit = false;
		});
		if (hit && p.irq && irq) {
			Object.keys(p.irq).forEach(function(dev) {
				var got = (irq[dev] && irq[dev].affinity) || null;
				if (got && got !== '?' && got !== p.irq[dev]) hit = false;
			});
		}
		if (hit) return keys[i];
	}
	return null;
}

/* /proc/softirqs → { rx: [c0..c3], tx: [c0..c3] } */
function parseSoftirq(text) {
	function row(name) {
		var m = (text || '').match(name + ':\\s+([\\s\\d]+)');
		return m ? m[1].trim().split(/\s+/).map(Number).filter(function(n) { return !isNaN(n); }) : [];
	}
	return { rx: row('NET_RX'), tx: row('NET_TX') };
}

/* 堆叠条 (Memory 卡风格): 段色 --v-chart-1..4, hover 原生 title */
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
			'style': 'width:%s%%;background:var(--v-chart-%d)'.format(pct, i + 1),
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
	return E('div', { 'class': 'netsteer-legend' }, [0, 1, 2, 3].map(function(i) {
		return E('span', { 'class': 'netsteer-legend-item' }, [
			E('i', { 'class': 'netsteer-dot', 'style': 'background:var(--v-chart-%d)'.format(i + 1) }),
			'CPU%d'.format(i)
		]);
	}));
}

return view.extend({
	/* 本页所有改动即时生效，无 Save&Apply 概念; 覆盖基类方法干掉自动 footer 按钮组 */
	addFooter: function() {
		return E([]);
	},

	load: function() {
		var tasks = [];
		IFACES.forEach(function(it) {
			tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus'), null));
			tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/tx-0/xps_cpus'), null));
		});
		tasks.push(L.resolveDefault(fs.read('/proc/softirqs'), ''));
		/* IRQ 现值 (由 netsteer-apply 维护: {eth0:{irq,affinity},...}) */
		tasks.push(L.resolveDefault(fs.read('/tmp/netsteer/state.json'), null));
		/* 守卫记录: 值变化时间线 + 漂移事件列表 */
		tasks.push(L.resolveDefault(fs.read('/tmp/netsteer/history.log'), null));
		tasks.push(L.resolveDefault(fs.list('/etc/netsteer/incidents'), []));
		return Promise.all(tasks);
	},

	/* ---- 软中断分布卡 (首页 Memory 卡同款: 大数字 + 堆叠条 + 图例) ---- */
	renderSoftirqCard: function(text) {
		var d = parseSoftirq(text);
		var rx = d.rx.slice(0, 4), tx = d.tx.slice(0, 4);
		var rxSum = rx.reduce(function(a, b) { return a + b; }, 0);
		var conc = null, concCpu = null;
		if (rxSum > 0) {
			var maxI = 0;
			rx.forEach(function(c, i) { if (c > rx[maxI]) maxI = i; });
			conc = Math.round(rx[maxI] * 100 / rxSum);
			concCpu = maxI;
		}
		/* 均衡时四核各 ~25%; >45% 视为明显集中 */
		var concCls = (conc === null) ? '' : (conc > 45 ? ' is-bad' : ' is-ok');
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
						: _('收包负载集中在 CPU%d。四核分摊生效时应接近 25%%；越集中说明分摊越需要调整。'.format(concCpu)))
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

	/* ---- 运行守卫卡: 值变化时间线 + 漂移事件 (netsteer-check 每分钟产出) ---- */
	renderGuardCard: function(historyText, incidents) {
		var self = this;
		var lines = (historyText || '').trim().split('\n').filter(function(l) { return l; });
		var tail = lines.slice(-5).reverse();  /* 最新在上 */
		var incList = (Array.isArray(incidents) ? incidents : [])
			.sort(function(a, b) { return (b.name || '').localeCompare(a.name || ''); });
		var nInc = incList.length;

		var rows = tail.length
			? tail.map(function(l) {
				var sp = l.indexOf(' ', l.indexOf(' ') + 1);  /* 时间列 = "MM-DD HH:MM" */
				if (sp < 0) sp = l.indexOf(' ');
				return E('div', { 'class': 'netsteer-log-row' }, [
					E('span', { 'class': 'netsteer-log-t' }, l.slice(0, sp)),
					E('span', { 'class': 'netsteer-log-v' }, l.slice(sp + 1))
				]);
			})
			: [ E('span', { 'class': 'netsteer-note' }, _('暂无记录')) ];

		return E('div', { 'class': 'netsteer-card', 'id': 'netsteer-guard-card' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('strong', { 'class': 'netsteer-card-title' }, _('运行守卫')),
				E('button', {
					'class': 'netsteer-minibtn',
					'type': 'button',
					'click': ui.createHandlerFn(self, 'refreshGuard')
				}, _('刷新'))
			]),
			E('div', { 'class': 'netsteer-conc' }, [
				nInc > 0
					? E('span', { 'class': 'netsteer-big is-bad' }, '%d'.format(nInc))
					: E('span', { 'class': 'netsteer-big is-ok' }, '0'),
				E('span', { 'class': 'netsteer-note' },
					nInc > 0
						? _('次参数漂移 — 已全部自动恢复，现场证据已留档')
						: _('次参数漂移 — 正在自动校验，当前一切正常'))
			]),
			E('div', { 'class': 'netsteer-log' },
				[ E('div', { 'class': 'netsteer-log-row netsteer-log-head' }, [
					E('span', { 'class': 'netsteer-log-t' }, _('时间')),
					E('span', { 'class': 'netsteer-log-v' }, _('参数值 (收包分核 / 中断应门)'))
				]) ].concat(rows)),
			nInc > 0
				? E('div', { 'class': 'netsteer-log' }, incList.slice(0, 5).map(function(f) {
					return E('div', { 'class': 'netsteer-log-row' }, [
						E('span', { 'class': 'netsteer-log-t' }, (f.name || '').replace(/^incident-/, '').replace(/\.log$/, '')),
						E('span', { 'class': 'netsteer-log-v' }, _('漂移现场 (系统日志快照)'))
					]);
				}))
				: '',
			E('div', { 'class': 'netsteer-foot' }, _('每分钟自动校验配置与实际运行值，发现被意外改动立即恢复并留痕'))
		]);
	},

	refreshGuard: function() {
		var self = this;
		return Promise.all([
			L.resolveDefault(fs.read('/tmp/netsteer/history.log'), null),
			L.resolveDefault(fs.list('/etc/netsteer/incidents'), [])
		]).then(function(r) {
			var old = document.getElementById('netsteer-guard-card');
			if (old && old.parentNode)
				old.parentNode.replaceChild(self.renderGuardCard(r[0], r[1]), old);
		});
	},

	/* ---- 接口卡: 现值 + CPU 芯片点选 ---- */
	renderIface: function(it, values, idx, state) {
		var self = this;
		var rpsNow = (values[idx * 2] || '0').trim();
		var xpsNow = (values[idx * 2 + 1] || '0').trim();
		var rpsCpus = maskToCpus(rpsNow), xpsCpus = maskToCpus(xpsNow);
		/* IRQ 现值 (state 由 netsteer-apply 维护; pppoe 虚拟口无中断) */
		var irqNow = (state && state[it.dev] && state[it.dev].affinity) || null;
		var irqRow = null;
		if (it.sec !== 'pppoe_wan') {
			var irqOn = irqNow ? maskToCpus(irqNow) : [false, false, false, false];
			irqRow = E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('中断应门 (IRQ)'),
					E('em', { 'class': 'netsteer-mask netsteer-irq-mask' }, irqNow ? maskLabel(irqNow) : _('—'))
				]),
				E('div', { 'class': 'netsteer-chips' }, [0, 1, 2, 3].map(function(i) {
					return E('button', {
						'class': 'netsteer-chip' + (irqOn[i] ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'irq', 'data-cpu': i,
						'title': 'CPU%d'.format(i),
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
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
			irqRow !== null ? irqRow : E('div', { 'class': 'netsteer-row' }, [
				E('span', { 'class': 'netsteer-rowlabel' }, [
					_('中断应门 (IRQ)'),
					E('em', { 'class': 'netsteer-mask' }, _('虚拟接口 · 无硬件中断'))
				])
			]),
			E('div', { 'class': 'netsteer-foot' }, it.sec !== 'pppoe_wan' ? _('点选即生效 · 中断行: 单队列网卡，内核只在所选核上应门') : _('点选即生效'))
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
		var arr = [false, false, false, false];
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
			return ubusCall('file', 'read', { path: '/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus' })
				.then(function(v) { return ((v && v.data) ? v.data : '0').trim(); })
				.catch(function() { return '?'; });
		});
		tasks.push(L.resolveDefault(fs.read('/tmp/netsteer/state.json'), null));
		return Promise.all(tasks).then(function(res) {
			var stateTxt = res.pop();
			var m = {};
			IFACES.forEach(function(it, i) { m[it.sec] = res[i]; });
			var irq = null;
			try { irq = JSON.parse(stateTxt || ''); } catch (e) { irq = null; }
			var cur = matchPreset(m, irq);
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

	/* ---- 预设切换 ---- */
	applyPreset: function(ev) {
		/* LuCI createHandlerFn 契约: fn(预绑定参数..., ev) — 事件恒在最后; 从 ev.currentTarget 读属性 */
		var self = this;
		var name = ev && ev.currentTarget ? ev.currentTarget.getAttribute('data-preset') : null;
		var preset = PRESETS[name];
		if (!preset) return Promise.resolve();
		var pairs = Object.keys(preset.map).map(function(sec) {
			var opt = { rps_cpus: preset.map[sec] };
			if (sec !== 'pppoe_wan') opt.xps_cpus = preset.map[sec];
			return { sec: sec, values: opt };
		});
		/* IRQ 摆位 (off 预设不含 irq 字段 = 中断不动) */
		Object.keys(preset.irq || {}).forEach(function(dev) {
			pairs.push({ sec: dev, values: { irq_cpus: preset.irq[dev] } });
		});
		return applyNow(pairs).then(function() {
			/* 不整页 reload: 就地同步芯片高亮/掩码文字/徽标 */
			var names = { eth0: 0, eth1: 1, pppoe_wan: 2 };
			Object.keys(preset.map).forEach(function(sec) {
				var it = IFACES[names[sec]];
				['rps', 'xps'].forEach(function(kind) {
					if (sec === 'pppoe_wan' && kind === 'xps') return;
					var mask = preset.map[sec];
					var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="%s"]'.format(sec, kind));
					var on = maskToCpus(mask);
					chips.forEach(function(chip, i) {
						chip.classList.toggle('on', on[i]);
					});
					var row = chips.length ? chips[0].closest('.netsteer-row') : null;
					var maskLabelEl = row ? row.querySelector('.netsteer-mask') : null;
					if (maskLabelEl) maskLabelEl.textContent = maskLabel(mask);
				});
			});
			ui.showModal(_('已切换: %s'.format(preset.label)), E('p', { 'class': 'netsteer-note' }, preset.desc));
			window.setTimeout(function() { ui.hideModal(); }, 2200);
			self.refreshBadge();
		})
		.catch(function(e) {
			ui.showModal(_('出错'), E('p', {}, String(e)));
		});
	},

	render: function(values) {
		var self = this;
		/* 当前模式判定: 三口 rps 现值 (sysfs) + IRQ state 匹配预设 */
		var masks = {};
		IFACES.forEach(function(it, i) { masks[it.sec] = (values[i * 2] || '0').trim(); });
		var state = null;
		try { state = JSON.parse(values[IFACES.length * 2 + 1] || ''); } catch (e) { state = null; }
		var cur = matchPreset(masks, state);
		var curLabel = cur ? PRESETS[cur].label : _('自定义组合');

		var css = E('style', { 'type': 'text/css' }, [
			/* 卡片 (首页 Overview 同款: s1 面 + line 描边 + r 圆角 + 极浅阴影) */
			'.netsteer-card{background:var(--s1,#f8f9fa);border:1px solid var(--line,#d6dade);border-radius:var(--r,6px);padding:var(--sp-4,16px);box-shadow:0 1px 2px rgba(0,0,0,.05)}',
			'.netsteer-card-head{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2,8px);margin-bottom:var(--sp-3,12px)}',
			'.netsteer-card-title{font-size:var(--fs-md,14px);font-weight:600;color:var(--text,#14171a)}',
			'.netsteer-note{color:var(--text-3,#5f666f);font-size:var(--fs-sm,12px);font-weight:400}',
			'.netsteer-foot{color:var(--text-3,#5f666f);font-size:var(--fs-sm,12px);margin-top:var(--sp-2,8px)}',

			/* 头部说明 */
			'.netsteer-lede{max-width:64em;color:var(--text-2,#4a515a);font-size:var(--fs-md,14px);line-height:1.65;margin:.4em 0}',
			'.netsteer-lede strong{color:var(--text,#14171a);font-weight:600}',
			'.netsteer-tech{color:var(--text-3,#5f666f);font-size:var(--fs-sm,12px);margin:.2em 0 1em 0}',

			/* 徽标 (accent-soft 底，不再大色块) */
			'.netsteer-badge{display:inline-flex;align-items:center;gap:.4em;padding:.22em .85em;border-radius:999px;border:1px solid var(--accent,#c8f031);background:var(--accent-soft,rgba(122,163,0,.13));color:var(--text,#14171a);font-size:var(--fs-sm,12px);font-weight:600}',
			'.netsteer-badge.is-custom{border-color:var(--line-2,#c1c7ce);background:var(--s3,#eef0f3);color:var(--text-2,#4a515a)}',
			'.netsteer-badge::before{content:"";width:.5em;height:.5em;border-radius:50%;background:var(--accent,#c8f031)}',
			'.netsteer-badge.is-custom::before{background:var(--text-3,#5f666f)}',

			/* 预设卡 */
			'.netsteer-presets{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:var(--sp-3,12px);margin:.6em 0 1em 0}',
			'.netsteer-preset{display:block;text-align:left;background:var(--s1,#f8f9fa);border:1px solid var(--line,#d6dade);border-radius:var(--r,6px);padding:var(--sp-3,12px) var(--sp-4,16px);cursor:pointer;font:inherit;color:var(--text-2,#4a515a);transition:border-color .15s,background .15s}',
			'.netsteer-preset:hover{border-color:var(--line-2,#c1c7ce)}',
			'.netsteer-preset.on{border-color:var(--accent,#c8f031);background:var(--accent-soft,rgba(122,163,0,.13))}',
			'.netsteer-preset-name{display:flex;align-items:center;gap:.5em;font-size:var(--fs-md,14px);font-weight:600;color:var(--text,#14171a);margin-bottom:.3em}',
			'.netsteer-preset.on .netsteer-preset-name{color:var(--text,#14171a)}',
			'.netsteer-preset-desc{font-size:var(--fs-sm,12px);line-height:1.5;color:var(--text-3,#5f666f)}',
			'.netsteer-preset.on .netsteer-preset-desc{color:var(--text-2,#4a515a)}',
			'.netsteer-tag{font-size:.72em;font-weight:600;padding:.1em .5em;border-radius:999px;background:var(--accent,#c8f031);color:var(--accent-ink,#151b00)}',

			/* 接口卡行 + 芯片 */
			'.netsteer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:var(--sp-3,12px);margin:.6em 0 1.2em 0}',
			'.netsteer-row{display:flex;justify-content:space-between;align-items:center;gap:var(--sp-2,8px);margin:.5em 0}',
			'.netsteer-rowlabel{display:flex;flex-direction:column;gap:.15em;font-size:var(--fs-sm,12px);color:var(--text-2,#4a515a)}',
			'.netsteer-mask{font-style:normal;font-family:var(--mono,ui-monospace,monospace);font-size:.92em;color:var(--text-3,#5f666f)}',
			'.netsteer-chips{display:flex;gap:.3em}',
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

			/* 状态条 */
			'.netsteer-statusbar{display:flex;align-items:center;gap:var(--sp-3,12px);margin-bottom:var(--sp-3,12px)}',

			/* 守卫记录日志行 */
			'.netsteer-log{margin:.5em 0;border-top:1px solid var(--line-2,#e3e6ea);padding-top:.5em}',
			'.netsteer-log-row{display:flex;gap:1em;font-family:var(--mono,ui-monospace,monospace);font-size:var(--fs-sm,12px);padding:.18em 0}',
			'.netsteer-log-head{color:var(--text-3,#5f666f);font-family:inherit}',
			'.netsteer-log-t{min-width:5.5em;color:var(--text-3,#5f666f)}',
			'.netsteer-log-v{color:var(--text-2,#4a515a)}',

			/* 移动端: 触控热区放大 + 布局防挤 + 避开主题固定底栏 */
			'@media (max-width: 640px){',
			'.netsteer-root{padding-bottom:96px}',
			'.netsteer-statusbar{flex-direction:column;align-items:flex-start;gap:6px}',
			'.netsteer-chip{min-width:2.9em;min-height:44px;padding:.5em .55em}',
			'.netsteer-row{flex-wrap:wrap;row-gap:.45em}',
			'.netsteer-sq-row{grid-template-columns:6.2em 1fr 3.8em;gap:8px}',
			'.netsteer-log-v{white-space:normal;word-break:break-all}',
			'.netsteer-lede{font-size:13px;line-height:1.55}',
			'.netsteer-tech{font-size:11px}',
			'.netsteer-big{font-size:22px}',
			'.netsteer-conc{margin:.1em 0 .6em 0}',
			'h2{font-size:20px}',
			'}'
		].join(''));

		return E('div', { 'class': 'netsteer-root' }, [
			css,
			E('h2', {}, _('网络分核加速')),
			E('p', { 'class': 'netsteer-lede' }, _(
				'路由器收发的每个数据包都要占用 CPU 处理。系统默认把这份负载压在单个核心上——' +
				'高速下载、多设备并发时单核容易打满，表现为网速上不去、网页卡顿、延迟波动。' +
				'NetSteer 把网络负载均匀分摊到全部四个核心：转发吞吐更高，高峰期依然流畅，CPU 占用更平均。')),
			E('p', { 'class': 'netsteer-tech' }, _(
				'基于内核 RPS / RFS / XPS 机制 · 点选即时生效、断电重启自动恢复 · 随时可切回系统默认')),
			E('div', { 'class': 'netsteer-card netsteer-statusbar' }, [
				E('span', { 'class': 'netsteer-badge' + (cur ? '' : ' is-custom'), 'id': 'netsteer-badge' }, _('当前: %s'.format(curLabel))),
				E('span', { 'class': 'netsteer-note' }, _('下面选择一个方案，或逐核自定义'))
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
				return self.renderIface(it, values, i, state);
			})),
			this.renderSoftirqCard(values[IFACES.length * 2] || ''),
			this.renderGuardCard(values[IFACES.length * 2 + 2], values[IFACES.length * 2 + 3])
		]);
	}
});
