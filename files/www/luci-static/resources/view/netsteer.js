/* NetSteer — RPS/RFS/XPS 软中断转向调优 (LuCI ucode-era 视图, M2+M3)
 * 界面随 LuCI/Vantage 主题; 自定义样式 .netsteer-* 命名空间
 */
'use strict';
'require view';
'require fs';
'require uci';
'require ui';

/* 直调 ubus 的轻量应用链 (rpc.declare 在本环境调用挂起, 改用裸 fetch /ubus/) */
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
	{ dev: 'eth0',      sec: 'eth0',      note: 'WAN 物理' },
	{ dev: 'eth1',      sec: 'eth1',      note: 'LAN 物理' },
	{ dev: 'pppoe-wan', sec: 'pppoe_wan', note: 'PPPoE 虚拟 · 重拨自动重应用' }
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
	if (mask === '3') return _('C0+C1');
	if (mask === 'c') return _('C2+C3');
	return _('自定义 (%s)'.format(mask));
}

/* ---- v1.3: 预设定义 (applyPreset 与当前模式判定共用) ---- */
var PRESETS = {
	all: {
		label: _('全核分摊'),
		desc: _('四个核一起收包。通用推荐: 转发压力平均摊到所有核, 高负载时最稳。'),
		map: { eth0: 'f', eth1: 'f', pppoe_wan: 'f' }
	},
	pairs: {
		label: _('收发分对'),
		desc: _('WAN 口 (eth0) 用 C0+C1, LAN 口 (eth1) 用 C2+C3, 进出流量互不抢核。适合路由转发为主的场景。'),
		map: { eth0: '3', eth1: 'c', pppoe_wan: 'f' }
	},
	off: {
		label: _('全部关闭'),
		desc: _('恢复内核默认 (软中断只在单个核处理)。排障对比用, 不推荐日常。'),
		map: { eth0: '0', eth1: '0', pppoe_wan: '0' }
	}
};

/* 当前系统状态匹配哪个预设: 返回 'all'|'pairs'|'off'|null(自定义) */
function matchPreset(masks) {
	var keys = Object.keys(PRESETS);
	for (var i = 0; i < keys.length; i++) {
		var m = PRESETS[keys[i]].map, hit = true;
		Object.keys(m).forEach(function(sec) {
			if (masks[sec] !== m[sec]) hit = false;
		});
		if (hit) return keys[i];
	}
	return null;
}

return view.extend({
	load: function() {
		var tasks = [];
		IFACES.forEach(function(it) {
			tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus'), null));
			tasks.push(L.resolveDefault(fs.read('/sys/class/net/' + it.dev + '/queues/tx-0/xps_cpus'), null));
		});
		tasks.push(L.resolveDefault(fs.read('/proc/softirqs'), ''));
		return Promise.all(tasks).then(function(v) { return v; });
	},

	/* ---- M3: 每核 NET_RX 条形 ---- */
	renderSoftirq: function(text) {
		var m = (text || '').match(/NET_RX:\s+([\s\d]+)/);
		var counts = m ? m[1].trim().split(/\s+/).map(Number).filter(function(n) { return !isNaN(n); }) : [];
		if (!counts.length)
			return E('em', { 'class': 'netsteer-muted' }, [ _('暂无数据') ]);
		var max = Math.max.apply(null, counts) || 1;
		return E('div', { 'class': 'netsteer-cpubars' }, counts.map(function(c, i) {
			return E('div', { 'class': 'netsteer-cpubar-wrap' }, [
				E('span', { 'class': 'netsteer-cpucount' }, c >= 1000000 ? '%.1fM'.format(c / 1e6) : '%dk'.format(Math.round(c / 1e3))),
				E('div', { 'class': 'netsteer-cpubar' }, [
					E('div', { 'class': 'netsteer-cpubar-fill', 'style': 'height:%d%%'.format(Math.max(4, Math.round(c * 100 / max))) })
				]),
				E('span', { 'class': 'netsteer-cpulabel' }, 'CPU%d'.format(i))
			]);
		}));
	},

	/* ---- 接口卡片: 现值 + CPU 芯片点选 ---- */
	renderIface: function(it, values, idx) {
		var self = this;
		var rpsNow = (values[idx * 2] || '0').trim();
		var xpsNow = (values[idx * 2 + 1] || '0').trim();
		var rpsCpus = maskToCpus(rpsNow), xpsCpus = maskToCpus(xpsNow);
		return E('div', { 'class': 'netsteer-card' }, [
			E('div', { 'class': 'netsteer-card-head' }, [
				E('strong', {}, it.dev),
				E('span', { 'class': 'netsteer-muted' }, it.note)
			]),
			E('div', { 'class': 'netsteer-row' }, [
				E('label', {}, _('收包 RPS · %s'.format(maskLabel(rpsNow)))),
				E('div', { 'class': 'netsteer-chips' }, rpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'rps', 'data-cpu': i,
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
			]),
			E('div', { 'class': 'netsteer-row' }, [
				E('label', {}, _('发包 XPS · %s'.format(maskLabel(xpsNow)))),
				E('div', { 'class': 'netsteer-chips' }, xpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'type': 'button',
						'data-sec': it.sec, 'data-kind': 'xps', 'data-cpu': i,
						'click': ui.createHandlerFn(self, 'toggleCpu')
					}, 'C%d'.format(i));
				}))
			])
		]);
	},

	/* 芯片点选: 切换 on → 重算掩码 → 即时应用 (直调 ubus, 无 staged → 无悬浮条) */
	toggleCpu: function(ev) {
		var self = this;
		var node = ev.currentTarget;
		node.classList.toggle('on');
		var sec = node.getAttribute('data-sec');
		var kind = node.getAttribute('data-kind');
		var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="%s"]'.format(sec, kind));
		var arr = [false, false, false, false];
		chips.forEach(function(chip) {
			if (chip.classList.contains('on'))
				arr[+chip.getAttribute('data-cpu')] = true;
		});
		var opt = {};
		opt[kind + '_cpus'] = cpusToMask(arr);
		return applyNow([{ sec: sec, values: opt }])
			.then(function() { self.refreshBadge(); })
			.catch(function(e) {
				ui.showModal(_('出错'), E('p', {}, String(e)));
			});
	},

	/* 点芯片后更新「当前模式」徽标 (读真实 sysfs 运行态, 不 reload) */
	refreshBadge: function() {
		var el = document.getElementById('netsteer-badge');
		if (!el) return Promise.resolve();
		var tasks = IFACES.map(function(it) {
			return ubusCall('file', 'read', { path: '/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus' })
				.then(function(v) { return ((v && v.data) ? v.data : '0').trim(); })
				.catch(function() { return '?'; });
		});
		return Promise.all(tasks).then(function(masks) {
			var m = {};
			IFACES.forEach(function(it, i) { m[it.sec] = masks[i]; });
			var cur = matchPreset(m);
			el.textContent = '当前: %s'.format(cur ? PRESETS[cur].label : '自定义组合');
			['all', 'pairs', 'off'].forEach(function(name) {
				var btn = document.querySelector('.netsteer-preset[data-preset="%s"]'.format(name));
				if (btn) btn.classList.toggle('on', cur === name);
			});
		});
	},

	/* ---- M3: 预设 ---- */
	applyPreset: function(ev) {
		/* LuCI createHandlerFn 契约: fn(预绑定参数..., ev) — 事件恒在最后; 从 ev.currentTarget 读属性 */
		var name = ev && ev.currentTarget ? ev.currentTarget.getAttribute('data-preset') : null;
		var preset = PRESETS[name];
		if (!preset) return Promise.resolve();
		/* 记录点击前各口 sysfs 真实值, 供变化摘要 */
		var beforeTasks = IFACES.map(function(it) {
			return ubusCall('file', 'read', { path: '/sys/class/net/' + it.dev + '/queues/rx-0/rps_cpus' })
				.then(function(v) { return (v || '?').trim(); })
				.catch(function() { return '?'; });
		});
		return Promise.all(beforeTasks).then(function(before) {
			var pairs = Object.keys(preset.map).map(function(sec) {
				var opt = { rps_cpus: preset.map[sec] };
				if (sec !== 'pppoe_wan') opt.xps_cpus = preset.map[sec];
				return { sec: sec, values: opt };
			});
			return applyNow(pairs).then(function(res) {
				var names = { eth0: 'eth0', eth1: 'eth1', pppoe_wan: 'pppoe-wan' };
				var lines = Object.keys(preset.map).map(function(sec, i) {
					return '%s: %s → %s'.format(names[sec], maskLabel(before[i]), maskLabel(preset.map[sec]));
				});
				ui.showModal(_('已切换: %s'.format(preset.label)), [
					E('p', { 'class': 'netsteer-muted' }, preset.desc),
					E('p', {}, lines.map(function(l, i) { return [ i ? E('br') : '', l ]; }))
				]);
				window.setTimeout(function() { ui.hideModal(); }, 3200);
				window.setTimeout(function() { location.reload(); }, 3300);
			});
		})
		.catch(function(e) {
			ui.showModal(_('出错'), E('p', {}, String(e)));
		});
	},

	handleApply: function(ev) {
		return applyNow([])
			.then(function(res) {
				ui.showModal(_('已应用'), E('p', {}, (res && res.stdout ? String(res.stdout) : 'done').split('\n').filter(Boolean).slice(0, 6).join(' · ')));
				window.setTimeout(function() { ui.hideModal(); }, 2500);
				window.setTimeout(function() { location.reload(); }, 2600);
			})
			.catch(function(e) {
				ui.showModal(_('出错'), E('p', {}, String(e)));
			});
	},

	render: function(values) {
		var self = this;
		/* 当前模式判定: 三口 rps 现值 (sysfs) 匹配预设 */
		var masks = {};
		IFACES.forEach(function(it, i) { masks[it.sec] = (values[i * 2] || '0').trim(); });
		var cur = matchPreset(masks);
		var curLabel = cur ? PRESETS[cur].label : _('自定义组合');
		var css = E('style', { 'type': 'text/css' },
			'.netsteer-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:1em;margin:.6em 0}' +
			'.netsteer-card{background:var(--background2,#1c1d1f);border:1px solid var(--border,#333);border-radius:12px;padding:1em}' +
			'.netsteer-card-head{display:flex;justify-content:space-between;margin-bottom:.6em}' +
			'.netsteer-row{display:flex;justify-content:space-between;align-items:center;margin:.45em 0}' +
			'.netsteer-chips{display:flex;gap:.35em}' +
			'.netsteer-chip{min-width:2.4em;padding:.3em .5em;border-radius:999px;border:1px solid var(--border,#444);background:transparent;color:var(--muted,#999);cursor:pointer;font-size:.85em}' +
			'.netsteer-chip.on{background:var(--primary,#2e7cf6);border-color:var(--primary,#2e7cf6);color:#fff}' +
			'.netsteer-cpubars{display:flex;gap:1.4em;align-items:flex-end;height:100px;padding:.6em 0}' +
			'.netsteer-cpubar-wrap{display:flex;flex-direction:column;align-items:center;gap:.25em;flex:1;height:100%;justify-content:flex-end}' +
			'.netsteer-cpubar{width:55%;flex:1;background:var(--background2,#222);border-radius:4px;display:flex;align-items:flex-end;overflow:hidden}' +
			'.netsteer-cpubar-fill{width:100%;background:var(--primary,#2e7cf6);border-radius:4px}' +
			'.netsteer-cpulabel{font-size:.75em;color:var(--muted,#999)}' +
			'.netsteer-cpucount{font-size:.7em;color:var(--muted,#777)}' +
			'.netsteer-muted{color:var(--muted,#8a8f98);font-size:.85em;font-weight:400}' +
			'.netsteer-actions{display:flex;gap:.6em;margin-top:1em;flex-wrap:wrap;align-items:center}' +
			'.netsteer-sub{color:var(--muted,#8a8f98)}' +
			'.netsteer-badge{display:inline-block;padding:.2em .8em;border-radius:999px;background:var(--primary,#2e7cf6);color:#fff;font-size:.8em;font-weight:600}' +
			'.netsteer-preset.on{background:var(--primary,#2e7cf6);border-color:var(--primary,#2e7cf6);color:#fff}' +
			'.netsteer-preshint{font-size:.8em;color:var(--muted,#8a8f98);margin:.4em 0 0 0}');

		return E('div', {}, [
			css,
			E('h2', {}, _('NetSteer · 软中断转向')),
			E('p', { 'class': 'netsteer-sub' }, _('单队列网卡的 RPS/RFS/XPS 分核调优 · 修改写入 uci 后即时应用, 重启/重拨自动保持')),
			E('div', { 'class': 'netsteer-actions' }, [
				E('span', { 'class': 'netsteer-badge', 'id': 'netsteer-badge' }, _('当前: %s'.format(curLabel))),
				E('span', { 'style': 'flex:1' }),
				E('button', { 'class': 'cbi-button netsteer-preset' + (cur === 'all' ? ' on' : ''), 'data-preset': 'all', 'title': PRESETS.all.desc, 'click': ui.createHandlerFn(this, 'applyPreset') }, _('全核分摊')),
				E('button', { 'class': 'cbi-button netsteer-preset' + (cur === 'pairs' ? ' on' : ''), 'data-preset': 'pairs', 'title': PRESETS.pairs.desc, 'click': ui.createHandlerFn(this, 'applyPreset') }, _('收发分对')),
				E('button', { 'class': 'cbi-button cbi-button-reset netsteer-preset' + (cur === 'off' ? ' on' : ''), 'data-preset': 'off', 'title': PRESETS.off.desc, 'click': ui.createHandlerFn(this, 'applyPreset') }, _('全部关闭'))
			]),
			E('p', { 'class': 'netsteer-preshint' }, _([
				'全核分摊 = 四核一起收包 (通用推荐); ',
				'收发分对 = WAN 收包固定 C0+C1 / LAN 收发固定 C2+C3 互不抢核; ',
				'全部关闭 = 恢复内核默认 (排障对比用)。鼠标悬停按钮看详细说明; ',
				'芯片点选即时生效, 无需另点保存。'
			].join(''))),
			E('div', { 'class': 'netsteer-grid' }, IFACES.map(function(it, i) {
				return self.renderIface(it, values, i);
			})),
			E('h3', {}, _('各核收包软中断分布 (NET_RX)')),
			this.renderSoftirq(values[IFACES.length * 2] || '')
		]);
	}
});
