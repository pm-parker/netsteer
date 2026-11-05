# netsteer（开发笔记，内部）

**项目状态：v1.6.0 已发布** · 立项 2026-11-04 · 运行于 R5C OpenWrt 25.12.6 · 对外 README 见根目录 README.md

## 背景

- R5C（4×A55）网卡单队列（eth0/eth1 各仅 rx-0），千兆流量软中断全落单核，是 900M 跑不满的最常见根因
- RPS/RFS/XPS 是内核 sysfs 开关，无现成管理软件（irqbalance 管硬件 IRQ 不对症）——所以要自己写
- 需求（用户 2026-11-04 拍板）：RPS+RFS+XPS 一起配，做成设置软件，前端参考 Vantage，"要显得高级"

## 架构一句话

uci 配置持久化 + init/hotplug 应用脚本 + ucode LuCI 页面（菜单入口、每核软中断可视化、预设一键应用）。

v1.6 分层：netsteer-detect（首装探测生成配置）→ netsteer-apply（uci→sysfs，产出 state.txt 单一事实源）→ netsteer-check（cron 对账+自愈）→ netsteer.js（运行时探测核数/接口，零硬编码）。

## 文档

| 文件 | 内容 |
|---|---|
| [docs/01-facts.md](01-facts.md) | 实测底数与平台机制（单队列、ucode 栈、LuCI 应用解剖） |
| [docs/02-architecture.md](02-architecture.md) | 组件与数据流 |
| [docs/03-roadmap.md](03-roadmap.md) | M1 内核应用层 → M2 LuCI 页面 → M3 打磨 → v1.5 移动端 → v1.6 通用化 |
| [docs/04-decisions.md](04-decisions.md) | 决策记录 |

## 仓库

Gitea 主仓：gitea.pcfast.heiyu.space/523034406/netsteer · GitHub 镜像：pm-parker/netsteer

## 打包

`dist/luci-app-netsteer-*.apk` 由 apk-tools 3 `mkpkg` 生成（-F PKGROOT -I name:… -s post-install），arch=aarch64_generic。换 arch 重打即可。
