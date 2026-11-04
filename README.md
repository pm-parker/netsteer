# netsteer

**项目状态：开发中** · 立项 2026-11-04 · 运行于 R5C OpenWrt 25.12.6

自研的 RPS / RFS / XPS 网络软中断转向调优器——LuCI 原生应用（ucode 生态），界面风格对齐 Vantage 主题。

## 背景

- R5C（4×A55）网卡单队列（eth0/eth1 各仅 rx-0），千兆流量软中断全落单核，是 900M 跑不满的最常见根因
- RPS/RFS/XPS 是内核 sysfs 开关，无现成管理软件（irqbalance 管硬件 IRQ 不对症）——所以要自己写
- 需求（用户 2026-11-04 拍板）：RPS+RFS+XPS 一起配，做成设置软件，前端参考 Vantage，"要显得高级"

## 架构一句话

uci 配置持久化 + init/hotplug 应用脚本 + ucode LuCI 页面（菜单入口、每核软中断可视化、预设一键应用）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-facts.md](docs/01-facts.md) | 实测底数与平台机制（单队列、ucode 栈、LuCI 应用解剖） |
| [docs/02-architecture.md](docs/02-architecture.md) | 组件与数据流 |
| [docs/03-roadmap.md](docs/03-roadmap.md) | M1 内核应用层 → M2 LuCI 页面 → M3 打磨 |
| [docs/04-decisions.md](docs/04-decisions.md) | 决策记录 |

## 仓库

Gitea 主仓：gitea.pcfast.heiyu.space/523034406/netsteer · GitHub 镜像：pm-parker/netsteer（私有）
