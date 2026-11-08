#!/usr/bin/env python3
"""NetSteer v1.13 游戏通道真机 A/B: OFF(diffserv3 无标记) vs ON(diffserv4 + 本机路径 cs4)
负载 = 路由器自拉 alpine CDN (router-originated, 过 ifb 整形但永不被标记 = 模拟其他设备满载)
被测 = 沙箱 ping 223.5.5.5 (经微服 .123 NAT = 被标记的游戏设备路径)
"""
import subprocess, time, re, statistics, json

ROUTER = ['ssh', '-i', '/home/abc/.ssh/openwrt_lazycat', '-o', 'BatchMode=yes', 'root@192.168.11.1']
DEV_IP = '192.168.11.123'
LOAD_URL = 'https://registry.npmmirror.com/-/binary/electron/33.0.0/electron-v33.0.0-linux-x64.zip'
STREAMS = 8

def rsh(cmd, timeout=30):
    return subprocess.run(ROUTER + [cmd], capture_output=True, text=True, timeout=timeout)

def set_state(on):
    rsh(f'/usr/bin/netsteer-qos {"on " + DEV_IP if on else "off"}', timeout=40)
    time.sleep(4)  # sqm restart settle

def start_load(end_ts):
    # N 并发 range 循环下载, 到 end_ts 为止 (nohup 后台)
    streams = ' '.join(str(i) for i in range(1, STREAMS + 1))
    script = (
        f'END={end_ts}; for i in {streams}; do '
        f'(while [ $(date +%s) -lt $END ]; do curl -sL -o /dev/null -r 0-3000000000 "{LOAD_URL}"; done) & done; wait'
    )
    rsh(f'nohup sh -c "{script}" >/tmp/ns_load.log 2>&1 &', timeout=15)

def stop_load():
    rsh("kill \$(pgrep -f 'dl-cdn.alpinelinux' | head -20) 2>/dev/null; true", timeout=15)
    time.sleep(3)

def dn_sent_bytes():
    out = rsh("tc -s qdisc show dev ifb4pppoe-wan | grep '^ Sent' | head -1", timeout=15).stdout
    m = re.search(r'Sent (\d+) bytes', out)
    return int(m.group(1)) if m else 0

def ping_window(n=12):
    r = subprocess.run(['ping', '-c', str(n), '-i', '1', '-w', str(n + 4), '223.5.5.5'],
                       capture_output=True, text=True, timeout=n + 20)
    rtts = [float(x) for x in re.findall(r'time=([\d.]+)', r.stdout)]
    return rtts

def phase(on, label, rounds=2):
    results = []
    for rd in range(rounds):
        set_state(on)
        b0 = dn_sent_bytes(); t0 = time.time()
        end_ts = int(time.time()) + 26
        start_load(end_ts)
        time.sleep(5)  # ramp
        rtts = ping_window(12)
        b1 = dn_sent_bytes(); t1 = time.time()
        load_bps = max(b1 - b0, 0) * 8 / max(t1 - t0, 1)
        results.append({
            'label': f'{label}-r{rd+1}', 'on': on,
            'avg': round(statistics.mean(rtts), 2) if rtts else None,
            'p99': round(sorted(rtts)[int(len(rtts)*0.99)-1] if rtts else 0, 2),
            'max': round(max(rtts), 2) if rtts else None,
            'loss': round(100*(12-len(rtts))/12, 0),
            'load_mbps': round(load_bps/1e6, 1),
        })
        print(json.dumps(results[-1], ensure_ascii=False), flush=True)
        stop_load()
    return results

def video_pkts(dev='pppoe-wan'):
    # pkts 行 token: [pkts, bulk, best_effort, (video,) voice]; diffserv4 时 5 列
    out = rsh(f"tc -s qdisc show dev {dev} | grep -E '^  pkts '", timeout=15).stdout
    toks = out.split()
    return int(toks[3]) if len(toks) >= 5 else None   # 第4列 = Video (仅 diffserv4)

print('=== 预热: 确认通道工具响应 ===')
print(rsh('/usr/bin/netsteer-qos status', timeout=15).stdout.strip()[:200])

print('=== 测试整形带宽: 临时 30M (负载 ~50M = 167% 超售, 制造真实竞争) ===')
sec = rsh("uci -q show sqm 2>/dev/null | grep -E '=queue$|=sqm$' | head -1 | cut -d. -f2 | cut -d= -f1", timeout=15).stdout.strip()
rsh(f"uci set sqm.{sec}.download=30000; uci commit sqm", timeout=15)
rsh("/etc/init.d/sqm restart", timeout=40)
time.sleep(4)

print('=== OFF 轮 (diffserv3 无标记) ===')
off = phase(False, 'OFF', rounds=3)
print('=== ON 轮 (diffserv4 + cs4 标记) ===')
set_state(True)
vp_up0 = video_pkts('pppoe-wan'); vp_dn0 = video_pkts('ifb4pppoe-wan')
on = phase(True, 'ON', rounds=3)
vp_up1 = video_pkts('pppoe-wan'); vp_dn1 = video_pkts('ifb4pppoe-wan')
print(f'Video tin pkts 上行: {vp_up0} -> {vp_up1} | 下行: {vp_dn0} -> {vp_dn1}')

allr = off + on
valid = lambda rs: [r for r in rs if r['load_mbps'] >= 22]   # >=22M 即超过 30M 整形线 70%+ 视为有效竞争
print('=== 汇总 (整形 30M, 负载>=22M 视为有效竞争轮) ===')
print('OFF 明细:', json.dumps(off, ensure_ascii=False))
print('ON  明细:', json.dumps(on, ensure_ascii=False))
off_v = [r['avg'] for r in valid(off) if r['avg']]
on_v = [r['avg'] for r in valid(on) if r['avg']]
if off_v and on_v:
    om, nm = statistics.mean(off_v), statistics.mean(on_v)
    print(f'有效 OFF avg mean: {round(om,2)} ms | 有效 ON avg mean: {round(nm,2)} ms | 降幅 {round((om-nm)/om*100,1)}%')
else:
    print('无效竞争轮, OFF有效:', off_v, 'ON有效:', on_v)

print('=== 恢复整形 900M ===')
rsh(f"uci set sqm.{sec}.download=900000; uci commit sqm; /etc/init.d/sqm restart", timeout=40)
set_state(False)
print('已恢复 OFF (simple.qos, download=900000)')
