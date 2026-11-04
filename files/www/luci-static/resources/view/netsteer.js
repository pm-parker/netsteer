/* NetSteer — RPS/RFS/XPS 软中断转向调优 (LuCI ucode-era 视图, M2+M3)
 * 界面随 LuCI/Vantage 主题; 自定义样式 .netsteer-* 命名空间
 */
'use strict';
'require view';
'require fs';
'require uci';
'require ui';

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
	return _('自定义');
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

	/* 芯片点选: 切换 on → 重算该组掩码 → uci.set (staged) */
	toggleCpu: function(ev, node) {
		node.classList.toggle('on');
		var sec = node.getAttribute('data-sec');
		var kind = node.getAttribute('data-kind');
		var chips = document.querySelectorAll('.netsteer-chip[data-sec="%s"][data-kind="%s"]'.format(sec, kind));
		var arr = [false, false, false, false];
		chips.forEach(function(chip) {
			if (chip.classList.contains('on'))
				arr[+chip.getAttribute('data-cpu')] = true;
		});
		uci.set('netsteer', sec, kind + '_cpus', cpusToMask(arr));
	},

	/* ---- M3: 预设 ---- */
	applyPreset: function(ev, name) {
		var map = {
			all:   { eth0: 'f', eth1: 'f', pppoe_wan: 'f' },
			pairs: { eth0: '3', eth1: 'c', pppoe_wan: 'f' },
			off:   { eth0: '0', eth1: '0', pppoe_wan: '0' }
		}[name];
		if (!map) return Promise.resolve();
		Object.keys(map).forEach(function(sec) {
			uci.set('netsteer', sec, 'rps_cpus', map[sec]);
			if (sec !== 'pppoe_wan')
				uci.set('netsteer', sec, 'xps_cpus', map[sec]);
		});
		return this.handleApply(ev);
	},

	handleApply: function(ev) {
		return uci.save()
			.then(function() { return uci.apply(); })
			.then(function() { return fs.exec('/usr/bin/netsteer-apply'); })
			.then(function(res) {
				ui.showModal(_('已应用'), E('p', {}, (res && res.stdout ? String(res.stdout) : 'done').split('\n').filter(Boolean).slice(0, 6).join(' · ')));
				window.setTimeout(function() { ui.hideModal(); }, 1500);
				window.setTimeout(function() { location.reload(); }, 1600);
			})
			.catch(function(e) {
				ui.showModal(_('出错'), E('p', {}, String(e)));
			});
	},

	render: function(values) {
		var self = this;
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
			'.netsteer-actions{display:flex;gap:.6em;margin-top:1em;flex-wrap:wrap}' +
			'.netsteer-sub{color:var(--muted,#8a8f98)}');

		return E('div', {}, [
			css,
			E('h2', {}, _('NetSteer · 软中断转向')),
			E('p', { 'class': 'netsteer-sub' }, _('单队列网卡的 RPS/RFS/XPS 分核调优 · 修改写入 uci 后即时应用, 重启/重拨自动保持')),
			E('div', { 'class': 'netsteer-actions' }, [
				E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'applyPreset', 'all') }, _('预设: 全核分摊')),
				E('button', { 'class': 'cbi-button', 'click': ui.createHandlerFn(this, 'applyPreset', 'pairs') }, _('预设: 收发分对')),
				E('button', { 'class': 'cbi-button cbi-button-reset', 'click': ui.createHandlerFn(this, 'applyPreset', 'off') }, _('全部关闭'))
			]),
			E('div', { 'class': 'netsteer-grid' }, IFACES.map(function(it, i) {
				return self.renderIface(it, values, i);
			})),
			E('h3', {}, _('各核收包软中断分布 (NET_RX)')),
			this.renderSoftirq(values[IFACES.length * 2] || ''),
			E('div', { 'class': 'netsteer-actions' }, [
				E('button', { 'class': 'cbi-button cbi-button-apply important', 'click': ui.createHandlerFn(this, 'handleApply') }, _('保存并应用'))
			])
		]);
	}
});
