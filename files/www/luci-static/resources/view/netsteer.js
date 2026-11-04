/* NetSteer — RPS/RFS/XPS 转向调优 (LuCI ucode-era view)
 * M2 首版: 现值展示 + CPU 掩码点选 + 应用
 * 界面随 Vantage 主题; 自定义样式走 .netsteer-* 命名空间
 */
'use strict';
'require view';
'require fs';
'require uci';

var IFACES = [ 'eth0', 'eth1', 'pppoe-wan' ];

function maskToCpus(mask) {
	var m = parseInt(mask, 16) || 0;
	return [0,1,2,3].map(function(i){ return (m & (1<<i)) !== 0; });
}
function cpusToMask(cpus) {
	return cpus.reduce(function(m,c,i){ return m | (c ? (1<<i) : 0); }, 0).toString(16);
}

return view.extend({
	load: function() {
		var tasks = { uci: L.resolveDefault(uci.load('netsteer')) };
		IFACES.forEach(function(iface) {
			tasks[iface + '.rps'] = L.resolveDefault(fs.read('/sys/class/net/' + iface + '/queues/rx-0/rps_cpus'), '0');
			tasks[iface + '.xps'] = L.resolveDefault(fs.read('/sys/class/net/' + iface + '/queues/tx-0/xps_cpus'), '0');
		});
		tasks['softirqs'] = L.resolveDefault(fs.read('/proc/softirqs'), '');
		return Promise.all(Object.values(tasks)).then(function(values) {
			var out = {};
			Object.keys(tasks).forEach(function(k, i){ out[k] = values[i]; });
			return out;
		});
	},

	renderSoftirqBars: function(text) {
		/* /proc/softirqs NET_RX 行 → 每核条形 */
		var rx = (text.match(/NET_RX:\s+([\s\d]+)/) || [])[1] || '';
		var counts = rx.trim().split(/\s+/).map(Number).filter(function(n){ return !isNaN(n); });
		if (!counts.length) return E('p', {}, _('暂无数据'));
		var max = Math.max.apply(null, counts) || 1;
		return E('div', { 'class': 'netsteer-cpubars' }, counts.map(function(c, i) {
			return E('div', { 'class': 'netsteer-cpubar' }, [
				E('div', { 'class': 'netsteer-cpubar-fill', 'style': 'height:%d%%'.format(Math.max(4, c*100/max)) }),
				E('span', {}, 'CPU%d'.format(i))
			]);
		}));
	},

	renderIfaceCard: function(iface, data) {
		var rps = (data[iface + '.rps'] || '0').trim();
		var xps = (data[iface + '.xps'] || '0').trim();
		var rpsCpus = maskToCpus(rps), xpsCpus = maskToCpus(xps);
		var note = (iface === 'pppoe-wan') ? _('（虚拟设备 · 重拨后自动重应用）') : '';
		return E('div', { 'class': 'netsteer-card' }, [
			E('h3', {}, iface + ' ' + note),
			E('div', { 'class': 'netsteer-row' }, [
				E('label', {}, _('收包 RPS (现值 %s)').format(rps)),
				E('div', { 'class': 'netsteer-chips' }, rpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'data-iface': iface, 'data-kind': 'rps', 'data-cpu': i,
						'click': ui.createHandlerFn(this, this.toggleCpu)
					}, 'CPU%d'.format(i));
				}, this))
			]),
			E('div', { 'class': 'netsteer-row' }, [
				E('label', {}, _('发包 XPS (现值 %s)').format(xps)),
				E('div', { 'class': 'netsteer-chips' }, xpsCpus.map(function(on, i) {
					return E('button', {
						'class': 'netsteer-chip' + (on ? ' on' : ''),
						'data-iface': iface, 'data-kind': 'xps', 'data-cpu': i,
						'click': ui.createHandlerFn(this, this.toggleCpu)
					}, 'CPU%d'.format(i));
				}, this))
			])
		]);
	},

	toggleCpu: function(ev, node) {
		node.classList.toggle('on');
		/* 汇总该接口该方向的 chip 状态 → 写 uci */
		var iface = node.getAttribute('data-iface'), kind = node.getAttribute('data-kind');
		var cpus = document.querySelectorAll('.netsteer-chip[data-iface="%s"][data-kind="%s"]'.format(iface, kind));
		var mask = '0';
		cpus.forEach(function(chip) {
			if (chip.classList.contains('on'))
				mask = cpusToMask([false,false,false,false].map(function(_, i) {
					return chip.getAttribute('data-cpu') == i && chip.classList.contains('on');
				}) ? [] : []);
		});
		/* 简化: 直接按 DOM 重建掩码 */
		var arr = [false,false,false,false];
		cpus.forEach(function(chip){ if (chip.classList.contains('on')) arr[+chip.getAttribute('data-cpu')] = true; });
		uci.set('netsteer', iface.replace(/[^a-z0-9]/g,'_'), kind + '_cpus', cpusToMask(arr));
	},

	handleApply: function(ev) {
		return uci.save().then(function() {
			return uci.apply();
		}).then(function() {
			return fs.exec('/usr/bin/netsteer-apply');
		}).then(function() {
			return location.reload();
		});
	},

	render: function(data) {
		var self = this;
		var node = E('div', {}, [
			E('h2', {}, _('NetSteer · 软中断转向加速')),
			E('p', { 'class': 'netsteer-sub' }, _('单队列网卡的 RPS/RFS/XPS 分核调优 · 修改即时写入 uci 并应用')),
			E('div', { 'class': 'netsteer-grid' }, IFACES.map(function(iface) {
				return self.renderIfaceCard(iface, data);
			}, self)),
			E('h3', {}, _('各核收包软中断分布 (NET_RX)')),
			self.renderSoftirqBars(data.softirqs || ''),
			E('div', { 'class': 'netsteer-actions' }, [
				E('button', {
					'class': 'cbi-button cbi-button-apply important',
					'click': ui.createHandlerFn(self, self.handleApply)
				}, _('保存并应用'))
			])
		]);
		return node;
	}
});
