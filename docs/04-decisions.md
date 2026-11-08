# 决策记录

## D1：做成 LuCI 原生应用（ucode），不是独立网页
- 用户要求"前端风格参考 Vantage、显得高级"——LuCI 内嵌页面自动继承 Vantage 主题，视觉一致零成本
- 独立网页则要手工复刻主题，且脱离菜单/权限体系
- 代价：视图用客户端 JS（LuCI 现代模式，参考 luci-app-sqm 实现路径）

## D2：后端用 ash 脚本 + uci，不引入 python/依赖
- 路由器无 python3；apply 逻辑是纯 sysfs 写入，ash 足够
- 零依赖 = 无供应链风险、apk 生态变化免疫（复盘教训）

## D3：持久化 = uci + init + hotplug 三层
- sysfs 值重启即丢；pppoe-wan 是动态设备，重拨后队列重建
- hotplug.d/iface 触发保证 PPPoE 拨上来自动重应用

## D4：RPS 默认全核（f）而非老系统的分对
- 老系统分对（eth0→0+1, eth1→2+3）是为 cache 局部性；但配了 RFS（同流同核）后局部性由 RFS 保证，全核分摊吞吐更优
- 分对保留为预设选项，压测可比对两种模式

## D5：UPnP 设备白名单走 uci perm_rule int_addr
- 实测 init 的 conf_rule_add 支持 int_addr 字段 → 原生设备级 ACL，无需防火墙挡 SSDP
- 白名单：微服 .123 / 摄像头 .187 / 网心云 .175
- miniupnpd init 无 respawn 是自启失败的病根 → 补 respawn 参数

## D6：menu.d JSON 顶层 key 必须挂 admin/ 树（2026-11-04 真机事故）
- 症状：根命名空间节点（"luci-app-netsteer-main"）→ 免登录直通渲染 + 成为 firstchild 兜底 + 永不进侧边栏，用户访问 192.168.11.1 直接落单页无菜单
- 机理：LuCI ucode dispatcher 只对 `admin/...` 前缀节点做登录墙；acl.d 的顶层 key（如 "luci-app-netsteer"）是 ACL 组名，与菜单路径无关，depends.acl 引用的是组名
- 修正：单页 app 用 `"admin/services/netsteer"` 单节点 + depends（acl + uci），无需 firstchild 包装
- 附带教训：`node --check` 只保语法，this 绑定丢失（map 回调里 createHandlerFn(this,...)）和 menu 挂载错误这类运行时/结构错误必须真机渲染验证；LuCI session 绑定创建者 IP，从 CLI 建的会话无法给别的 IP 的浏览器用

## D7：游戏通道 = 设备级 DSCP CS4 → cake diffserv4 video tin（2026-11-08）
- 逆向厂商固件（TP-Link GE800 GPL / ASUS RT-AX86U）结论：DPI 清单拿不到也不值得追（加密+按机型授权，明文部分过时十年）；自建透明数据文件更优
- 识别三级路线：L0 端口/启发式（零依赖）→ L1 DNS 分类（uklans/cache-domains，MIT）→ L2 nDPI 可选软依赖；不做内核态每包 DPI（R5C 4×A55 上 cake 已吃 29% 吞吐）
- 实现：设备 IP nft 双向标记（forward egress 改写 + inet ingress 钩子改写）；sqm 脚本薄包装切 diffserv4 + ack-filter；关闭自动还原 simple.qos；幂等 reapply + init.d/hotplug 双挂自愈
- 教训：rpcd ACL 必须放行新二进制 exec——UI fs.exec 未白名单 = 静默 403 且难定位；已加单测（ACL 与 fs.exec 一致性）防回归
- 实测边界：cake 流隔离在开/关两态都把满载 ping 压在 ~6ms，通道增益 = 带宽份额（2.47×）非延迟；四桶调度 +0.7ms 开销如实标注

## D8：L1 平台识别 = mihomo 连接表采样（dnsmasq log-queries 判死）（2026-11-08）
- 实测：本机 DNS 全链被 mihomo 接管（LAN/本机 nslookup 均返回 fake-ip），dnsmasq 是旁观者——log-queries 永远观测不到查询（三次实测 0 条查询日志，重启 dnsmasq 无济于事）
- 改用 mihomo `/connections` API：每连接自带 sniffHost（SNI 嗅探，TLS 443 全覆盖），零配置零日志开销，与 DNS 是否加密无关；快照只含活跃连接，短连接可能漏——观测边界，如实写在 UI 上
- 分类在前端完成：netsteer-qos dnslog 只采样（sourceIP RFC1918 过滤 + sniffHost 回退 host），LuCI 读 /usr/share/netsteer/gamedomains.txt（cache-domains MIT 策划集 + 上游已移除通配行的平台补裸后缀）后做最长后缀匹配——路由器零分类成本
- DHCP 主机名启发式（ps/xbox/switch/steam…）出「疑似游戏设备」chips 一键回填 IP，真机命中 2 台 Xbox
- e2e 教训：注入式 UI 元素（建议 chips）会劫持 `.netsteer-minibtn` first 选择器——交互目标必须给稳定 id（#netsteer-game-toggle）

## D9：通用家庭方案 = 探测式环境自适应，不做环境假设（2026-11-08，用户拍板）
- 用户要求：不只为自己家设计，要适合各种家庭网络环境，并根据环境矛盾自动调整
- 实现原则：凡是依赖"某环境某组件存在"的能力，一律运行时探测（API 存活为准，不是看配置文件存在），探测结果缓存在 uci（netsteer.qos.dns_observer / probe_target），init.d 开机预热 + status 首调自举
- 探测矩阵：代理内核 Nikki(/etc/nikki/run/config.yaml) → OpenClash(uci cn_port/dashboard_password) → 裸 clash 9090 → 无；DNS 观测面 = 有代理内核 → 连接表嗅探 / 无代理 → dnsmasq 查询日志(UI 一键开关 dns-en，会重启 dnsmasq ~1s) / 都没有 → 诚实不可用；出口探测 = WAN 网关优先(ip route show default)，不可 ping 回退 223.5.5.5
- 勘误教训：两个观测面看到的是互补子集——mihomo 通道覆盖 TLS 连接（SNI），dnsmasq 通道覆盖明文查询（含绕过 fake-ip 劫持的直连 DNS 设备）；任何一方都不是全集，UI 按态如实标注边界
- 运维坑：路由器是 busybox，没有 coreutils `install` 命令（`install -m 755` 静默走 old 文件）——部署用 `cp + chmod`；/tmp/netsteer 是状态目录，scp 单文件推 init.d 撞名失败
- 单测基线 177 → 215（dnsObserverMeta 四态 + 兼容回退 + null 安全）

## D11：数据远程动态更新 = repo data/ + jsdelivr CDN 主源，sha256 清单原子替换（2026-11-08，用户需求"数据部署在服务器/CF/GitHub，刷新后用户动态拉取"）
- 分发模型：数据文件（gamedomains/gameips/gameports/downloadports/streamdomains）随包内置保底，同时发布到 repo `data/` 目录 + `data/manifest.json`（version/generated_at/files{name:{sha256,size}}）
- 源优先级：jsdelivr CDN（cdn.jsdelivr.net/gh/pm-parker/netsteer@main/data/，国内可达好）→ raw.githubusercontent.com → uci `netsteer.feed.url` 自定义源（用户可指向自建镜像）。多源依次回退，全挂如实报错不硬刷
- 更新流程（netsteer-feed update）：拉 manifest → 对比本地 sha256 → 逐文件下载 /tmp → sha256 校验 → 校验全过才原子 mv 替换（.bak 留旧版）→ 任一步失败保留现状；rollback 一键回退。数据文件每次调用现读，热生效零重启
- 宁缺毋假原则沿用 D10：manifest 只收录有官方来源的数据；无源可验证的条目不进远程通道

## D12：场景感知引擎 = 连接表采样 + 每场景独立判定逻辑 + light/heavy 分析（2026-11-08，对标 cFosSpeed 场景模式/bulk_detect）
- 分层：既有 5 档位（均衡/P2P/极速/低延迟/纯分核）是 QoS 架构层不动；新加场景层（gaming/streaming/work/download/normal）回答"用户此刻在干什么"，驱动档位内参数微调与推荐
- 判定数据面 = mihomo /connections 快照（SNI 嗅探 + upload/download 计数 + 目标 IP/端口），复用 D8 通道，零新增开销
- 每场景独立判定逻辑（netsteer-sense，规则可被新数据文件直接增强）：
  - gaming = 三级链命中（域名/IP段/端口）且该连接 light（累计 down < 5MB 或 down/up < 20）
  - streaming = streamdomains 命中，或单连接持续大下行（down > 50MB）
  - work = STUN/WebRTC 特征（UDP 3478-3479 双向）或会议域名（zoom/teams/meet）
  - download = downloadports 命中，或游戏平台域名下 heavy 流（命中游戏域名但 down > 50MB——平台商店下载不是游戏对局，这是 cFosSpeed light/heavy 分析的对症移植：防"Steam 下载"误进快车道）
  - normal = 无显著特征
- light/heavy 判据（bulk_detect 对应物）：单连接 down > 5MB 且 down/up > 20 → heavy；证据里明确标注每条连接的 light/heavy 与命中来源，判定可解释
- 防抖：连续 2 个采样窗口同判定才切换场景（hysteresis），状态带 since 时间戳；判定函数纯数据进纯数据出（可单测）

## D13：线路校准 = 空载基线 → 双向压测 → 写 SQM，运行中延迟反馈动态收紧（2026-11-08，对标 cFosSpeed Calibrate/online calibration）（v1.17）
- 安装后向导触发：空载 ping 基线（20 次取中位）→ 下行压测（国内镜像大文件多轮取稳定值，探测式选源：腾讯镜像→阿里镜像）→ 上行压测（候选端点探测，无可达源回退 uci wan 速率/手填并如实标 measured:false，宁诚实不造假）
- 应用：SQM 整形值 = 实测 × headroom（默认 95%），用户确认才写（不静默改用户配置）
- online calibration（adapt，cron 周期）：基线延迟恶化超阈值 → cake bandwidth 收 3%（下限 85% 校准值）；持续空闲零恶化 → 放 2%（上限 98%）——cFosSpeed maxdelay/variance 思想的 cake 版
- 中国家庭现实约束：测速源必须国内直连可达（走代理测的是隧道带宽不是线路），探测式多源是 D9 原则的延伸

## D14：场景 × 档位联动（2026-11-08）（v1.17）
- auto 场景模式：sense 判定 → 档位内参数微调（gaming → 游戏通道自动开启+低延迟整形；download → headroom 放宽；streaming → video tin 保权重；work → 保持低延迟+不收紧）
- manual 锁定优先于 auto；auto 切换必须 UI 可见（证据卡），不静默改变用户网络行为
- UI：场景横条卡（当前场景+证据+置信度+一键锁定/auto）+ 数据源状态行（数据版本/日期/检查更新按钮）

## D10：L2 识别增强 = IP 段 + 端口启发式，nDPI 库路线判死（2026-11-08，用户拍板"执行 L2"）
- 判死依据：25.12 packages feed 的 libndpi-5.0-r1 只含 `usr/lib/libndpi.so`（apk info -L 实测），无 ndpiReader CLI（官方 Makefile 不编 examples）；要用库只能自己交叉编译工具 × 4 架构随插件分发——违反 D2（零二进制依赖）且版本维护重
- 替代路线对症 L1 真实盲区：裸 IP 直连（游戏 relay 无 SNI）+ 无 DNS 名字。纯数据文件零依赖零抓包，分类照旧在前端
- 数据源分级（可靠性优先，宁缺毋假）：steam = Valve 官方 SDR API 实拉（GetSDRConfig appid=730，220 relay 归并 6 宽段 + 19 合作 POP /24）；console = 3074 官方 NAT 端口；psn = 3480/tcp；3478-3479 不收（通用 STUN 误判）；Xbox/PSN/Epic 官方 IP 段不公开 → 不造假数据，UI 如实显示覆盖范围
- 实现要点：dnslog 采样加 d/p/t 字段（destinationIP/destinationPort/network，mihomo metadata 实测 destinationPort 是字符串）；q 为空但 d 有值的裸 IP 连接不再被丢弃；前端 buildIpMap 最长前缀匹配（mask 整数化）
- 真机验证：TCP 到 relay 的裸 IP 连接进采样（d=155.133.248.36 无 q），UDP destinationIP 字段有值实锤（124.239.232.102）；沙箱构造的 UDP 测试包 relay 拒收进不了表——游戏 UDP 场景以字段实锤+单测覆盖，不虚报端到端
- 单测基线 215 → 242
