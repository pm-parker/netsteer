#!/usr/bin/env node
// unit tests for netsteer.js pure functions (multi-core logic)
// Extracts the function bodies straight from the source file, so tests track code changes.
// NOTE: intentionally NO 'use strict' — sloppy-mode direct eval is what hoists the
// extracted function declarations and the NCPU/IFACES vars into this module scope.
const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', '..', 'files', 'www', 'luci-static', 'resources', 'view', 'netsteer.js'),
  'utf8'
);

// pull top-level "function name(...) { ... }" declarations for the pure logic functions
const WANT = ['cpuRange', 'fullMask', 'parseCpuRange', 'parseSoftirq', 'maskLabel', 'maskToCpus', 'cpusToMask', 'getPresets', 'matchPreset', 'p2pValidIp', 'p2pValidPort', 'p2pStatusMeta', 'auditConflicts', 'modeDefs', 'recommendModes'];
let extracted = '';
for (const name of WANT) {
  const m = new RegExp('function ' + name + '\\s*\\(', 'g').exec(SRC);
  if (!m) { console.error('FATAL: function %s not found in source', name); process.exit(2); }
  // brace-match to find the end
  let i = SRC.indexOf('{', m.index), depth = 0, end = -1;
  for (; i < SRC.length; i++) {
    if (SRC[i] === '{') depth++;
    else if (SRC[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  extracted += SRC.slice(m.index, end) + '\n';
}

// build an API object inside a single sloppy-mode eval so the extracted functions
// share one scope; NCPU/IFACES live on the global (matching the LuCI view's vars)
const api = eval(
  'var _ = function(s) { return s; };' +   /* stub LuCI i18n */
  'String.prototype.format = function() { var s = String(this), args = arguments, i = 0; return s.replace(/%[sd]/g, function() { return String(args[i++]); }); };' +
  extracted +
  '; ({ cpuRange, fullMask, parseCpuRange, parseSoftirq, maskLabel, maskToCpus, cpusToMask, getPresets, matchPreset, p2pValidIp, p2pValidPort, p2pStatusMeta, auditConflicts, modeDefs, recommendModes,' +
  '  setEnv: function(n, i) { NCPU = n; IFACES = i; } })'
);

let pass = 0, fail = 0;
function eq(got, want, name) {
  const g = JSON.stringify(got), w = JSON.stringify(want);
  if (g === w) { pass++; }
  else { fail++; console.log(`FAIL ${name} got ${g} want ${w}`); }
}
function setup(ncpu, ifaces) {
  api.setEnv(ncpu, ifaces);
}

// ---------- 4-core reference (matches R5C) ----------
const R5C = [
  { dev: 'eth0', sec: 'eth0', virtual: false },
  { dev: 'eth1', sec: 'eth1', virtual: false },
  { dev: 'pppoe-wan', sec: 'pppoe_wan', virtual: true }
];
setup(4, R5C);
eq(api.fullMask(), 'f', '4c fullMask');
eq(api.maskLabel('f'), '全核', '4c maskLabel all');
eq(api.maskLabel('0'), '关闭', '4c maskLabel off');
eq(api.maskLabel('8'), 'C3', '4c maskLabel single');
eq(api.maskToCpus('f'), [true, true, true, true], '4c maskToCpus f');
eq(api.cpusToMask([true, true, true, true]), 'f', '4c cpusToMask all');
eq(api.cpusToMask([false, false, false, true]), '8', '4c cpusToMask cpu3');

const P4 = api.getPresets();
eq(P4.all.map, { eth0: 'f', eth1: 'f', pppoe_wan: 'f' }, '4c all map');
eq(P4.all.irq, { eth0: '8', eth1: '4' }, '4c all irq (top core, second-from-top)');
eq(P4.off.map, { eth0: '0', eth1: '0', pppoe_wan: '0' }, '4c off map');
eq(P4.pairs.map, { eth0: '3', eth1: 'c', pppoe_wan: 'f' }, '4c pairs map (virtual iface stays full)');
eq(P4.pairs.irq, { eth0: '2', eth1: '8' }, '4c pairs irq');

// matchPreset: current state == all preset
const stateAll = { eth0: { irq: '104', affinity: '8' }, eth1: { irq: '105', affinity: '4' } };
eq(api.matchPreset({ eth0: 'f', eth1: 'f', pppoe_wan: 'f' }, stateAll), 'all', '4c matchPreset -> all');
eq(api.matchPreset({ eth0: '0', eth1: '0', pppoe_wan: '0' }, null), 'off', '4c matchPreset -> off');
eq(api.matchPreset({ eth0: '1', eth1: '0', pppoe_wan: '0' }, null), null, '4c matchPreset -> custom');

// parseCpuRange
eq(api.parseCpuRange('0-3'), 4, 'parse 0-3');
eq(api.parseCpuRange('0-15'), 16, 'parse 0-15');
eq(api.parseCpuRange('0-7\\n'), 8, 'parse with newline');
eq(api.parseCpuRange('0'), 1, 'parse single');
eq(api.parseCpuRange(''), 4, 'parse empty fallback');

// parseSoftirq(text) → { rx: [...], tx: [...] }
const soft = '  NET_RX:  100 200 300 400 500 600 700 800\n  NET_TX:   10  20  30  40  50  60  70  80\n';
eq(api.parseSoftirq(soft).rx.slice(0, 4), [100, 200, 300, 400], 'parseSoftirq rx first 4');
eq(api.parseSoftirq(soft).tx.slice(4, 8), [50, 60, 70, 80], 'parseSoftirq tx last 4');
eq(api.parseSoftirq('no match here'), { rx: [], tx: [] }, 'parseSoftirq no match');

// ---------- 2-core ----------
setup(2, [{ dev: 'eth0', sec: 'eth0', virtual: false }, { dev: 'eth1', sec: 'eth1', virtual: false }]);
eq(api.fullMask(), '3', '2c fullMask');
const P2 = getPresets();
eq(P2.all.irq, { eth0: '2', eth1: '1' }, '2c all irq');
eq(P2.pairs.map, { eth0: '1', eth1: '2' }, '2c pairs map (C0/C1 split)');

// ---------- 8-core ----------
setup(8, R5C);
eq(api.fullMask(), 'ff', '8c fullMask');
const P8 = api.getPresets();
eq(P8.all.irq, { eth0: '80', eth1: '40' }, '8c all irq (C7, C6)');
eq(P8.pairs.map.eth0, 'f', '8c pairs wan = lower half f0');
eq(P8.pairs.map.eth1, 'f0', '8c pairs lan = upper half f0');
eq(P8.pairs.map.pppoe_wan, 'ff', '8c pairs virtual = full');
eq(P8.pairs.irq, { eth0: '8', eth1: '80' }, '8c pairs irq (C3, C7)');

// ---------- 16-core ----------
setup(16, R5C);
eq(api.fullMask(), 'ffff', '16c fullMask');
eq(api.getPresets().all.irq, { eth0: '8000', eth1: '4000' }, '16c all irq');

// ---------- P2P 直通 (Fullcone 等效) ----------
eq(api.p2pValidIp('192.168.11.175'), true, 'p2p ip valid 192.168');
eq(api.p2pValidIp('10.0.0.5'), true, 'p2p ip valid 10.x');
eq(api.p2pValidIp('172.16.3.9'), true, 'p2p ip valid 172.16');
eq(api.p2pValidIp('172.32.0.1'), false, 'p2p ip reject 172.32');
eq(api.p2pValidIp('8.8.8.8'), false, 'p2p ip reject public');
eq(api.p2pValidIp('999.1.1.1'), false, 'p2p ip reject 999');
eq(api.p2pValidIp(''), false, 'p2p ip reject empty');
eq(api.p2pValidIp('192.168.11.999'), false, 'p2p ip reject bad octet');
eq(api.p2pValidPort('1024'), true, 'p2p port valid');
eq(api.p2pValidPort('65535'), true, 'p2p port max');
eq(api.p2pValidPort('0'), false, 'p2p port reject 0');
eq(api.p2pValidPort('70000'), false, 'p2p port reject >65535');
eq(api.p2pValidPort('abc'), false, 'p2p port reject NaN');
eq(api.p2pStatusMeta({active:1, dest_ip:'192.168.11.175'}).label, '已开启 · 192.168.11.175', 'p2p status on label');
eq(api.p2pStatusMeta({active:0}).cls, ' is-custom', 'p2p status off cls');
eq(api.p2pStatusMeta(null).label, '已关闭', 'p2p status null label');

// ---------- 网络体检: 冲突矩阵 ----------
const A_OK = { sqm:{enabled:1, section_type:'queue', script:'simple.qos', qdisc:'cake', download:'900000', upload:'48000', cake_running:1, drop:0, overlimit:0},
  offload:{flow:0,hw:0}, p2p:{active:0, ip:'-'}, uplink_sample_kbps:40000, static_leases:'192.168.11.175 192.168.11.179', irqbalance:0 };
function confOf(a){ return api.auditConflicts(a).map(c=>c.level+':'+c.title); }
eq(api.auditConflicts(null).length, 0, 'audit null → empty');
eq(confOf(A_OK).length, 0, 'audit healthy env → no conflicts');
// SQM + offload 硬冲突
let a1 = JSON.parse(JSON.stringify(A_OK)); a1.offload.flow=1;
eq(confOf(a1).some(t=>t.startsWith('conflict:')&&t.includes('分载')), true, 'audit sqm+offload conflict');
// 旧结构
let a2 = JSON.parse(JSON.stringify(A_OK)); a2.sqm.section_type='sqm';
eq(confOf(a2).some(t=>t.includes('旧结构')), true, 'audit legacy section detected');
// 上行超售 (实测 > 整形值 5%)
let a3 = JSON.parse(JSON.stringify(A_OK)); a3.uplink_sample_kbps=78000;
eq(confOf(a3).some(t=>t.startsWith('warn:')&&t.includes('超售')), true, 'audit uplink oversubscription');
// 不够 5% 不报
let a4 = JSON.parse(JSON.stringify(A_OK)); a4.uplink_sample_kbps=50000;
eq(confOf(a4).some(t=>t.includes('超售')), false, 'audit uplink within 5% no warn');
// P2P 无静态租约
let a5 = JSON.parse(JSON.stringify(A_OK)); a5.p2p={active:1, ip:'192.168.11.200'};
eq(confOf(a5).some(t=>t.includes('静态租约')), true, 'audit p2p no lease warn');
// P2P 有租约不报
let a6 = JSON.parse(JSON.stringify(A_OK)); a6.p2p={active:1, ip:'192.168.11.175'};
eq(confOf(a6).some(t=>t.includes('静态租约')), false, 'audit p2p leased no warn');
// irqbalance
let a7 = JSON.parse(JSON.stringify(A_OK)); a7.irqbalance=1;
eq(confOf(a7).some(t=>t.includes('irqbalance')), true, 'audit irqbalance warn');
// 无 SQM 无分载 → info
let a8 = JSON.parse(JSON.stringify(A_OK)); a8.sqm.enabled=0;
eq(confOf(a8).some(t=>t.startsWith('info:')), true, 'audit bare info');

// ---------- 模式定义与推荐 ----------
eq(api.modeDefs().length, 4, 'modes count 4');
eq(api.modeDefs().map(m=>m.id).join(','), 'standard,p2p,throughput,latency', 'mode ids');
// P2P 在网 → p2p 排第一
let r1 = api.recommendModes(A_OK);
eq(r1[0].id, 'standard', 'healthy → standard first (p2p inactive)');
let r2 = api.recommendModes(a5);
eq(r2[0].id, 'p2p', 'p2p active → p2p first');
// SQM+offload 冲突 → standard 优先
let r3 = api.recommendModes(a1);
eq(r3.some(x=>x.id==='standard'&&x.why.includes('打架')), true, 'conflict → standard recommended');
// 超售 → latency
let r4 = api.recommendModes(a3);
eq(r4.some(x=>x.id==='latency'), true, 'oversubscription → latency recommended');

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
