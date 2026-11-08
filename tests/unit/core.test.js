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
const WANT = ['cpuRange', 'fullMask', 'parseCpuRange', 'parseSoftirq', 'maskLabel', 'maskToCpus', 'cpusToMask', 'getPresets', 'matchPreset', 'p2pValidIp', 'p2pValidPort', 'p2pStatusMeta', 'auditConflicts', 'modeDefs', 'buildPlan', 'depsMissing', 'installHint', 'modeScore', 'modeWhy', 'depLabels', 'tabStructure', 'parseIrqList', 'irqMaskOfCpu', 'deltaSoftirq', 'netdevParse', 'netdevDelta', 'speedTier', 'wiresPathH', 'wiresResample', 'seriesPush', 'niceCeil', 'seriesStatsMax', 'fmtBps', 'benchFromUci', 'parseTinStats', 'gameStatusMeta', 'buildDomainMap', 'classifyDomain', 'leaseSuggestions', 'dnsSummary', 'dnsObserverMeta', 'buildIpMap', 'classifyIp', 'buildPortMap', 'classifyPort'];
let extracted = '';
for (const name of WANT) {
  const m = new RegExp('function ' + name + '\\s*\\(', 'g').exec(SRC);
  if (!m) { console.error('FATAL: function %s not found in source', name); process.exit(2); }  // brace-match to find the end
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
  '; ({ cpuRange, fullMask, parseCpuRange, parseSoftirq, maskLabel, maskToCpus, cpusToMask, getPresets, matchPreset, p2pValidIp, p2pValidPort, p2pStatusMeta, auditConflicts, modeDefs, buildPlan, depsMissing, installHint, modeScore, modeWhy, depLabels, tabStructure, parseIrqList, irqMaskOfCpu, deltaSoftirq, netdevParse, netdevDelta, speedTier, wiresPathH, wiresResample, seriesPush, niceCeil, seriesStatsMax, fmtBps, benchFromUci, parseTinStats, gameStatusMeta, buildDomainMap, classifyDomain, leaseSuggestions, dnsSummary, dnsObserverMeta, buildIpMap, classifyIp, buildPortMap, classifyPort,' +
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
eq(TABS.length, 4, 'tabs: 4 个');
eq(TABS.map(t=>t.id).join(','), 'overview,smart,game,pro', 'tabs: 顺序 overview/smart/game/pro');
const allCards = TABS.reduce((a,t)=>a.concat(t.cards),[]);
const tabById = id => TABS.filter(t=>t.id===id)[0];
eq(allCards.length, new Set(allCards).size, 'tabs: 卡片归属无重复');
eq(TABS[0].cards.join(','), 'wires,health,traffic', 'tabs: 总览三卡');
eq(tabById('pro').cards.join(','), 'presets,ifaces,softirq,irq', 'tabs: 专家四卡');
eq(allCards.slice().sort().join(','), 'audit,game,health,ifaces,irq,p2p,presets,softirq,traffic,wires', 'tabs: 十卡全归组');
eq(TABS[1].cards.includes('audit') && TABS[1].cards.includes('p2p'), true, 'tabs: 智能优化含体检+P2P');
eq(tabById('pro').cards.includes('presets') && tabById('pro').cards.includes('ifaces'), true, 'tabs: 专家含预设+接口');
eq(tabById('pro').cards.includes('softirq') && tabById('pro').cards.includes('irq'), true, 'tabs: 专家含软中断+IRQ');
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

// benchFromUci: uci bench 节 → 基线对象 (数值化/缺节容错)
const boff = { '.type':'bench', '.name':'bench_off', mode:'off', latency_ms:'5.7', rx_bps:'106', tx_bps:'0', ts:'1793902007' };
const bon  = { '.type':'bench', '.name':'bench_on',  mode:'p2p', latency_ms:'5.1', rx_bps:'147', tx_bps:'0', ts:'1793902121' };
const bf = api.benchFromUci({ bench_off: boff, bench_on: bon });
eq(bf.off.latency_ms, 5.7, 'bench: latency 字符串数值化');
eq(bf.on.rx_bps, 147, 'bench: rx 数值化');
eq(bf.off.ts, 1793902007, 'bench: ts 数值化');
eq(bf.mode, null, 'bench: mode 恒 null (现读 status)');
// 缺一侧 → 另一侧仍在
const bf1 = api.benchFromUci({ bench_off: boff });
eq(bf1.off.latency_ms, 5.7, 'bench: 仅 off 侧');
eq(bf1.on, null, 'bench: on 侧 null');
// ts 缺失的节视为未建立
const bf2 = api.benchFromUci({ bench_off: { mode:'off', latency_ms:'5', ts:'' }, bench_on: bon });
eq(bf2.off, null, 'bench: 无 ts 视为未建立');
eq(bf2.on.ts, 1793902121, 'bench: on 侧仍有效');
// 全缺 → null
eq(api.benchFromUci({}), null, 'bench: 空配置 → null');
eq(api.benchFromUci(null), null, 'bench: null 配置 → null');
// 非法数字 → 0
const bf3 = api.benchFromUci({ bench_off: { mode:'off', latency_ms:'abc', rx_bps:'x', ts:'123' } });
eq(bf3.off.latency_ms, 0, 'bench: 非法数字守卫 → 0');
eq(bf3.off.rx_bps, 0, 'bench: 非法 rx → 0');

// ---- 游戏通道: parseTinStats / gameStatusMeta ----
// fixture: 真机 diffserv3 列式输出 (R5C pppoe-wan, 2026-11-08 采集)
const TC_UP_D3 = [
'qdisc cake 8141: root refcnt 2 bandwidth 48Mbit diffserv3 triple-isolate nonat nowash no-ack-filter split-gso rtt 100ms raw overhead 0 ',
' Sent 1177733192115 bytes 1526053036 pkt (dropped 203213445, overlimits 2045634877 requeues 0) ',
'',
'                   Bulk  Best Effort        Voice',
'  thresh          3Mbit       48Mbit       12Mbit',
'  target         6.05ms          5ms          5ms',
'  pkts         97761226   1440158011    191348939',
'  bytes     50148570374 1216786722663 146818242974',
'  drops         7701496    195504292         7657',
'  marks               0         1102            0',
''].join('\n');
// fixture: diffserv4 (启用游戏通道后的目标形态, Video 列在 Best Effort 与 Voice 之间)
const TC_UP_D4 = [
'qdisc cake 9001: root refcnt 2 bandwidth 48Mbit diffserv4 triple-isolate nonat nowash ack-filter split-gso rtt 100ms raw overhead 0 ',
'',
'                   Bulk  Best Effort        Video        Voice',
'  thresh          3Mbit       48Mbit       36Mbit       12Mbit',
'  pkts         97761226   1440158011      8346194    191348939',
'  bytes     50148570374 1216786722663   11234887204 146818242974',
'  drops         7701496    195504292         10204         7657',
'  marks               0         1102              0            0',
''].join('\n');

let t3 = api.parseTinStats(TC_UP_D3);
eq(t3 && t3.mode, 'diffserv3', 'tin: 模式识别 diffserv3');
eq(t3 && t3.bandwidth, '48Mbit', 'tin: 带宽识别');
eq(t3 && Object.keys(t3.tins).length, 3, 'tin: diffserv3 三桶');
eq(t3 && t3.tins.bulk.pkts, '97761226', 'tin: bulk pkts 按列切片');
eq(t3 && t3.tins.best_effort.pkts, '1440158011', 'tin: best_effort pkts');
eq(t3 && t3.tins.voice.drops, '7657', 'tin: voice drops');
eq(t3 && t3.tins.bulk.marks, '0', 'tin: marks 列不错位');

let t4 = api.parseTinStats(TC_UP_D4);
eq(t4 && t4.mode, 'diffserv4', 'tin: 模式识别 diffserv4');
eq(t4 && Object.keys(t4.tins).length, 4, 'tin: diffserv4 四桶');
eq(t4 && t4.tins.video.pkts, '8346194', 'tin: video pkts (游戏桶)');
eq(t4 && t4.tins.video.bytes, '11234887204', 'tin: video bytes');
eq(t4 && t4.tins.video.drops, '10204', 'tin: video drops');
eq(t4 && t4.tins.voice.pkts, '191348939', 'tin: video 插列后 voice 不错位');
eq(t4 && t4.tins.bulk.thresh, '3Mbit', 'tin: thresh 行解析');

// besteffort (下行默认形态): 无分桶表头 → tins:null
eq(api.parseTinStats('qdisc cake 8142: root bandwidth 900Mbit besteffort triple-isolate\n Sent 1 bytes 2 pkt\n').tins, null, 'tin: besteffort → tins null');
// 非 cake 输出 → null
eq(api.parseTinStats('qdisc fq_codel 123: root\n'), null, 'tin: 非 cake → null');
eq(api.parseTinStats(''), null, 'tin: 空输入 → null');
eq(api.parseTinStats(null), null, 'tin: null 输入 → null');

// gameStatusMeta 五态状态机
eq(api.gameStatusMeta(null).state, 'unknown', 'game meta: 未知');
eq(api.gameStatusMeta({enabled:0, active:0}).state, 'off', 'game meta: 关闭');
eq(api.gameStatusMeta({enabled:0, active:1}).state, 'stale', 'game meta: 残留规则');
eq(api.gameStatusMeta({enabled:1, active:0}).state, 'missing', 'game meta: 标记缺失');
eq(api.gameStatusMeta({enabled:1, active:1, sqm_enabled:0}).state, 'no_sqm', 'game meta: SQM 停 → 降级');
eq(api.gameStatusMeta({enabled:1, active:1, sqm_enabled:1, cake_up:'diffserv3'}).state, 'degraded', 'game meta: 整形未切 → 降级');
eq(api.gameStatusMeta({enabled:1, active:1, sqm_enabled:1, cake_up:'diffserv4', device:'192.168.11.101'}).state, 'on', 'game meta: 全链路就绪');
eq(api.gameStatusMeta({enabled:1, active:1, sqm_enabled:1, cake_up:'diffserv4', device:'192.168.11.101'}).label, '优先中 · 192.168.11.101', 'game meta: on 徽标文案');

// tabStructure: 游戏通道 tab 归位
const TS = api.tabStructure();
eq(TS.length, 4, 'tabs: 四分组');
const gtab = TS.filter(function(t) { return t.id === 'game'; })[0];
eq(!!gtab, true, 'tabs: game tab 存在');
eq(gtab && gtab.cards.join(','), 'game', 'tabs: game 卡归类唯一');
eq(TS.filter(function(t) { return t.id === 'smart'; })[0].cards.indexOf('game'), -1, 'tabs: game 不在 smart 组');

// ---- v1.13 防回归: ACL 与 fs.exec 一致性 (rpcd 403 病根) ----
{
  const aclPath = path.join(__dirname, '..', '..', 'files', 'usr', 'share', 'rpcd', 'acl.d', 'luci-app-netsteer.json');
  const acl = JSON.parse(fs.readFileSync(aclPath, 'utf8'));
  const allowed = Object.keys(((acl['luci-app-netsteer'] || {}).write || {}).file || {});
  eq(allowed.length >= 8, true, 'acl: write.file 条目数 ' + allowed.length);
  const re = /fs\.exec\('([^']+)'/g;
  let m, execed = 0, miss = 0;
  while ((m = re.exec(SRC))) {
    execed++;
    if (allowed.indexOf(m[1]) < 0) { miss++; console.error('ACL 缺失 exec 白名单:', m[1]); }
  }
  eq(execed >= 8, true, 'acl: 源码 fs.exec 目标数 ' + execed);
  eq(miss, 0, 'acl: 每个 fs.exec 目标都在 ACL 白名单 (防 403)');
  // 交付文件存在 (防 v1.8/v1.9 缺新文件复发)
  const must = [
    ['files/usr/bin/netsteer-qos', 'netsteer-qos 主脚本'],
    ['files/usr/lib/sqm/netsteer-gaming.qos', 'sqm gaming 包装脚本'],
    ['files/etc/init.d/netsteer', 'init.d'],
    ['files/etc/hotplug.d/iface/99-netsteer', 'hotplug 自愈'],
    ['files/usr/share/rpcd/acl.d/luci-app-netsteer.json', 'ACL'],
  ];
  must.forEach(function(p) {
    eq(fs.existsSync(path.join(__dirname, '..', '..', p[0])), true, 'ship: ' + p[1] + ' 在包内');
  });
}

// ---- v1.14: L1 DNS 分类纯函数 ----
{
  // buildDomainMap: 真实数据集解析 + 边界
  const dsPath = path.join(__dirname, '..', '..', 'files', 'usr', 'share', 'netsteer', 'gamedomains.txt');
  const dsText = fs.readFileSync(dsPath, 'utf8');
  const map = api.buildDomainMap(dsText);
  const keys = Object.keys(map);
  eq(keys.length >= 80, true, 'domap: 真实数据集 ≥80 后缀 (实测 ' + keys.length + ')');
  eq(!!keys.length && keys.every(function(k) { return map[k] && !/\s/.test(k); }), true, 'domap: 全部条目 类别非空/后缀无空白');
  eq(Object.keys(api.buildDomainMap('')).length, 0, 'domap: 空文本 → 空表');
  const mini = api.buildDomainMap('# 注释\nsteam\tsteamcontent.com\nepic\tcdn1.epicgames.com\n\nxbox   xboxlive.com\n');
  eq(Object.keys(mini).length, 3, 'domap: tab/空格分隔+注释+空行');
  eq(mini['steamcontent.com'], 'steam', 'domap: tab 行解析');
  eq(mini['xboxlive.com'], 'xbox', 'domap: 空格行解析');

  // classifyDomain: 最长后缀 + 边界
  eq(api.classifyDomain('cdn.steampowered.com.localhost', {}), null, 'cls: 未命中 null');
  eq(api.classifyDomain('lancache.steamcontent.com', map), 'steam', 'cls: steam 命中');
  eq(api.classifyDomain('A.CDN1.EPICGAMES.COM.', map), 'epic', 'cls: 大小写+尾点归一');
  eq(api.classifyDomain('example.com', map), null, 'cls: 普通域不误报');
  eq(api.classifyDomain(null, map), null, 'cls: null 输入');
  eq(api.classifyDomain('steamcontent.com', map), 'steam', 'cls: 精确等于后缀');
  // 最长后缀: map 里 a.b → X, b → Y 时 x.a.b 应得 X (更具体)
  const lm = api.buildDomainMap('xlong\ta.b\nylong\tb\n');
  eq(api.classifyDomain('x.a.b', lm), 'xlong', 'cls: 更长后缀优先');

  // leaseSuggestions: dhcp.leases 文本启发式
  const leases = '# duid 00:03:00:01:aa\n1728800000 aa:bb 192.168.11.50 PS5 01:xx\n1728800000 cc:dd 192.168.11.51 Xbox-Series-X -\n1728800000 ee:ff 192.168.11.52 * -\n1728800000 11:22 192.168.11.53 DESKTOP-ABC -\n';
  const sug = api.leaseSuggestions(leases);
  eq(sug.length, 2, 'lease: 只命中游戏主机 (' + JSON.stringify(sug) + ')');
  eq(sug[0] && sug[0].ip, '192.168.11.50', 'lease: PS5 ip 列取第3列');
  eq(sug[1] && sug[1].name, 'Xbox-Series-X', 'lease: 大小写不敏感匹配');
  eq(api.leaseSuggestions('').length, 0, 'lease: 空文本 → []');

  // dnsSummary: 过滤 + 计数 + last 截断
  const recs = [
    { q: 'lancache.steamcontent.com', c: '192.168.11.50' },
    { q: 'cdn1.epicgames.com', c: '192.168.11.50' },
    { q: 'www.baidu.com', c: '192.168.11.50' },
    { q: 'xboxlive.com', c: '192.168.11.99' },
    null
  ];
  const s1 = api.dnsSummary(recs, map, '192.168.11.50');
  eq(s1.total, 3, 'dnssum: 只统计目标设备');
  eq(s1.hit, 2, 'dnssum: 命中平台 2 条');
  eq(s1.platforms.steam, 1, 'dnssum: steam 计数 1');
  eq(s1.platforms.epic, 1, 'dnssum: epic 计数 1');
  eq(s1.platforms.xbox, undefined, 'dnssum: 其他设备查询不入账');
  eq(s1.last.length, 3, 'dnssum: last 含未命中记录 (cat="")');
  const s2 = api.dnsSummary(recs, map, '-');
  eq(s2.total, 4, 'dnssum: device=- 不过滤');
  const many = []; for (let i = 0; i < 20; i++) many.push({ q: 'a.steamcontent.com', c: '1.2.3.4' });
  eq(api.dnsSummary(many, map, '1.2.3.4').last.length, 8, 'dnssum: last 上限 8');
  eq(api.dnsSummary(null, map, '-').total, 0, 'dnssum: null 记录安全');
}

{
  // dnsObserverMeta: 环境自适应四态 (通用化核心 — 不同家庭自动选观测面)
  const m1 = api.dnsObserverMeta({ dns_observer: 'mihomo' });
  eq(m1.state, 'mihomo', 'obs: mihomo 态');
  eq(m1.btn, null, 'obs: mihomo 无动作按钮');
  eq(m1.badge.length > 0, true, 'obs: mihomo 徽标非空');
  const m2 = api.dnsObserverMeta({ dns_observer: 'dnsmasq' });
  eq(m2.state, 'dnsmasq', 'obs: dnsmasq 态 (日志已开)');
  eq(m2.btn, 'off', 'obs: dnsmasq 给关闭按钮');
  const m3 = api.dnsObserverMeta({ dns_observer: 'dnsmasq_off' });
  eq(m3.state, 'dnsmasq_off', 'obs: dnsmasq_off 态 (裸路由器未开日志)');
  eq(m3.btn, 'on', 'obs: dnsmasq_off 给开启按钮');
  const m4 = api.dnsObserverMeta({ dns_observer: 'none' });
  eq(m4.state, 'none', 'obs: none 态');
  eq(m4.btn, null, 'obs: none 无动作');
  const m5 = api.dnsObserverMeta({});
  eq(m5.state, 'mihomo', 'obs: 缺省回退 mihomo (向后兼容旧 status)');
  const m6 = api.dnsObserverMeta(null);
  eq(m6.state, 'mihomo', 'obs: null 安全');
  eq(m3.desc.length > 10 && m4.desc.length > 10, true, 'obs: 各态说明文案齐全');
}

{
  // L2: IP 段 + 端口启发式 (纯数据文件, 裸 IP 直连盲区)
  const ipTxt = '# comment\nsteam\t155.133.0.0/16\nsteam\t185.25.180.0/22\nconsole\t117.185.19.0/24 # relay\n';
  const ipm = api.buildIpMap(ipTxt);
  eq(ipm.length, 3, 'ipmap: 3 条有效 (注释剔除)');
  eq(ipm[0].cat, 'steam', 'ipmap: 类别解析');
  eq(ipm[0].bits, 16, 'ipmap: 前缀位解析');
  eq(api.classifyIp('155.133.248.36', ipm), 'steam', 'ipmatch: /16 命中 (SDR relay)');
  eq(api.classifyIp('117.185.19.5', ipm), 'console', 'ipmatch: /24 长前缀优先');
  eq(api.classifyIp('117.185.20.5', ipm), null, 'ipmatch: 相邻段不误命中');
  eq(api.classifyIp('8.8.8.8', ipm), null, 'ipmatch: 未命中 null');
  eq(api.classifyIp('999.1.1.1', ipm), null, 'ipmatch: 非法 IP 安全');
  eq(api.classifyIp('', null), null, 'ipmap: 空表安全');
  eq(api.buildIpMap('steam\t2001:db8::/32\nbad-line\nsteam\t10.0.0.0/8').length, 1, 'ipmap: IPv6/坏行跳过');
  const pm = api.buildPortMap('# c\nconsole\t3074-3074/udp\nsteam\t27015-27050/udp\npsn\t3480-3480/tcp\n');
  eq(pm.length, 3, 'pmap: 3 条有效');
  eq(api.classifyPort('3074', 'udp', pm), 'console', 'portmatch: Xbox NAT 端口');
  eq(api.classifyPort('27050', 'udp', pm), 'steam', 'portmatch: 范围上界含');
  eq(api.classifyPort('3480', 'tcp', pm), 'psn', 'portmatch: PSN 端口');
  eq(api.classifyPort('3480', 'udp', pm), null, 'portmatch: 协议不符不命中');
  eq(api.classifyPort('80', 'tcp', pm), null, 'portmatch: 未命中 null');
  eq(api.classifyPort('abc', 'tcp', pm), null, 'portmatch: 非法端口安全');
  eq(api.classifyPort('', '', []), null, 'pmap: 空表安全');

  // dnsSummary 三级识别链
  const dmap = api.buildDomainMap('steam\tsteamcontent.com\n');
  const recs3 = [
    { q: 'a.steamcontent.com', c: '1.1.1.1' },                          // name 命中
    { q: '', d: '155.133.248.36', p: '27015', t: 'udp', c: '1.1.1.1' }, // 裸 IP: ip 命中
    { q: '', d: '23.45.1.1', p: '3074', t: 'udp', c: '1.1.1.1' },       // 裸 IP 未命中 → port 命中 console
    { q: '', d: '23.45.1.1', p: '80', t: 'tcp', c: '1.1.1.1' },         // 全未命中
    { q: 'x.example.com', c: '1.1.1.1' }                                // name 未命中 (无 d/p)
  ];
  const s3 = api.dnsSummary(recs3, dmap, '-', ipm, pm);
  eq(s3.total, 5, 'dnssum L2: total 含裸 IP 记录');
  eq(s3.platforms.steam, 2, 'dnssum L2: steam 2 次 (name+ip)');
  eq(s3.platforms.console, 1, 'dnssum L2: console 1 次 (port)');
  eq(s3.last[0].src, 'name', 'dnssum L2: 来源 name');
  eq(s3.last[1].src, 'ip', 'dnssum L2: 来源 ip');
  eq(s3.last[2].src, 'port', 'dnssum L2: 来源 port');
  eq(s3.last[1].q, '→155.133.248.36:27015', 'dnssum L2: 裸 IP 显示 →dst:port');
  const sOld = api.dnsSummary([{ q: 'a.steamcontent.com', c: 'x' }], dmap, '-');
  eq(sOld.total, 1, 'dnssum L2: 不传 ipmap/pmap 向后兼容 (total)');
  eq(sOld.platforms.steam, 1, 'dnssum L2: 不传 ipmap/pmap 向后兼容 (域名命中)');
}

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
