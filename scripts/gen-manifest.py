#!/usr/bin/env python3
"""生成 NetSteer 远程数据清单 (data/manifest.json + data/manifest.tsv)。

用法: python3 scripts/gen-manifest.py [--out DIR]
输出:
  DIR/<name>.txt      数据文件副本 (与包内 files/usr/share/netsteer/ 同源)
  DIR/manifest.json   给前端/CI 消费
  DIR/manifest.tsv    给 shell (netsteer-feed) 消费 — 无 jq 依赖, 零解析风险

manifest.tsv 格式:
  # netsteer-data-manifest v=<version> generated=<iso>
  <file>\t<sha256>\t<size>
"""
import hashlib
import json
import os
import shutil
import sys
from datetime import datetime, timezone, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'files', 'usr', 'share', 'netsteer')
# 只发布识别类数据集; 不含版本号依赖的其它文件
DATA_FILES = [
    'gamedomains.txt',
    'gameips.txt',
    'gameports.txt',
    'downloadports.txt',
    'streamdomains.txt',
]


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(65536), b''):
            h.update(chunk)
    return h.hexdigest()


def main():
    out = None
    if '--out' in sys.argv:
        out = sys.argv[sys.argv.index('--out') + 1]
    if not out:
        out = os.path.join(ROOT, 'data')
    os.makedirs(out, exist_ok=True)

    files = {}
    for name in DATA_FILES:
        src = os.path.join(SRC, name)
        if not os.path.exists(src):
            print('MISSING: %s' % src, file=sys.stderr)
            return 1
        shutil.copyfile(src, os.path.join(out, name))
        files[name] = {'sha256': sha256(src), 'size': os.path.getsize(src)}

    # 版本 = 日期 + 内容指纹前 6 位 (内容变则版本变, 便于用户侧比对)
    digest = hashlib.sha256(
        ''.join('%s:%s' % (k, files[k]['sha256']) for k in sorted(files)).encode()
    ).hexdigest()[:6]
    now = datetime.now(timezone(timedelta(hours=8)))
    version = '%s-%s' % (now.strftime('%Y.%m.%d'), digest)
    generated = now.isoformat()

    manifest = {
        'schema': 1,
        'version': version,
        'generated_at': generated,
        'files': files,
    }
    with open(os.path.join(out, 'manifest.json'), 'w') as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False, sort_keys=True)
        f.write('\n')

    with open(os.path.join(out, 'manifest.tsv'), 'w') as f:
        f.write('# netsteer-data-manifest v=%s generated=%s\n' % (version, generated))
        for name in sorted(files):
            f.write('%s\t%s\t%d\n' % (name, files[name]['sha256'], files[name]['size']))

    # 包内基线副本: 随 apk 分发, netsteer-feed status/check 以此为本地版本锚点
    pkg_manifest = os.path.join(SRC, 'manifest.tsv')
    if os.path.abspath(pkg_manifest) != os.path.abspath(os.path.join(out, 'manifest.tsv')):
        shutil.copyfile(os.path.join(out, 'manifest.tsv'), pkg_manifest)

    print('OK: version=%s files=%d out=%s' % (version, len(files), out))
    return 0


if __name__ == '__main__':
    sys.exit(main())
