#!/usr/bin/env python3
"""NetSteer 数据集周采集器 (与插件版本完全解耦 — 只产 data/*.txt + manifest, 不动 NS_VERSION/不 tag)

采集源 (自动):
  gamedomains.txt  ← uklans/cache-domains (MIT) 上游域名库 (类别映射后) + 本地手工补充段原样保留
  gameips.txt      ← Valve 官方 SDR API (ISteamApps/GetSDRConfig, appid=730) 全量中继 /24 聚合

不采集 (无 API, 官方文档来源, 变化慢, 保持手工维护):
  gameports.txt / downloadports.txt / streamdomains.txt

用法:
  python3 scripts/collect-datasets.py            # 采集 → 写 data/ (有 diff 时)
  python3 scripts/collect-datasets.py --dry-run  # 只报告 diff 不写

输出后请跑: python3 scripts/gen-manifest.py   (重生成 manifest, 版本=日期+内容hash, 独立版本线)
"""
import datetime
import difflib
import ipaddress
import json
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'files', 'usr', 'share', 'netsteer')   # 包内真数据 (gen-manifest 同步到 data/)
UP_CACHE = 'https://raw.githubusercontent.com/uklans/cache-domains/master/'
SDR_API = 'https://api.steampowered.com/ISteamApps/GetSDRConfig/v1/?appid=730'
TODAY = datetime.date.today().isoformat()

# 上游 service 名 → netsteer 类别 (与 2026-11-08 首版策划口径一致)
CAT_MAP = {
    'steam': 'steam', 'epicgames': 'epic', 'blizzard': 'blizzard',
    'riot': 'riot', 'riotgames': 'riot', 'origin': 'ea', 'ea': 'ea',
    'sony': 'psn', 'playstation': 'psn', 'nintendo': 'nintendo',
    'xbox': 'xbox', 'wargaming': 'wargaming', 'ubisoft': 'ubisoft',
    'squareenix': 'square', 'rockstar': 'rockstar', 'arenanet': 'arenanet',
    'gog': 'gog', 'battlestate': 'bsg', 'bethesda': 'bethesda',
    'warframe': 'warframe', 'windowsupdate': 'windowsupdate',
    'callofduty': 'cod', 'blizzard--classic': 'blizzard',
}

MANUAL_MARKER = '# ---- 手工补充'


def fetch(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'netsteer-dataset-bot/1.0'})
    with urllib.request.urlopen(req, timeout=45) as r:
        return r.read().decode('utf-8', 'replace')


def collect_gamedomains():
    """上游域名库 → 类别\\t后缀 (排序稳定); 本地手工补充段 (MANUAL_MARKER 起) 原样追加"""
    cfg = json.loads(fetch(UP_CACHE + 'cache_domains.json'))
    cats = {}
    for svc in cfg.get('cache_domains', []):
        cat = CAT_MAP.get(svc['name'].lower(), svc['name'].lower())
        for df in svc.get('domain_files', []):
            body = fetch(UP_CACHE + df)
            for line in body.splitlines():
                d = line.strip().lower()
                if d and not d.startswith('#'):
                    if d.startswith('*.'):
                        d = d[2:]   # 上游通配行 → 裸后缀 (引擎=后缀匹配, 子域自然覆盖)
                    if d:
                        cats.setdefault(cat, set()).add(d)
    # 手工补充段保留
    path = os.path.join(SRC, 'gamedomains.txt')
    manual, in_manual = [], False
    for line in open(path, encoding='utf-8'):
        s = line.rstrip('\n')
        if s.startswith(MANUAL_MARKER):
            in_manual = True
        if in_manual:
            manual.append(s)
    n_up = sum(len(v) for v in cats.values())
    n_man = len([l for l in manual if l and not l.startswith('#')])
    out = []
    out.append('# NetSteer 游戏平台域名数据集 (L1 DNS 分类)')
    out.append('# 派生自 uklans/cache-domains (MIT License) https://github.com/uklans/cache-domains')
    out.append('# 自动采集: %s (上游 %d 个 service 域名 + 手工补充 %d 条)' % (TODAY, len(cats), n_man))
    out.append('# 格式: <类别>\\t<域名后缀>; 匹配=查询名等于后缀或以其结尾')
    out.append('# 共 %d 个后缀 (上游 %d + 手工 %d)' % (n_up + n_man, n_up, n_man))
    out.append('')
    for cat in sorted(cats):
        out.append('# %s' % cat)
        for d in sorted(cats[cat]):
            out.append('%s\t%s' % (cat, d))
        out.append('')
    out.append('')
    out.extend(manual if manual else [MANUAL_MARKER + ' (上游通配域缺失, 裸后缀) — 手工维护段'])
    out.append('')
    return '\n'.join(out)


def collect_gameips():
    """Valve SDR 中继 → /24 聚合 (同段多中继合并; 附中继计数注释)"""
    data = json.loads(fetch(SDR_API))
    rev = data.get('revision')
    per24 = {}  # '1.2.3.0/24' -> [relay ips]
    for pop in data.get('pops', {}).values():
        for relay in pop.get('relays', []):
            try:
                ip = ipaddress.ip_address(relay['ipv4'])
            except (KeyError, ValueError):
                continue
            net = str(ipaddress.ip_network('%s/24' % ip, strict=False))
            per24.setdefault(net, []).append(str(ip))
    # 大段聚合: 与首版口径一致, Valve 自有 AS32590 大段 (155.133/162.254/185.25 等) 保持人工策底线
    # —— SDR API 只给中继 /32; 首版的 /16 /22 大段是 AS 共识策定, 自动化只做安全的 /24 收敛
    keep = {n: ips for n, ips in per24.items()}
    out = []
    out.append('# netsteer L2: game platform IP segments (category TAB CIDR, IPv4)')
    out.append('# source: Valve official SDR API (ISteamApps/GetSDRConfig appid=730) pulled %s' % TODAY)
    out.append('# auto-aggregated /24 per relay (same-block relays merged); /16 /22 AS-consensus')
    out.append('# blocks from the 2026-11-08 manual curation are kept below (API sees relays only)')
    out.append('# matching: longest-prefix wins; covers bare-IP direct traffic (no SNI/DNS name)')
    out.append('# revision: %s' % rev)
    out.append('')
    out.append('# ---- SDR API /24 自动段 (rev %s, %d blocks) ----' % (rev, len(keep)))
    for n in sorted(keep, key=lambda x: int(ipaddress.ip_network(x).network_address)):
        ips = sorted(keep[n])
        note = '\t# %d relays (%s)' % (len(ips), ','.join(ips[:3]) + ('…' if len(ips) > 3 else '')) if len(ips) > 1 else ''
        out.append('steam\t%s%s' % (n, note))
    return '\n'.join(out) + '\n'


def merge_gameips_automated():
    """gameips = 自动 SDR 段 + 原文件的 AS 共识大段 (< /24 的手工策定段) 原样保留"""
    path = os.path.join(SRC, 'gameips.txt')
    old = open(path, encoding='utf-8').read()
    # 抽出旧文件里前缀长度 < 24 的行 (人工策定大段) — 自动段整体重写
    big = [l for l in old.splitlines()
           if l and not l.startswith('#') and int(l.split('\t')[1].split('/')[1]) < 24]
    auto = collect_gameips()
    # auto 段后追加人工大段
    tail = ['', '# ---- AS 共识大段 (人工策定, SDR API 不可见, 保持 2026-11-08 口径) ----']
    tail += big
    return auto + '\n'.join(tail) + '\n'


def main():
    dry = '--dry-run' in sys.argv
    changed = []
    plan = {
        'gamedomains.txt': lambda: collect_gamedomains(),
        'gameips.txt': lambda: merge_gameips_automated(),
    }
    for name, gen in plan.items():
        path = os.path.join(SRC, name)
        old = open(path, encoding='utf-8').read()
        new = gen()
        if new != old:
            changed.append(name)
            if not dry:
                open(path, 'w', encoding='utf-8').write(new)
            else:
                diff = difflib.unified_diff(old.splitlines(), new.splitlines(),
                                            'data/%s (old)' % name, 'data/%s (new)' % name, lineterm='')
                print('\n'.join(list(diff)[:40]))
        else:
            print('unchanged: %s' % name)
    if changed:
        if dry:
            print('DRY-RUN diff in: %s' % ', '.join(changed))
        else:
            print('updated: %s' % ', '.join(changed))
            print('next: python3 scripts/gen-manifest.py')
    else:
        print('no upstream changes')


if __name__ == '__main__':
    main()
