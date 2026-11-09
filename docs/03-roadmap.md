# 路线图

## M1 — 内核应用层（先见效）
- [x] netsteer-detect 首装自动生成配置（无默认硬编码, 第 i 物理口中断→C(NCPU-1-i) 错开）
- [x] netsteer-apply 脚本（幂等 + 写后回读验证）
- [x] init.d + hotplug.d 双保险
- [x] 上机验证：sysfs 生效 + 重启存活 + /proc/softirqs 计数分布变化
- 验收：压测前完成部署，作为 flowtable 压测的前置调优

## M2 — LuCI 页面 MVP ✅ 已部署 (2026-11-04)
- [x] menu.d 注册（服务 → NetSteer 转向加速）
- [x] rpcd ACL
- [x] view/netsteer.js：现值展示 + 掩码编辑 + 应用按钮
- [x] Vantage 风格对齐（提取 vantage-theme CSS token，卡片化布局）
- 验收：真机渲染通过（用户确认菜单+页面正常）
- 踩坑记录：menu.d JSON 顶层 key 必须挂 `admin/...` 树；根命名空间节点 = 免登录直通 + 永不进侧边栏（见 04-decisions D6）

## M3 — 打磨（部分随 M2 交付）
- [x] 每核 softirq 条形图（/proc/softirqs）
- [x] 预设一键：全核 / 收发分对 / 关闭
- [ ] 压测联动视图（吞吐×核负载对照，数据来自压测记录）
- [ ] 与 SQM 状态互显（当前 cake 档位）
- [ ] 定时自愈（校验运行时 mask 与 uci 一致，漂移自动重应用）— 待拍板

## M4 — v1.3/v1.4 修复与 UI 改版 ✅ 已部署 (2026-11-04, 0c9a47a / 2be1412)
- [x] 修预设按钮无效（createHandlerFn 参数契约）+ 当前模式徽标 + sysfs 读取 ACL
- [x] UI 全量跟随 Vantage 主题（深浅自适应）+ 软中断分布改 Memory 卡风格 + 文案价值化 + 去自动 footer

### LuCI 视图开发坑（v1.3/v1.4 实测，改 UI 前先读）
1. **createHandlerFn 契约**：`ui.createHandlerFn(this, 'fn', 'arg')` 经 L.bind 预绑定，调用形如 `fn('arg', ev)`——事件对象恒在最后。签名写成 `fn(ev, name)` 时 name 收到的是 PointerEvent（查表 undefined 静默退出）=「点击没反应」根因。正解：handler 只收 `ev`，从 `ev.currentTarget` 读 `data-*` 属性，不依赖参数顺序。
2. **rpcd ACL 按真实路径校验**：`file read /sys/class/net/eth0/...`（软链）会被 realpath 解析后匹配白名单，`/sys/class/net/*` 形态永远 403（错误码 6，静默）。白名单必须补 `/sys/devices/platform/*/net/*/queues/*/*` 与 `/sys/devices/virtual/net/*/*` 形态。
3. **主题变量运行时层级**：生效的是 `/luci-static/vantage/vantage.css` 的 `:root` 基础层（`--bg/--s1..s4/--line/--text../--accent/--ok/--warn/--err/--info/--r/--fs-*/--sp-*/--mono`）+ `--v-*` 别名层（`--v-chart-1..5` 图表色深浅自动切）。`resources/vantage/app.css` 里的 `--vt-*` 前缀是未加载资源，按它写 CSS 全部落空。视图样式零硬编码色值，深浅模式即自动适配。
4. **View 基类自动 footer**：`View.__init__` 无条件 `addFooter()`，且基类原型自带 `handleSave/handleSaveApply/handleReset`，所以所有 client view 页面右下都会渲染 Save & Apply 按钮组（即时生效型页面不需要）。视图内覆盖 `addFooter: function() { return E([]); }` 即消除。
5. **uci 封装层勿用**：`uci.save/apply` JS 封装（unload/reload 全家桶）与 `rpc.declare` 在本环境实测挂起；用裸 `fetch('/ubus/')` 直调 `uci.set→apply{rollback:true}→confirm` + `fs.exec` 全程 ~0.2s。注意 uci.apply 前若存在**其他 config 的陈年 staged**（如 firewall），apply 会连带触发 fw4 reload 造成卡顿——排查时先 `uci changes` 看全局。
6. **部署缓存**：改 netsteer.js 后 scp 覆盖即生效（LuCI 按 `?v=` 时间戳拉新版），验证必须真浏览器深浅两态截图，不可只看 DOM。

## M5 — IRQ 亲和调度 ✅ 已部署 (2026-11-04)
- [x] netsteer-apply 扩展: msi_irqs 动态发现 IRQ 号 (跨启动不变依赖) + smp_affinity 写后回读判成败 + /tmp/netsteer/state.json 状态输出
- [x] A/B/C 压测定型 (20 并发 22s WAN 突发, NET_RX 增量分布):
  - A 现状 eth0中断→C1: [10.1, 31.9, 48.5, 9.5] 集中度 48.5%
  - B eth0→C3: [9.8, 7.0, 43.0, 40.2] 集中度 43.0% ✅ 定稿
  - C eth0→C3+eth1→C1: [9.2, 47.1, 9.8, 33.9] 集中度 47.1%
- [x] 定稿: eth0 IRQ→CPU3 (mask 8), eth1→CPU2 (mask 4); pairs 预设 IRQ 摆对内 (eth0→C1, eth1→C3, 未实测)
- [x] UI: 接口卡加「中断应门 (IRQ)」行 (radio 单选, pppoe 虚拟口无), 徽标匹配纳入 IRQ, preset 切换联动
- [ ] 整机重启后 IRQ 号重发现持久化验证 (待下次重启顺带)
- 踩坑: msi_irqs/ 下文件名才是 IRQ 号, 文件内容是中断类型字符串 ("msix"); 20 并发压测时 NET_RX 集中度下限 ≈ WAN 流量占比 (单队列物理瓶颈)
## v1.13 — 游戏设备优先通道 ✅ 已交付 (2026-11-08)
- [x] A：设备级优先通道（DSCP CS4 → diffserv4 video tin，双向标记，幂等，hotplug 自愈）
- [x] B：出口延迟曲线（8s probe 采样，5 分钟滚动 sparkline）
- [x] C：SQM 状态互显（五态徽标诚实降级 + 整形实况 + 双向分桶表）
- [x] 质量门：单测 177 / e2e 12 项全绿 / 4 架构 apk verify / 真机装卸循环
- [x] L1：DNS 分类接 cache-domains（MIT，36 厂商域名）— v1.14 已交付
- [x] L2：识别增强层 — v1.15 已交付（nDPI 路线判死，IP 段+端口启发式替代，见 D10）

## v1.14 — 游戏平台识别 + 环境自适应 ✅ 已交付 (2026-11-08)
- [x] L1 平台识别：cache-domains 数据集（158 后缀/22 平台）+ 前端分类（路由器零负担）
- [x] 观测面环境自适应：代理内核（Nikki/OpenClash/clash 系 API 探测）→ 连接表嗅探；裸路由器 → dnsmasq 查询日志（UI 一键开关）；都没有 → 如实不可用
- [x] 出口探测目标自适应：WAN 网关优先，回退公网 DNS；延迟曲线标注所用目标
- [x] DHCP 主机名启发式 → 疑似游戏设备 chips 一键回填
- [x] 开机后台预热探测结果（init.d），UI 首开零等待
- [x] 通用化原则落地：不绑定特定代理品牌/网段/地区 DNS，全部探测式（用户要求：适合各种家庭网络环境）
- [x] 质量门：单测 215 / e2e 13 项全绿 / 4 架构 apk verify
- 待办：L2 nDPI 可选软依赖

## v1.15 — L2 识别增强层（IP 段 + 端口启发式）✅ 已交付 (2026-11-08)
- [x] nDPI 路线判死：25.12 feed 的 libndpi 只有 .so 库、无 ndpiReader CLI；用库需自编二进制 × 4 架构分发，违反 D2 零二进制依赖（见 D10）
- [x] 替代路线 = 纯数据文件，对症 L1 盲区（裸 IP 直连、无 SNI/DNS 名字）：
  - gameips.txt：Valve 官方 SDR API 实拉 relay IP 归并 + AS32590 共识段（6 宽段 + 19 合作 POP /24），steam 类别
  - gameports.txt：3074（Xbox/PSN 官方 NAT 端口）console 类、3480/tcp PSN、27015-27050/udp + 27036-27037/tcp Steam
  - 3478-3479 刻意不收（STUN/TURN 通用端口，误判率高）——透明注释写在文件里
- [x] 采样升级：dnslog 每条带 d(目的地 IP)/p(端口)/t(协议)；裸 IP 连接不再丢弃
- [x] 前端三级识别链：域名(name) → IP 段(ip) → 端口(port)，明细行显示识别来源
- [x] buildIpMap/classifyIp/buildPortMap/classifyPort 纯函数（最长前缀匹配 + 容错）
- [x] 质量门：单测 242 / e2e 13 项 / 4 架构 apk verify / 真机端到端（裸 IP 连接采样实锤）
- 边界：IP 段/端口三级仅代理内核观测面可用（dnsmasq 查询日志无目的地信息）；UDP 测试流量无法从沙箱构造进连接表（relay 拒收），UDP 场景由 destinationIP 字段实锤 + 单测覆盖


## v1.16 — 场景感知引擎 + 数据远程动态更新 ✅ 已交付 (2026-11-08)
- [x] 场景感知 (D12, 对标 cFosSpeed 场景模式/bulk_detect): 每场景独立判定逻辑 + light/heavy 轻重分析 (Steam 商店下载≠对局) + 打分制 (gaming>work>streaming>download) + 防抖状态机 (连续 2 窗口) + 证据链可解释
- [x] 数据动态更新 (D11): streamdomains.txt + downloadports.txt 两新数据集; netsteer-feed 四命令 (status/check/update/rollback); jsdelivr→GitHub raw→自定义源三级回退; sha256 清单 + 原子替换 + 失败保留现状; 数据热生效零重启
- [x] dnslog 采样扩 u/v 体积字段 (mihomo 连接表 upload/download 计数) — light/heavy 判据数据面
- [x] 质量门: 单测 273 (+31) / feed shell 测试 11 (CI 新增) / e2e 14 (场景卡真机断言) / 4 架构 verify / 真机终装
- 边界: 场景感知依赖 mihomo 连接表 (dnsmasq 观测面无体积信息, 降级为域名证据); 数据源完全接管场景 sha256 无法防 (威胁模型=CDN 损坏/传输错误)
- v1.17 路线 (已立决策 D13/D14): 线路校准 (空载→双向压测→自动写 SQM) + 场景×档位联动


## v1.18+ 开发计划（2026-11-09 修订版：市场产品视角——按用户旅程排期，非自家功能补全）

旅程框架：**发现 → 安装 → 首次使用 → 日常价值 → 留存/信任 → 反馈**。
产品现状基线：v1.17.5。视角声明：面向市场的 OpenWrt 插件，用户是陌生家庭路由器使用者，
不是本项目的开发者。修订动因：首版计划（同日 7f5e892）按"自家缺什么功能"排序，
漏了 onboarding/可发现性/环境普适性三条市场生命线。

### P0 — v1.18.0：市场 MVP = 装上就能用 + 智能兑现
- [ ] **首次使用向导**：安装后首次打开 → 3 步内可用（①自动探测线路带宽/上网方式 ②展示推荐配置
  （一句话人话解释）③一键开启）。完成后才进完整界面。
  原因：当前默认 disabled + 全功能三 tab 界面，陌生用户第一眼是配置负担不是价值——留存生死线。
- [ ] **D13 校准并入向导**：向导内自动跑校准（空载基线 + 30s 双向压测 → 写 SQM 带宽），
  替代手填。校准与 onboarding 是同一件事，拆开做两次都是浪费。
  原因：带宽错填=整形全错；且"手填带宽数字"对市场用户是不可理解的门槛。
- [ ] **D14 场景×档位联动**：识别 → 自动调整（2 采样防抖 + 场景消失回退），联动状态用用户语言
  呈现（"看视频时自动优化视频流量"，不出现"档位"术语）；场景锁定卡；设备级排除列表
  （网心云类设备剔除，误判唯一根治路径）。
  原因：核心卖点兑现——不联动则产品只是监控面板。
- 验收：全新安装（清配置）→ 向导 3 步 → 开箱即有加速效果；注入场景流量档位自动切；
  排除设备后其流量不影响判定。

### P1 — 可发现性 + 普适性（市场覆盖）
- [ ] **官方软件源准入**：向 OpenWrt packages feed 提 luci-app-netsteer + 英文 po 翻译文件
  （feed 的 i18n 硬要求；_() 已包裹，补 po/lmo 即可）。
  原因：GitHub Release 只覆盖主动搜索者；官方源 = 被市场发现的唯一大通道（apk/opkg 直装）。
- [ ] **环境矩阵验证**：x86 软路由（最大用户群）/ DHCP 上网（非 PPPoE）/ 100M–1000M 不同带宽 /
  OpenWrt 24.10 与 25.x 双版本 / 无代理自研观测面链路（原 P1 验证项并入）。
  原因：全部发布验证只在这 1 台 R5C（ARM/aarch64/PPPoE/1000M/mihomo 在场）做过——
  单环境产品不是市场产品。
- [ ] **硬件要求声明**：实测 conntrack 解析峰值内存 + awk 临时文件占用 → README 推荐/最低配置表。
  原因：用户不知道自己设备跑不跑得动 = 装完失败差评。

### P2 — 信任基建（质量债随版本清偿）
- [ ] soak test：7×24 连续运行（内存曲线/日志体积/conntrack 轮询开销）——路由器产品生死项
- [ ] 反馈闭环：GitHub issue 模板 + `netsteer-doctor` 一键诊断命令（用户报障附输出，含版本/环境/观测面状态）
- [ ] e2e 场景注入：LAN 侧标定流量 → 断言场景判定（现 e2e 只验 UI 存在性）
- [ ] 网盘域名迁 feed + gameips 时效标注；bench 空闲自动重测
- [ ] 官网同步 v1.12.4 → 当前 + 竞品对比表（vs luci-app-sqm / 商业加速插件）
- 原因：单项小，但都是"知道没做好"的债；信任类问题（soak/反馈）优先于锦上添花。

### P3 — 接受现状 / 机会主义
- mipsel/x86_64/armv7 三架构真机（CI 兜底 + P1 环境矩阵部分覆盖后视反馈投入）
- conntrack 万级 flows 性能（等大流量环境反馈）；定时自愈（M3 遗留待拍板）；压测联动视图（M3 遗留）

### 已拍板不做（D18/D10）
ipk 双格式（apk-only 24.10+）/ 观测面来源上 UI / nDPI。

### 待用户拍板
- **语言市场策略**：中文市场优先（恩山/OpenWrt 中文社区先行，英文 po 仅满足 feed 准入）
  vs 国际优先（完整英文化+英文社区运营）——影响 P1 之后的营销与文档投入方向。
