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


## v1.18+ 开发计划（2026-11-09 盘点定稿，缺口×原因×优先级）

产品现状基线：v1.17.5 — 三 tab IA / SQM cake+IRQ 分核+P2P 直通 / 场景识别（量门槛+自研观测面）/ feed 动态数据 / 4 架构 Release 产线（287 单测 + 14 e2e）。

### P0 — v1.18.0：场景×档位联动（D14）——兑现"智能"承诺
- [ ] 联动引擎：场景判定 → SQM 档位自动切换（防抖沿用 2 采样窗 + 场景消失自动回退）
- [ ] 场景锁定卡 UI：用户钉死某场景（识别错了/用户想强制游戏档时用）
- [ ] 设备级排除列表：网心云/NAS/挂 PT 设备从场景判定剔除（根治"无人在看却判视频"残余源）
- 原因：智能模式当前"看得见、不动作"——识别只显示不驱动任何行为，UI 的"动态优化"未兑现。
  这是产品立身之本（NetSteer=导向），且设备排除是误判问题的唯一根治路径（flow 层无解，见 D15 边界）。
- 验收：真机注入场景流量 → 档位自动切换 + UI 如实显示联动来源；排除设备后其流量不再影响判定。

### P1 — v1.19.0：通用性验证 + 线路校准（D13）
- [ ] 自研观测面普通家庭真机验证：无代理 OpenWrt（VM 或备用设备）端到端跑通 conntrack→dnsmasq 域名反查链路
- [ ] D13 线路校准：空载基线 → 双向压测 → 自动写 SQM 带宽参数（运行中延迟反馈动态收紧）
- 原因：①"无代理完整可用"是 v1.17.4 核心卖点但目前只是推断（自家 mihomo 在场+dnsmasq 被劫持，
  自研链路的域名维度从未真实跑通）——开源产品的可信度问题。②带宽数字目前手填，错填=整形全错
  （cake 有效性直接依赖准确带宽）；cFosSpeed 的 Calibrate 是其核心卖点，对标必须有。
- 验收：无代理环境场景识别有域名证据输出；校准后 SQM 参数与实测带宽一致且延迟达标。

### P2 — 质量与生态补全（随版本打包）
- [ ] e2e 场景注入：LAN 侧打标定流量 → 断言场景判定（当前 e2e 只验 UI 存在性）
- [ ] 网盘域名表迁 feed 数据文件（现硬编码 JS，新增源需发版）+ gameips 数据时效标注
- [ ] bench 空闲自动重测：busy 标注 → 错峰重测根治测量污染（现状只提示不解决）
- [ ] 官网同步 v1.12.4 → 当前（五个版本特性：三 tab/场景识别/自研观测面全缺）
- 原因：单项都小，但都是"知道没做好"的债——按顺手原则随最近版本打包清偿。

### P3 — 接受现状 / 机会主义处理
- mipsel/x86_64/armv7 三架构真机（CI 打包验证兜底，遇真实用户反馈再投入）
- conntrack 万级 flows 性能边界（等大流量环境反馈）
- 定时自愈（IRQ mask 漂移重应用，M3 遗留待拍板）
- 原因：投入产出比低或无复现环境，不主动排期。

### 已拍板不做（D18 等）
- ipk 双格式兼容（apk-only，24.10+）
- 观测面来源上 UI（仅 README/release-notes）
- nDPI 集成（D10 判死：内存占用超路由器预算）
