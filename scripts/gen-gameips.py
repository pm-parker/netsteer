#!/usr/bin/env python3
"""生成 netsteer L2 数据文件: gameips.txt (Steam 平台 IP 段)
来源: Valve 官方公开 SDR API (GetSDRConfig, appid=730) 实拉 relay IP + AS32590 共识段。
"""
import json, subprocess, collections, datetime

# (a, b, c, prefix) — Valve AS32590 共识段
CORE_NETS = [
    (155, 133, 0, 16), (162, 254, 0, 16), (185, 25, 180, 22), (103, 10, 124, 23),
    (103, 28, 52, 22), (146, 66, 152, 21),
]

def ip2int(s):
    a, b, c, d = (int(x) for x in s.split('.'))
    return (a << 24) | (b << 16) | (c << 8) | d

def in_core(ip):
    n = ip2int(ip)
    for a, b, c, pre in CORE_NETS:
        base = ip2int('%d.%d.%d.0' % (a, b, c))
        mask = (0xffffffff << (32 - pre)) & 0xffffffff
        if (n & mask) == (base & mask):
            return True
    return False

raw = subprocess.run(['curl', '-s', '--max-time', '20',
    'https://api.steampowered.com/ISteamApps/GetSDRConfig/v1?appid=730'],
    capture_output=True, text=True, timeout=30).stdout
d = json.loads(raw)
relays = []
for pop, info in d['pops'].items():
    for r in info.get('relays', []):
        if 'ipv4' in r and not in_core(r['ipv4']):
            relays.append(r['ipv4'])

groups = collections.defaultdict(list)
for ip in relays:
    groups['.'.join(ip.split('.')[:3])].append(ip)

lines = [
    '# netsteer L2: game platform IP segments (category TAB CIDR, IPv4)',
    '# source: Valve official SDR API (ISteamApps/GetSDRConfig appid=730) pulled %s' % datetime.date.today().isoformat(),
    '# + Valve AS32590 consensus blocks; /24 aggregates for partner POPs (e.g. CN relays)',
    '# matching: longest-prefix wins; covers bare-IP direct traffic (no SNI/DNS name)',
    '# revision: %s' % d.get('revision', '-'),
]
for a, b, c, pre in CORE_NETS:
    c_out = 0 if pre == 16 else c
    lines.append('steam\t%d.%d.%d.0/%d' % (a, b, c_out, pre))
for g, ips in sorted(groups.items()):
    lines.append('steam\t%s.0/24\t# %d relays (%s)' % (g, len(ips), ','.join(sorted(ips)[:2])))
out = '\n'.join(lines) + '\n'
open('/home/abc/.hermes/workspace/netsteer/files/usr/share/netsteer/gameips.txt', 'w').write(out)
covered = len(relays) + sum(1 for ip in relays if False)  # relays already excludes core-covered
total_relays = covered + sum(1 for seg in [] )  # core-covered ones were filtered pre-loop
print('核心段 %d 行 + 合作 POP /24 %d 行 | 剩余 relay 全覆盖 %d 个' % (len(CORE_NETS), len(groups), covered))
