#!/usr/bin/env python3
"""netsteer 场景注入 e2e (真机+双 pod, 独立于 e2e.py 默认集; 无 pod 环境自动跳过)

验证的是完整链路: LAN 设备真实流量 → 路由器观测面 (mihomo 连接表 / conntrack) → sense.awk 真引擎判定。
单元测试只喂构造行, 本脚本喂真实网络流量 — 两者互补。

用法: python3 tests/e2e/inject_test.py
前置: SSH key (openwrt_lazycat / id_ed25519_fn_nas) 可达路由器与两个 pod。
注意: 会临时切换 netsteer.qos.dns_observer (结束恢复 auto), 并产生 ~1MB 真实出网流量。
"""
import subprocess, sys, time
import json as _json

KEY_R = "/home/abc/.ssh/openwrt_lazycat"
KEY_P = "/home/abc/.ssh/id_ed25519_fn_nas"
ROUTER = "root@192.168.11.1"
POD_A = "nvidia@192.168.11.179"   # 发送端
POD_B = "nvidia@192.168.11.139"   # 接收端 (LAN 内, 当前不用 — LAN→LAN 不过 conntrack)
STREAM_URL = "https://www.youtube.com/"  # streamdomains 命中, 主页 ~850KB ≥ 512KB 门槛
# 注入源必须让流量真正经过 R5C 的透明代理 (Nikki Redir), 否则 mihomo 表里没有 sourceIP=pod 的连接,
# 域名证据拿不到。实测可行姿势: --resolve 指定真实 IP (绕开 pod 侧 fake-ip) + SNI 保留域名。
REAL_IP = "69.171.235.22"
PROXY_AUTH = "http://nikki:282398@192.168.11.1:7890"  # 备用显式代理

PASS = []
def ok(name): PASS.append(name); print("PASS:", name)

def sh(key, host, cmd, timeout=60):
    return subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-i", key,
                           host, cmd], capture_output=True, text=True, timeout=timeout)

# 0) 环境预检 — 无 pod 环境静默跳过 (exit 77 = SKIP, 不算 FAIL)
pre = sh(KEY_P, POD_A, "hostname", timeout=15)
if pre.returncode != 0:
    print("SKIP: pod A 不可达, 注入 e2e 不适用此环境")
    sys.exit(77)
ok("环境预检: pod A 可达")

# 1) streaming 场景 — 域名证据路径 (观测面=mihomo, sniffHost + 下行≥512KB)
# 注入期间轮询采样 (连接关闭即出 mihomo 连接表, 完成后再采是空的)
# 生产判定管线 = dnslog | qos_json2tab | exclude.awk | sense.awk (netsteer-qos sense 是它的封装)
def sense_verdict():
    r = sh(KEY_R, ROUTER, "/usr/bin/netsteer-qos sense 500", timeout=90)
    if r.returncode != 0 or '"scene"' not in r.stdout:
        return None
    return _json.loads(r.stdout.strip().splitlines()[-1])

inj = subprocess.Popen(["ssh", "-o", "BatchMode=yes", "-i", KEY_P, POD_A,
                        f"for i in $(seq 1 40); do curl -s --resolve www.youtube.com:443:{REAL_IP} "
                        f"--limit-rate 25k --max-time 90 -o /dev/null https://www.youtube.com/ & sleep 1; done"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
verdict = None
for _ in range(25):
    time.sleep(2)
    v = sense_verdict()
    if v and v["verdict"]["ev"]["stream_dom"] + v["verdict"]["ev"]["stream_bulk"] >= 1:
        verdict = v
        break
inj.terminate()
assert verdict, "注入进行中始终未捕到 streaming 证据"
ev = verdict["verdict"]["ev"]
ok(f"streaming 注入: {STREAM_URL} → ev_stream_dom={ev['stream_dom']} ev_stream_bulk={ev['stream_bulk']} scene={verdict['verdict']['scene']}")

# 2) download/gaming 场景 — 端口证据路径 (UDP 单向流 → conntrack, 需切观测面)
sh(KEY_R, ROUTER, "uci set netsteer.qos.dns_observer=conntrack; uci commit netsteer", timeout=15)
try:
    inj = subprocess.run(["ssh", "-o", "BatchMode=yes", "-i", KEY_P, POD_A,
                          "python3 -c \"import socket,time; s=socket.socket(2,2); end=time.time()+8; n=0\n"
                          "while time.time()<end:\n"
                          "    s.sendto(b'G'*1400,('8.8.8.8',27015)); s.sendto(b'B'*1400,('1.1.1.1',6881)); n+=1; time.sleep(0.02)\n"
                          "print(n)\""],
                         capture_output=True, text=True, timeout=40)
    assert inj.stdout.strip().isdigit() and int(inj.stdout) > 100, f"UDP 注入异常: {inj.stdout!r}"
    raw = sh(KEY_R, ROUTER, "/usr/bin/netsteer-qos dnslog-raw 3000 | grep -E $'\\t(6881|27015)\\t' | awk -f /usr/share/netsteer/sense.awk",
             timeout=120)
    assert raw.returncode == 0 and raw.stdout.strip(), f"dnslog-raw 未取到端口流: {raw.stderr[:200]}"
    v2 = _json.loads(raw.stdout.strip().splitlines()[-1])
    assert v2["ev"]["download"] + v2["ev"]["gaming"] >= 2, \
        f"端口证据未进引擎: {v2}"
    ok(f"download/gaming 注入: UDP 6881+27015 → ev_download={v2['ev']['download']} ev_gaming={v2['ev']['gaming']}")
finally:
    sh(KEY_R, ROUTER, "uci set netsteer.qos.dns_observer=auto; uci commit netsteer", timeout=15)

# 3) 观测面恢复确认
env = sh(KEY_R, ROUTER, "/usr/bin/netsteer-qos env")
assert '"dns_observer":"mihomo"' in env.stdout, f"观测面未恢复: {env.stdout[:200]}"
ok("观测面已恢复 auto (mihomo)")

print(f"INJECT ALL GREEN ({len(PASS)} checks)")
