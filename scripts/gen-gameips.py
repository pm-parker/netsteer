#!/usr/bin/env python3
"""生成 netsteer L2 数据文件: gameips.txt (Steam 平台 IP 段)
来源: Valve 官方公开 SDR API (GetSDRConfig, appid=730) 实拉 relay IP + AS32590 共识段。
"""
import collections
import datetime
import json
import os
import subprocess

# (a, b, c, prefix) — Valve AS32590 共识段
CORE_NETS = [
    (155, 133, 0, 16), (162, 254, 0, 16), (185, 25, 180, 22), (103, 10, 124, 23),
    (103, 28, 52, 22), (146, 66, 152, 21),
]

def ip2int(s):
    a, b, c, d = (int(x) for x in s.split('.'))
    return (a << 24) | (b << 16) | (c << 8) | d

def in_core(ip):
    try:
        n = ip2int(ip)
    except ValueError:
        return False  # 非法 IP 视为不在核心段, 让它走 /24 聚合路径暴露在产物里
    for a, b, c, pre in CORE_NETS:
        base = ip2int(f'{a}.{b}.{c}.0')
        mask = (0xffffffff << (32 - pre)) & 0xffffffff
        if (n & mask) == (base & mask):
            return True
    return False

try:
    raw = subprocess.run(['curl', '-s', '--max-time', '20',
        'https://api.steampowered.com/ISteamApps/GetSDRConfig/v1?appid=730'],
        capture_output=True, text=True, timeout=30).stdout
except subprocess.SubprocessError as e:
    raise SystemExit(f'ERROR: SDR API request failed: {e}') from e
if not raw.strip():
    raise SystemExit('ERROR: SDR API returned empty body')
try:
    d = json.loads(raw)
except json.JSONDecodeError as e:
    raise SystemExit(f'ERROR: SDR API returned invalid JSON: {e}') from e
if not isinstance(d.get('pops'), dict):
    raise SystemExit('ERROR: SDR API response missing pops dict')
relays = []
for info in d['pops'].values():
    for r in info.get('relays', []):
        if 'ipv4' in r and not in_core(r['ipv4']):
            relays.append(r['ipv4'])

groups = collections.defaultdict(list)
for ip in relays:
    groups['.'.join(ip.split('.')[:3])].append(ip)

lines = [
    '# netsteer L2: game platform IP segments (category TAB CIDR, IPv4)',
    f'# source: Valve official SDR API (ISteamApps/GetSDRConfig appid=730) pulled {datetime.date.today().isoformat()}',
    '# + Valve AS32590 consensus blocks; /24 aggregates for partner POPs (e.g. CN relays)',
    '# matching: longest-prefix wins; covers bare-IP direct traffic (no SNI/DNS name)',
    f"# revision: {d.get('revision', '-')}",
]
for a, b, c, pre in CORE_NETS:
    c_out = 0 if pre == 16 else c
    lines.append(f'steam\t{a}.{b}.{c_out}.0/{pre}')
for g, ips in sorted(groups.items()):
    top2 = ','.join(sorted(ips)[:2])
    lines.append(f'steam\t{g}.0/24\t# {len(ips)} relays ({top2})')
out = '\n'.join(lines) + '\n'
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   'files', 'usr', 'share', 'netsteer', 'gameips.txt')
try:
    with open(OUT, 'w') as f:
        f.write(out)
except OSError as e:
    raise SystemExit(f'ERROR: cannot write {OUT}: {e}') from e
covered = len(relays)  # relays 已在收集时排除核心段覆盖的 IP
print(f'核心段 {len(CORE_NETS)} 行 + 合作 POP /24 {len(groups)} 行 | 剩余 relay 全覆盖 {covered} 个')
