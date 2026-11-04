# 架构

```
┌─ LuCI 页面 (view/netsteer.js, 客户端 JS)
│   · 每队列 rps/xps/rfs 现值 + 每核 softirq 分布可视化
│   · CPU 掩码点选器（4 核芯片式切换）+ 预设（全核/分对/关闭）
│   · 保存 = 写 uci + 调用 apply
│         │ rpcd (file.read / fs.exec, ACL 白名单)
│         ▼
├─ /usr/bin/netsteer-apply (ash 脚本)
│   · 读 /etc/config/netsteer → 写 sysfs (rps_cpus/xps_cpus/rfs_flow_cnt)
│   · 全局 rps_sock_flow_entries
│   · 幂等，可重复执行
│         ▲
├─ /etc/init.d/netsteer          开机应用
├─ /etc/hotplug.d/iface/99-netsteer   链路事件重应用（pppoe-wan 拨上来自动生效）
└─ /etc/config/netsteer          持久化（uci）
```

## 默认预设（首版）

| 接口 | rps_cpus | xps_cpus | rfs_flow_cnt |
|---|---|---|---|
| eth0 (WAN) | f (全核) | f | 4096 |
| eth1 (LAN) | f (全核) | f | 4096 |
| pppoe-wan | f (hotplug 补挂) | - | 4096 |

全局 rps_sock_flow_entries = 32768（4 核 × 4096 × 2 队列量级）

## 部署

- 开发在沙箱；安装走"scp 推送 + 落位"（R5C wget 断流铁律，不走在线装包）
- 文件落 /www、/usr/share、/etc 三处；卸载 = 删文件 + uci drop
