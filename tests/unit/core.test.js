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
const WANT = ['cpuRange', 'fullMask', 'parseCpuRange', 'parseSoftirq', 'maskLabel', 'maskToCpus', 'cpusToMask', 'getPresets', 'matchPreset', 'p2pValidIp', 'p2pValidPort', 'p2pStatusMeta', 'auditConflicts', 'modeDefs', 'buildPlan', 'depsMissing', 'installHint', 'modeScore', 'modeWhy', 'depLabels', 'tabStructure', 'parseIrqList', 'irqMaskOfCpu', 'deltaSoftirq', 'netdevParse', 'netdevDelta', 'speedTier', 'wiresPathH', 'wiresResample', 'seriesPush', 'niceCeil', 'seriesStatsMax', 'fmtBps'];
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
  '; ({ cpuRange, fullMask, parseCpuRange, parseSoftirq, maskLabel, maskToCpus, cpusToMask, getPresets, matchPreset, p2pValidIp, p2pValidPort, p2pStatusMeta, auditConflicts, modeDefs, buildPlan, depsMissing, installHint, modeScore, modeWhy, depLabels, tabStructure, parseIrqList, irqMaskOfCpu, deltaSoftirq, netdevParse, netdevDelta, speedTier, wiresPathH, wiresResample, seriesPush, niceCeil, seriesStatsMax, fmtBps,' +
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

// ---------- IRQ 亲和 + 对比增量 ----------
eq(api.parseIrqList('[{"irq":"104","dev":"eth0","affinity":"8","counts":"123"}]').length, 1, 'parseIrqList 1 行');
eq(api.parseIrqList('[{"irq":"104","dev":"eth0","affinity":"8"},{}]').length, 1, 'parseIrqList 坏行丢弃');
eq(api.parseIrqList('not json').length, 0, 'parseIrqList 非 JSON → []');
eq(api.parseIrqList('').length, 0, 'parseIrqList 空 → []');
eq(api.irqMaskOfCpu(0), '1', 'mask cpu0=1');
eq(api.irqMaskOfCpu(3), '8', 'mask cpu3=8');
// deltaSoftirq: 基线 rx=[100,0,0,0], 现 rx=[100,50,0,0] → Δ=[0,50,0,0] 集中100% CPU1
const SB1 = '            NET_RX:  100 0 0 0\n            NET_TX:  0 10 0 0';
const SC1 = '            NET_RX:  100 50 0 0\n            NET_TX:  0 15 0 0';
let dd = api.deltaSoftirq(SB1, SC1);
eq(dd.total, 50, 'delta total=50');
eq(dd.rxConc, 100, 'delta 全部新包在 CPU1');
eq(dd.concCpu, 1, 'delta concCpu=1');
eq(dd.tx[1], 5, 'delta tx[1]=5');
// 零流量窗口
let dz = api.deltaSoftirq(SC1, SC1);
eq(dz.total, 0, 'delta 无新包 → 0');
eq(dz.rxConc, null, 'delta 无新包 → conc null');
// 计数回绕保护 (负值钳 0)
let dn = api.deltaSoftirq(SC1, SB1);
eq(dn.total, 0, 'delta 负增量钳 0');

// ---------- v2 引擎: 采样/路径/时序 ----------
const ND = '  eth0: 1000000000 100 0 0 0 0 0 0 500000000\n  eth1: 2000000000 200 0 0 0 0 0 0 800000000\n    lo: 1 1 0 0 0 0 0 0 1';
let nd = api.netdevParse(ND);
eq(nd.eth0.rx, 1000000000, 'netdevParse rx');
eq(nd.eth1.tx, 800000000, 'netdevParse tx');
eq(nd.eth0.tx, 500000000, 'netdevParse tx eth0');
eq(nd.lo ? 1 : 0, 1, 'netdevParse lo 也在 (可过滤)');
let dd1 = api.netdevDelta(nd, api.netdevParse('  eth0: 1008000000 100 0 0 0 0 0 0 500500000'), 5000);
eq(Math.round(dd1.eth0.rx_bps), Math.round(8000000*8/5), 'netdevDelta 1MB/5s bps');
let dback = api.netdevDelta(api.netdevParse('  eth0: 9999999999 1 0 0 0 0 0 0 1'), api.netdevParse('  eth0: 100 1 0 0 0 0 0 0 1'), 5000);
eq(dback.eth0, null, 'netdevDelta 回绕 → null');
eq(api.speedTier(null), 0, 'speedTier null=0');
eq(api.speedTier(1e5), 0, 'speedTier 100k=0');
eq(api.speedTier(10e6), 1, 'speedTier 10M=1');
eq(api.speedTier(200e6), 2, 'speedTier 200M=2');
let wp = api.wiresPathH(100, 60, 200, 60);
eq(wp.length, 25, 'wiresPathH 25 点');
eq(wp[0][1], 60, 'wiresPathH 起点同高');
let wr = api.wiresResample(wp, 16);
eq(wr.len > 90, true, 'wiresResample 长度合理');
eq(wr.pts.every(p => p.length === 3), true, 'wiresResample 点含角度');
let sp = [];
sp = api.seriesPush(sp, [1000, 5], 60000, 90);
sp = api.seriesPush(sp, [2000, 7], 60000, 90);
sp = api.seriesPush(sp, [1500, 6], 60000, 90);  // 乱序拒绝
eq(sp.length, 2, 'seriesPush 乱序不入');
eq(sp[1][1], 7, 'seriesPush 值正确');
sp = api.seriesPush(sp, [99000, 9], 60000, 90);
eq(sp.length, 1, 'seriesPush 窗口裁剪');
eq(api.niceCeil(3700000), 4000000, 'niceCeil 3.7M→4M');
eq(api.niceCeil(2.4e6), 2.5e6, 'niceCeil 2.4M→2.5M');
eq(api.niceCeil(-1), 1, 'niceCeil 负→1');
eq(api.seriesStatsMax([[1,5],[2,null],[3,9]]), 9, 'seriesStatsMax 忽略 null');
eq(api.fmtBps(null), '—', 'fmtBps null');
eq(api.fmtBps(1.5e6), '1.5 Mbit/s', 'fmtBps M');
eq(api.fmtBps(2.3e9), '2.3 Gbit/s', 'fmtBps G');

// ---------- Tab 结构 ----------
const TABS = api.tabStructure();
eq(TABS.length, 3, 'tabs: 3 个');
eq(TABS.map(t=>t.id).join(','), 'overview,smart,pro', 'tabs: 顺序 overview/smart/pro');
const allCards = TABS.reduce((a,t)=>a.concat(t.cards),[]);
eq(allCards.length, new Set(allCards).size, 'tabs: 卡片归属无重复');
eq(TABS[0].cards.join(','), 'wires,health,traffic', 'tabs: 总览三卡');
eq(TABS[2].cards.join(','), 'presets,ifaces,softirq,irq', 'tabs: 专家四卡');
eq(allCards.slice().sort().join(','), 'audit,health,ifaces,irq,p2p,presets,softirq,traffic,wires', 'tabs: 九卡全归组');
eq(TABS[1].cards.includes('audit') && TABS[1].cards.includes('p2p'), true, 'tabs: 智能优化含体检+P2P');
eq(TABS[2].cards.includes('presets') && TABS[2].cards.includes('ifaces'), true, 'tabs: 专家含预设+接口');
eq(TABS[2].cards.includes('softirq') && TABS[2].cards.includes('irq'), true, 'tabs: 专家含软中断+IRQ');
TABS.forEach(t => eq(typeof t.hint === 'string' && t.hint.length > 6, true, 'tabs: '+t.id+' hint 非空'));

// ---------- 依赖矩阵四态 ----------
const FULL = { deps: {sqm_scripts:1, sqm_luci:1, kmod_cake:1, tc:1, nft:1, feed_luci:1, feed_packages:1, feed_kmods:1},
  sqm:{enabled:1, section_type:'queue', script:'simple.qos', qdisc:'cake', download:'900000', upload:'48000', cake_running:1, drop:0, overlimit:0},
  offload:{flow:0,hw:0}, p2p:{active:0, ip:'-'}, uplink_sample_kbps:48000, static_leases:'192.168.11.175', irqbalance:0 };
function clone(a){ return JSON.parse(JSON.stringify(a)); }
function modeIds(plan){ return plan.now.candidates.map(c=>c.m.id); }

// 态1 全依赖: now=standard best + p2p/throughput/steering 候选, full=null
let p1 = api.buildPlan(FULL);
eq(p1.now.best.id, 'standard', 'full-deps: best=standard');
eq(p1.now.candidates.length, 4, 'full-deps: 4 candidates');
eq(p1.full, null, 'full-deps: full tier empty');
eq(api.modeDefs().length, 5, '5 modes defined');

// 态2 无 SQM (最小系统): standard/p2p/latency 进 full, now=steering/throughput
let m2 = clone(FULL); m2.deps = {tc:1, nft:1}; m2.sqm.enabled=0; m2.sqm.cake_running=0;
let p2 = api.buildPlan(m2);
eq(p2.now.best.id, 'throughput', 'no-sqm: best=throughput (offload zero-dep, higher value than steering)');
eq(modeIds(p2).includes('steering'), true, 'no-sqm: steering in candidates');
eq(p2.full.best.id, 'standard', 'no-sqm: full best=standard');
eq(p2.full.missing.join(','), 'sqm_scripts,kmod_cake', 'no-sqm: missing list');
eq(p2.full.hint.cmd, 'apk update && apk add sqm-scripts kmod-sch-cake', 'no-sqm: install cmd');

// 态2b 无 SQM + 无源: hint 带 feed 提示
let m2b = clone(m2); m2b.deps.feed_packages=0; m2b.deps.feed_kmods=0;
let p2b = api.buildPlan(m2b);
eq(p2b.full.hint.note.includes('软件源'), true, 'no-feed: hint mentions feeds');

// 态3 有 sqm-scripts 无 cake 模块: 只 standard/p2p/latency 里的 cake 依赖失败
let m3 = clone(FULL); m3.deps.kmod_cake=0;
let p3 = api.buildPlan(m3);
eq(p3.full.best.id, 'standard', 'no-cake-mod: full best=standard');
eq(p3.full.missing.join(','), 'kmod_cake', 'no-cake-mod: missing=kmod_cake');
eq(p3.now.best.id, 'throughput', 'no-cake-mod: now best=throughput');

// 态4 P2P 在网 → p2p 升为 now best
let m4 = clone(FULL); m4.p2p = {active:1, ip:'192.168.11.175'};
let p4 = api.buildPlan(m4);
eq(p4.now.best.id, 'p2p', 'p2p-active: best=p2p');
eq(p4.now.why.includes('192.168.11.175'), true, 'p2p-active: why mentions ip');

// 态5 超售 → latency 升 now best
let m5 = clone(FULL); m5.uplink_sample_kbps = 78000;
let p5 = api.buildPlan(m5);
eq(p5.now.best.id, 'latency', 'oversell: best=latency');

// 态6 SQM+offload 打架 → standard best 且 why 提打架
let m6 = clone(FULL); m6.offload.flow=1;
let p6 = api.buildPlan(m6);
eq(p6.now.best.id, 'standard', 'conflict: best=standard');
eq(p6.now.why.includes('打架'), true, 'conflict: why explains');

// ---------- 依赖缺失差异化冲突检测 ----------
// 无 sqm_scripts 时: 不报"无SQM无分载"以外的 sqm 配置类冲突; 报 info 引导
let c2 = api.auditConflicts(m2);
eq(c2.some(c=>c.title.includes('未安装') || c.title.includes('软路径')), true, 'no-sqm: guidance info present');
eq(c2.some(c=>c.detail && c.detail.includes('cake 在跑')), false, 'no-sqm: no legacy-struct conflict');
// sqm_scripts 有 + sqm_luci 缺 → info LuCI 页缺失
let m7 = clone(FULL); m7.deps.sqm_luci=0;
let c7 = api.auditConflicts(m7);
eq(c7.some(c=>c.title.includes('LuCI SQM 管理页未安装')), true, 'no-luci-page: info present');
// depsMissing/installHint 纯函数
eq(api.depsMissing({id:'x',requires:['sqm_scripts','kmod_cake']}, m2).length, 2, 'depsMissing counts');
eq(api.depsMissing({id:'x',requires:[]}, m2).length, 0, 'depsMissing zero-req');
eq(api.depsMissing({id:'x',requires:['tc']}, m2).length, 0, 'depsMissing satisfied');
let h = api.installHint(['kmod_cake'], clone(FULL));
eq(h.cmd, 'apk update && apk add kmod-sch-cake', 'installHint single');
let h2 = api.installHint(['kmod_cake','sqm_scripts'], m2b);
eq(h2.note.includes('kmods'), true, 'installHint feed note names missing feed');

// modeScore 排序稳定性: throughput 在无 sqm 时排名高于 steering
let sc1 = api.modeScore({id:'throughput'}, m2), sc2 = api.modeScore({id:'steering'}, m2);
eq(sc1 < sc2, true, 'score: throughput < steering when no sqm');

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
