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
const WANT = ['cpuRange', 'fullMask', 'parseCpuRange', 'parseSoftirq', 'maskLabel', 'maskToCpus', 'cpusToMask', 'getPresets', 'matchPreset'];
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
  '; ({ cpuRange, fullMask, parseCpuRange, parseSoftirq, maskLabel, maskToCpus, cpusToMask, getPresets, matchPreset,' +
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

console.log(`PASS=${pass} FAIL=${fail}`);
process.exit(fail ? 1 : 0);
