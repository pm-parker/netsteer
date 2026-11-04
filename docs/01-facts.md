# 实测底数（2026-11-04，R5C @ OpenWrt 25.12.6）

## 问题结构

- eth0/eth1 各只有 rx-0/tx-0 一个队列（rk3568 GMAC）→ 全部收包软中断落单核
- 内核 6.12.112，4×Cortex-A55 @2GHz，4GB RAM（MemAvailable 3.7G）
- SQM cake 双向 900M/48M 在跑；flow offloading 未开（与 SQM 互斥，压测后另议）
- conntrack 262144；MSS 钳制在位；IPv6 双栈

## 三个内核机制

| 机制 | 作用 | 落点 |
|---|---|---|
| RPS | 把单队列的收包软中断分摊到多核 | /sys/class/net/<if>/queues/rx-*/rps_cpus（十六进制 CPU 掩码） |
| RFS | 同一流哈希到同一核，保缓存局部性（配合 RPS） | /proc/sys/net/core/rps_sock_flow_entries（全局）+ queues/rx-*/rps_flow_cnt（每队列） |
| XPS | 发送侧同理念分摊 | /sys/class/net/<if>/queues/tx-*/xps_cpus |

### XPS 在 R5C 上不可用（2026-11-04 真机实证）
- tx-0 目录存在但 xps_cpus 为 sysfs 幻影属性：`stat` 可见、`open` ENOENT、写静默失败
- `[ -e ]` 探测会误判存在 → 唯一可靠判据 = **写后回读比对**（apply 脚本已按此实现）
- 结论：rk3568 GMAC 驱动不暴露 XPS，UI 芯片保留（其他硬件/未来驱动可用），apply 如实上报"不可写, 跳过"

- pppoe-wan 是虚拟设备，有自己的 queues 目录，老系统实践经验是 pppoe 层 RPS 全核
- sysfs 值重启/链路事件会丢 → 必须 init + hotplug 双保险持久化
- 验证手段：/proc/softirqs 各核 NET_RX/NET_TX 计数前后对比 + 饱和压测

### RPS 生效实测（12s 窗口，ping fnos 40 包 + 背景流量）
- 基线：CPU1 4.7 亿 / CPU2 3.0 亿 / CPU0 4900 万 / CPU3 2.4 万（严重偏斜，CPU3 形同虚设）
- RPS=f 后增量：CPU0 +39k / CPU1 +146k / CPU2 +116k / CPU3 +33k → 四核全部吃到收包软中断

## 平台机制（LuCI ucode 应用解剖，从 luci-app-sqm 实测）

- ucode 二进制 /usr/bin/ucode；LuCI cgi 入口 #!/usr/bin/env ucode
- 现代视图是客户端 JS：/www/luci-static/resources/view/network/sqm.js（参考实现，已定位）
- 菜单注册：/usr/share/luci/menu.d/luci-app-*.json
- 权限：/usr/share/rpcd/acl.d/*.json（file.read/exec 粒度授权）
- Vantage 主题资源：/www/luci-static/resources/vantage-theme/ + view/vantage（CSS token 提取源，LuCI 内嵌页面自动继承主题样式）

## UPnP 顺带发现（同轮实测）

- miniupnpd-nftables 2.3.9 = 维护版，已装（fw4 正确变体）
- init 脚本 START=94 无 respawn 参数 → 开机时 WAN 未就绪即退出则永不拉起（今早"enabled 不 running"病根）
- uci perm_rule 支持 int_addr 字段 → 设备级 ACL 白名单原生支持（微服 .123 / 摄像头 .187 / 网心云 .175=wangxin）
