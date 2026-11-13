# NetSteer — OpenWrt 的整合网络加速方案

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/pm-parker/netsteer/actions/workflows/ci.yml/badge.svg)](https://github.com/pm-parker/netsteer/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)

> **[dnsworker.com](https://dnsworker.com/netsteer/)** —— 官方网站：免费在线 **[Bufferbloat 测试](https://dnsworker.com/)**（满载延迟检测）+ OpenWrt 加速指南，支持英/德/俄/土/西五种语言；测出你的满载延迟，再用 NetSteer 一键修复。

**OpenWrt 界的 cFosSpeed：把智能队列整形、多核负载分摊、中断亲和、P2P 直通整合成一个带实测增益对比的加速方案。**

一个总开关，两种世界：关闭时它是系统原生行为并自动测量基线；开启后 cake 整形 + 全核分摊 + P2P 直通全部生效，页面实时显示与基线对比的真实增益——延迟 ↓9%（5.7 → 5.2 ms，本机 8 秒实测），不是营销数字。

![overview](docs/images/screenshot-overview.png)

*NanoPi R5C · OpenWrt 25.12.6 · LuCI 26.288 实拍。总开关开着（P2P 模式），路径图粒子速度随实时流量三档变化，吞吐曲线含「vs 基线」增益参考线。*

## 它解决什么

家用路由器的网络性能问题很少是单点的：上行拥塞时游戏延迟飙升（需要队列整形）、大流量下载时单核饱和掉速（需要多核分摊）、P2P 打洞失败（需要 Fullcone 型直通）、以及"调了半天到底有没有用"（需要可测量的对比）。

市面上每个方向都有独立工具：SQM 管整形、sysfs 手工管分核、防火墙规则管直通——但它们互不通气，更没有一套面向普通用户的统一界面。NetSteer 把这四件事整合成三页 UI：小白看总览仪表盘，进阶用一键体检和场景模式，专业用户逐核调教——每一层的改动都实时反映在同一个仪表盘上。

## 核心特性

| | |
|---|---|
| **加速总开关 + A/B 增益** | 关闭自动测系统基线（真实 ping 时延 + 吞吐采样），开启显示实测增益百分比；增益数字来自路由器本机测量，空载显示「持平」不美化 |
| **实时仪表盘** | 网络路径粒子流图（速度=实时流量，三档）、收包集中度/智能队列/转发链路健康卡、上下行吞吐曲线 + 增益参考线 |
| **一键体检** | SQM/软中断集中度/转发链路/offloading 多维检测，冲突项标注；依赖缺失时给两档方案（免安装替代 / 确切安装命令） |
| **场景模式** | 均衡 / 吞吐优先 / 低延迟 / 分核调度 / P2P 直通一键切换，每档是声明式动作集（cake 档位、RPS 掩码、IRQ 策略），即时生效重启保持 |
| **识别库数据集 (周自动更新, 独立版本线)** | 场景识别数据集 (游戏域名 / 中继 IP 段 / 端口 / 流媒体域名 / 会议域名 / BT tracker — 7 个文件) 免重装更新:GitHub Actions 每周自动拉上游 (cache-domains、Valve 官方 SDR API、Microsoft 365 官方 endpoints、ngosang/trackerslist、anti-AD 按平台家族表反推),有变化开 PR 人工过目,合并即发布并自动刷新 CDN —— **数据集独立版本线 (日期+内容哈希),不随插件版本号变化**;路由器每周二 04:37 自动拉取;sha256 + 语义校验 + 引擎烟测三层全过才原子落地,失败自动回滚,防降级保护拒绝旧版远端 —— 随包数据集始终是离线兜底基线 |
| **P2P 直通** | 给指定设备一键开 UDP 全端口入站（Fullcone 等效），BT/PT/联机游戏 NAT 穿透成功率显著提升；fw4 原生规则随开关幂等增删 |
| **专家调教** | 每接口每核独立 RPS/XPS 开关、IRQ 亲和可视化编辑 + 设置前后软中断集中度 delta 实测对比；PPPoE 虚拟口同样支持 |
| **守卫后台** | 每分钟对账配置与运行态，漂移自动修复并存证到持久目录 |
| **跨设备通用** | 核数、接口、IRQ 号全部运行时探测零硬编码；首装按真实硬件生成默认配置；内置压测实测你的设备推荐最优方案 |

## 截图

总览（总开关 + 路径图 + 吞吐曲线） | 智能优化（体检 + 场景模式）
---|---
![overview](docs/images/screenshot-overview.png) | ![optimize](docs/images/screenshot-optimize.png)

专家调教（分核 + IRQ 亲和） | 移动端
---|---
![expert](docs/images/screenshot-expert.png) | ![mobile](docs/images/screenshot-mobile.png)

移动端是一等公民：44px 触控热区、悬停交互全都有点按等价物、单列卡片布局，深浅主题自动跟随。

### 极限 A/B 压测（v1.12.4 · 真机实测）

![ab-benchmark](docs/images/netsteer-ab-benchmark.png)

*NanoPi R5C · 电信 1000M↓/50M↑：16 线程满载下载 30s × 2 轮均值，下载进行中并发 ping。开启 NetSteer（cake + 全核分摊 + P2P）后**平均满载延迟 ↓87%**（58.6 → 7.8 ms）、**满载延迟跨度 −88%**（56.4 → 6.9 ms）——满载下载时游戏/视频会议延迟不再飙升。代价如实呈现：满载吞吐 −29%（cake 整形在 4 核软转发上的开销，两侧均远超日常实际使用带宽）；空载延迟基本持平（ON 略有开销）。测试脚本随仓库提供（`scripts/bench-ab-*.sh`），可在你的设备上复现。*

### 历史压测（v1.6 时代，分核单维度）

![benchmark](docs/images/benchmark-before-after-zh.png)

*NanoPi R5C（4 核、单队列千兆）同样 20 路 HTTPS 下载：开启推荐方案后持续收包吞吐 **+17%**，最忙核占比不升。*

## 安装

### 方式 A — Release 安装包（推荐）

到 [Releases](https://github.com/pm-parker/netsteer/releases) 下载匹配架构的 `.apk`（路由器上 `cat /etc/apk/arch` 查看），拷到路由器后：

```sh
apk add --allow-untrusted /tmp/luci-app-netsteer-*.apk
/etc/init.d/netsteer enable
/etc/init.d/netsteer start
rm -f /tmp/luci-indexcache*
/etc/init.d/rpcd reload
```

OpenWrt 的 apk 不执行包内 install hooks（apk 3.0.5 实测），所以开机自启、菜单缓存和 rpcd 重载需要上面四行手动完成；`netsteer start` 同时会挂上 `netsteer-check` 的每分钟 cron（对账自愈、过热保护、数据集升级保护）。首次打开页面会引导初始设置。适用 OpenWrt 24.10+/25.12（apk 包格式）。

### 方式 B — 手动安装

```sh
scp -O files/usr/bin/netsteer-* root@路由器IP:/usr/bin/
scp -O files/etc/init.d/netsteer root@路由器IP:/etc/init.d/
scp -O files/www/luci-static/resources/view/netsteer.js root@路由器IP:/www/luci-static/resources/view/
scp -O files/usr/share/luci/menu.d/luci-app-netsteer.json root@路由器IP:/usr/share/luci/menu.d/
scp -O files/usr/share/rpcd/acl.d/luci-app-netsteer.json root@路由器IP:/usr/share/rpcd/acl.d/
ssh root@路由器IP 'chmod +x /usr/bin/netsteer-* /etc/init.d/netsteer && /etc/init.d/netsteer enable && /etc/init.d/netsteer start && rm -f /tmp/luci-indexcache* && /etc/init.d/rpcd restart'
```

然后在 LuCI 打开 **服务 → 网络加速 NetSteer**。

### 卸载

```sh
apk del luci-app-netsteer
# /etc/config/netsteer 会保留（升级不丢配置）；需要彻底清理就手动删掉
```

## 原理

NetSteer 是整合层，不发明新机制——每一项都调内核既有能力，因此行为可预期、完全可逆：

- **队列整形**：SQM/cake（`/etc/config/sqm`），上行拥塞时的延迟控制；场景模式切换档位，总开关关闭时停用但保留配置
- **RPS/XPS**（`/sys/class/net/*/queues/*/rps_cpus`、`xps_cpus`）：把包处理摊到多核，解决单队列网卡单核饱和
- **IRQ 亲和**（`/proc/irq/*/smp_affinity`）：网卡中断钉在较闲的核上，多接口错开
- **P2P 直通**：fw4/nftables 规则做 UDP 全端口 DNAT（Fullcone 等效）
- **增益测量**：`netsteer-bench` 8 秒窗口实测 ping 时延 + 网口吞吐采样，基线持久化到 uci；总开关切换时后台自动跑，页面对比显示
- **负载延迟探测**：`netsteer-bloat` 测空闲延迟 vs 8 流 CDN 下载下的负载延迟（含实测负载 Mbps），verdict 落 uci；总览页手动触发。诚实边界：千兆线路上本探测验证整形健康度与容量下界（本机负载 ~200Mbps）——满载 bufferbloat 需外部负载源（flent 式），详见脚本头部说明
- **过热保护**：`netsteer-check` 每分钟采样最热温区写入 `/tmp/netsteer/health.json`；≥85°C 记日志告警（10 分钟防刷屏），≥95°C 自动降档 steering 并落事故日志（不自动恢复——UI 会提示何时手动恢复）
- **快照与回滚**：档位/总开关/向导/设备列表每次变更前自动快照 netsteer+sqm+分载配置到 `/etc/netsteer/snapshots/`（保留 20 份，同标签 5 分钟去重）；`netsteer-snapshot restore` 恢复 uci **并重放 nft 规则层**（P2P 直通、游戏通道——规则不在 uci 里）；回滚前自动另存 pre-restore 快照（回滚本身可回滚）。持久变更时间线 `/etc/netsteer/history.log`（重启不丢；/tmp 版会丢）
- **netsteer-apply** 从 UCI 配置声明式写 sysfs，记录已应用状态，开机幂等执行
- **netsteer-check**（cron 每分钟）对账运行态与配置，自动修复漂移并存证到 `/etc/netsteer/incidents/`

一切可逆：总开关关闭即回系统默认，`系统默认` 预设恢复内核出厂行为。

## 排障与反馈

一条命令收集定位问题所需的全部信息 —— SSH 到路由器执行：

```sh
netsteer-doctor
```

输出十个分段（包版本、环境、SQM 状态、分载开关、观测通道、场景引擎、加速通道、转向状态、配置、最近日志）和一行 `VERDICT` 判定，已知边界（缺依赖、分载导致计数冻结、daemon 泄漏、DNS 观测降级）会自动标注 WARN。[提 issue](https://github.com/pm-parker/netsteer/issues) 时把完整输出贴进模板即可。

## 诚实的边界

- 增益百分比是本机实测，空载网络下差异小（如实显示「持平」）；cake 整形的收益在上行拥塞时才显著
- 单队列网卡的分摊均匀度有物理下限——自动压测给你看设备真实数字，不承诺固定收益
- 压测会跑约 30 秒真实下载流量；在正常使用时段跑，样本更有代表性
- 已在 NanoPi R5C（aarch64_generic、4 核、OpenWrt 25.12.6）实测。任何带标准 sysfs 的 ARM/x86_64 设备理论上可用；如果你的设备不行，请开 issue 附上 `cat /sys/devices/system/cpu/online` 与 `ls /sys/class/net/` 输出

## 开发与测试

- `node tests/unit/core.test.js` —— 138 项纯函数断言（多核逻辑/基线解析/方案评分，每次 push 在 CI 自动跑）
- `tests/e2e/e2e.py` —— 面向真实路由器的整页浏览器测试 69 项（发版前净装卸后复跑）
- `scripts/build-apk.sh <版本> <arch>` —— 本地复现正式 .apk；CI 每次 push 自动构建 4 种架构并逐包 `apk verify`，打 tag 时自动附到 GitHub Release（附版本说明）
- 真机环节（装卸重装、A/B 对比、重启持久化）记录在 tests/README.md

## 版本说明

每个版本的特色/新增/修复见 [Releases](https://github.com/pm-parker/netsteer/releases) 与仓库 `release-notes/` 目录。

## 许可

MIT——见 [LICENSE](LICENSE)。
