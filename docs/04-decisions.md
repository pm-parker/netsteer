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
