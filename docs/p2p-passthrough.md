# P2P 直通（Fullcone 等效）实现实录

## 为什么官方 OpenWrt 25.12 做不出真 Fullcone
- fw4 官方无 `fullcone` zone 选项（`/usr/share/firewall4/main.uc` 与 `/sbin/fw4` 中 `fullcone` 出现 0 次）→ 该选项仅存在于 ImmortalWrt 等社区分支。
- 官方源无 `kmod-nft-fullcone`（11166 个包全查）→ 真 EIM Fullcone 需带外内核模块，跨内核版本维护成本高，且无法进 4 架构 CI 打包。

## 等效原理
Fullcone = 两半：
1. **出站保留源端口**（Endpoint-Independent Mapping）→ Linux masquerade 本来就保留（实测 .175 保留率 4487/4490 = 99%）。
2. **任意外部主机可经已映射端口连入**（Endpoint-Independent Filtering）→ 缺这半。

补第 2 半：给目标设备开 UDP 全端口入站 DNAT。两者合起来行为等同 Fullcone（外网实测呈现 DMZ 型 NAT）。

## 实现
- `files/usr/bin/netsteer-p2p`：on|off|status。管理 fw4 原生 redirect section（name=`netsteer-p2p-pass`），LuCI 防火墙页可见、随 fw4 重载持久。
- 绝对幂等：purge-all-then-recreate；删除按索引倒序（uci 删除会使 `@redirect[N]` 位移，正序删会漏）。
- 首装自愈：`ensure_section` 补建 `netsteer.p2p` uci 节（前端 uci set 依赖该节存在，否则报错弹窗）。

## 踩坑清单
| 坑 | 现象 | 正解 |
|---|---|---|
| `uci show firewall` section 名格式 | `firewall.@redirect[0]=redirect` → `cut -d. -f2` 得到 `@redirect[0]=redirect`（带后缀）uci get 全空 | 再切一次 `cut -d= -f1` |
| 同名多 section | find 只操作第一条，on 重复添加、off 删不净 | 列出全部同名 → 全部清除 → 重建唯一一条 |
| LuCI `ui.showModal(title, children, ...classes)` | 第三参是 CSS class 不是 closeable；传 true 无效且弹窗无关闭按钮 | 自己在 children 里放 `.right > button` 调 `ui.hideModal` |
| rpcd ACL 改完不生效 | 新 exec 权限被拒 | `/etc/init.d/rpcd restart`（reload 不重载 acl.d；session ACL 登录时快照） |
| 前端只改 badge 不改按钮 | 开关后按钮文案/输入框仍是旧值 | 整卡 `replaceWith(this.renderP2PCard(newSt))` 重渲染 |
| JS `&&` 链结尾是布尔比较 | `(st && st.ports && st.ports !== '-') \|\| def` 返回布尔 true → `.split is not a function` | 用三元 `? String(st.ports) : def` |
| exec JSON 解析 | `fs.exec` 返回 `{code,stdout,stderr}` | `JSON.parse(r.stdout.trim())`，失败 catch → null 静默降级 |

## 实测效果（R5C + 网心云 .175）
- DNAT 规则命中持续增长（7,884 包 / 1.21MB），conntrack 出现「外部主动 → WAN:端口 → DNAT → .175:同端口 → 原端口回包」的完整双向条目（回程 421KB）= 打洞成立。
- .175 走 mihomo 命中 0（配合 `nikki lan_access_control` 绕过）。
- 网心云客户端自检结果：**DMZ 型 NAT**（即 Fullcone 等效达成）。

## 剩余变量
- 上行超售（套餐 50M，实测 75–80M）：cake 排队 338ms、丢包 ~1600 万 —— NAT 形态已最优，传输质量仍受带宽挤压影响。
- 更进一步：目标设备启用 IPv6 = 真实公网可达，不依赖 NAT 形态。
