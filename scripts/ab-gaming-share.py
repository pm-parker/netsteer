#!/usr/bin/env python3
"""带宽份额 A/B: 30M 整形被 bulk 打满时, 被标记设备路径的可用带宽 OFF vs ON
负载 = 路由器 8 流 curl npmmirror (不标记, bulk 侧)
被测 = 沙箱 ping -f ICMP flood (走转发链 → 被标记, video tin 侧; ICMP 不被 mihomo 劫持)
"""
import subprocess, time, re, statistics, json

ROUTER = ['ssh', '-i', '/home/abc/.ssh/openwrt_lazycat', '-o', 'BatchMode=yes', 'root@192.168.11.1']
DEV_IP = '192.168.11.123'
LOAD_URL = 'https://registry.npmmirror.com/-/binary/electron/33.0.0/electron-v33.0.0-linux-x64.zip'

def rsh(cmd, timeout=30):
    return subprocess.run(ROUTER + [cmd], capture_output=True, text=True, timeout=timeout)

def set_state(on):
    rsh(f'/usr/bin/netsteer-qos {"on " + DEV_IP if on else "off"}', timeout=40)
    time.sleep(4)

def start_load(end_ts):
    streams = ' '.join(str(i) for i in range(1, 9))
    script = (f'END={end_ts}; for i in {streams}; do '
              f'(while [ $(date +%s) -lt $END ]; do curl -sL -o /dev/null -r 0-3000000000 "{LOAD_URL}"; done) & done; wait')
    rsh(f'nohup sh -c "{script}" >/tmp/ns_load.log 2>&1 &', timeout=15)

def stop_load():
    rsh("kill $(pgrep -f 'npmmirror' | head -20) 2>/dev/null; true", timeout=15)
    time.sleep(3)

def flood_throughput(packets=2500, size=1200):
    """ICMP flood → bytes/s (走转发链, 被标记路径)"""
    t0 = time.time()
    r = subprocess.run(['sudo', '-n', 'ping', '-f', '-s', str(size), '-c', str(packets), '115.171.90.1'],
                       capture_output=True, text=True, timeout=120)
    dt = time.time() - t0
    ok = 0
    m = re.search(r'(\d+) packets transmitted, (\d+) received', r.stdout)
    if m: ok = int(m.group(2))
    return ok * (size + 28) * 8 / dt / 1e6  # Mbps (含 ICMP 头)

def phase(on, label, rounds=2):
    out = []
    for rd in range(rounds):
        set_state(on)
        end_ts = int(time.time()) + 34
        start_load(end_ts)
        time.sleep(6)   # bulk 爬速
        mbps = flood_throughput()
        out.append({'label': f'{label}-r{rd+1}', 'flood_mbps': round(mbps, 2)})
        print(json.dumps(out[-1]), flush=True)
        stop_load()
    return out

sec = rsh("uci -q show sqm 2>/dev/null | grep -E '=queue$|=sqm$' | head -1 | cut -d. -f2 | cut -d= -f1", timeout=15).stdout.strip()
rsh(f"uci set sqm.{sec}.download=30000; uci commit sqm; /etc/init.d/sqm restart", timeout=40)
time.sleep(4)

print('=== OFF (无标记, flood 在 best-effort 与 8 条 bulk 流公平竞争) ===')
off = phase(False, 'OFF')
print('=== ON (flood 走 video tin) ===')
on = phase(True, 'ON')

off_v = [r['flood_mbps'] for r in off]
on_v = [r['flood_mbps'] for r in on]
print('=== 汇总 ===')
print(f'OFF flood share: {off_v} mean={round(statistics.mean(off_v),2)} Mbps')
print(f'ON  flood share: {on_v} mean={round(statistics.mean(on_v),2)} Mbps')
if off_v and on_v:
    ratio = statistics.mean(on_v) / max(statistics.mean(off_v), 0.01)
    print(f'份额倍数: {round(ratio, 2)}x')

rsh(f"uci set sqm.{sec}.download=900000; uci commit sqm; /etc/init.d/sqm restart", timeout=40)
set_state(False)
print('已恢复 (900M, simple.qos, OFF)')
