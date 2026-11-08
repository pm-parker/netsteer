# GitHub 开源方案与清单盘点（游戏加速/DPI/流量识别）

调研日期：2026-11-08 · 方法：GitHub API 全量搜索 + 逐仓库验证 + 活性探测
用途：v1.13「游戏设备优先通道」的引擎选型与数据源规划

## A. DPI 引擎类

| 项目 | 星 | 许可 | 活性 | 内容 | 对 NetSteer |
|---|---|---|---|---|---|
| [ntop/nDPI](https://github.com/ntop/nDPI) | ~2.6k | LGPL-3.0 | 活跃 | 400+ 协议用户态 DPI 库。**官方 OpenWrt 25.12 feed 有 libndpi-5.0-r1.apk**（aarch64，2026-11-08 实证） | L2 可选引擎首选；无内核 xtables 集成 |
| [betolj/ndpi-netfilter](https://github.com/betolj/ndpi-netfilter) | 128 | GPL-2.0 | 停更 2017 | nDPI 的 iptables/内核态集成（唯一内核级 nDPI 路径） | 需适配 6.12 内核，风险大；仅作参考 |
| netifyd（Netify Agent） | - | GPL-3.0 | 官方仓库已 404，GPL 镜像存续（zhang0426/netifyd 等） | 独立 DPI agent，被 luci-app-appflow / luci-app-traffic-chart 采用 | 备选引擎；签名库部分走 netify.ai 服务 |
| [destan19/OpenAppFilter](https://github.com/destan19/OpenAppFilter) | 2950 | GPL-2.0 | 活跃（2026-10） | 内核模块 + 文本特征库（feature.cfg v3 格式：`proto;sport;dport;host;request;dict;search`），覆盖王者荣耀/抖音等国内应用 | 特征库**格式**最佳参考；注意特征库本体版权为 All Rights Reserved，不可整体复制 |
| [DanieleDeSensi/peafowl](https://github.com/DanieleDeSensi/peafowl) | 132 | MIT | 低频 | 轻量用户态 DPI 框架 | 备选 |
| l7-filter/layer7-patterns | 26 | GPL-2.0 | 停更 2014 | 经典正则 L7 签名，几乎无游戏条目 | 历史参考 |

## B. 数据清单类（可直接集成/喂养）

| 来源 | 星 | 许可 | 更新 | 内容 | 对 NetSteer |
|---|---|---|---|---|---|
| [uklans/cache-domains](https://github.com/uklans/cache-domains) | 700 | MIT | **周更**（2026-11-01 验证） | 按厂商分文件的游戏下载域名：steam/blizzard/riot/epic/origin/uplay/xboxlive/sony/nintendo/cod/wargaming 等 36 文件（`*.txt` 通配域名 + cache_domains.json 元数据） | **L1 DNS 分类直接数据源**，已验证可拉取 |
| Steam 官方 | - | - | 实时 | `api.steampowered.com/ISteamApps/GetSDRConfig/v1?appid=N`（需 appid 参数，返回 SDR 中继段位） | 游戏服务器段位补充 |
| Microsoft Service Tags | - | - | 每周 JSON | 含 XboxLiveData 等 XBL 段位（download.microsoft.com，链接需从落地页解析当期） | 主机游戏流量识别 |
| [denniskupec/valve-matchmaking-ip-ranges](https://github.com/denniskupec/valve-matchmaking-ip-ranges) | 70 | - | 停更 2019 | Valve 匹配服务器 IP（CS2 时代已漂移，部分失效） | 参考 |
| ASUS 明文游戏端口清单 | - | - | 陈旧（本仓库已归档 `asus-qos-default-gamelist.xml`） | 46 款游戏端口+协议+优先级（CS 1.6/Diablo3 时代） | 自维护端口表的种子之一 |
| you-oops-dev/ipranges-* | 36 | CC0-1.0 | 活跃 | Google/Azure/Cloudflare 等大厂段位 | 下载流量归类参考 |

## C. 编排/机制参考类

| 项目 | 星 | 许可 | 活性 | 机制 | 对 NetSteer |
|---|---|---|---|---|---|
| [lynxthecat/cake-autorate](https://github.com/lynxthecat/cake-autorate) | 578 | GPL-2.0 | 活跃（2026-11-06） | 按 RTT+负载动态调 CAKE 带宽（为 LTE/星链等变速连接设计），shell 实现 | 「动态带宽」特性参考；非游戏专用但久经实战 |
| [sqm-autorate/sqm-autorate](https://github.com/sqm-autorate/sqm-autorate) | 139 | MPL-2.0 | 2026-05 | cake-autorate 前身 | 同上 |
| [Lochnair/unravel](https://github.com/Lochnair/unravel) | 10 | MPL-2.0 | 活跃 | Rust 重写的自适应 CAKE | 工程形态参考 |
| [VolanticSystems/luci-app-appflow](https://github.com/VolanticSystems/luci-app-appflow) | 9 | Apache-2.0 | 活跃（2026-10） | LuCI 内按应用/设备实时流量看板，开源组件拼装（DPI 后端可插），自述 demo 级 + 已知局限 | **同类集成参考**（我们做同类功能的对标与教训） |
| m0g13r/luci-app-traffic-chart | 13 | - | - | netifyd/nf_conntrack 实时图表，兼容硬件卸载 | 与 R5C flowtable/SFE 共存的经验参考 |
| FlexQoS（dave14305） | - | GPL | 活跃 | ASUS Adaptive QoS 增强：iptables mark→class 映射、设备 IP+非 80/443→Gaming 启发式、游戏下载降级 | 三个启发式规则已确认要抄（v1.13） |
| Badgenyamultiplexer/pc-game-fps-doctor | 305 | MIT | 活跃 | Windows 侧游戏卡顿诊断（非路由器） | 不采用 |

## 落地结论（v1.13 修订）

1. **识别三级路线定稿**：L0 零依赖（端口表+UDP 小包高频启发式+ACK 优先）→ L1 DNS 域名分类（直接集成 cache-domains 数据，脚本化镜像上游周更）→ L2 可选 nDPI（官方包已验证在 feed 里，用户态每流前 N 包识别）
2. **数据维护策略**：cache-domains 上游跟踪（MIT 无传染风险）+ 自维护游戏端口表（ASUS 46 款种子 + 发行商公开文档持续补充），数据文件随 netsteer 版本发布
3. **不追内核态 DPI**：ndpi-netfilter/OAF 内核模块在 6.12 内核适配成本高且 cake 已吃 29% CPU；OAF 特征库版权隔离，只学格式不抄数据
4. **暂不用 netifyd**：官方仓库下架、生态萎缩，nDPI 生态更健康

## 未验证项

- ndpi-netfilter 在 6.12 内核的实际可编译性（未试编）
- netifyd 镜像仓库的代码完整性与签名库可用性（未拉取实跑）
- Microsoft Service Tags 当期 JSON 直链（落地页 JS 渲染，未解析）
- Steam SDR API 按 appid 拉取的实际返回结构（仅确认了参数要求）
