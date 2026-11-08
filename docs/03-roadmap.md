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
