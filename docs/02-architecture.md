# NetSteer 架构（v1.17.5 定稿，2026-11-09）

面向市场的 OpenWrt 家庭网络加速插件：场景感知 + 智能调度 + SQM 整形。
中文市场优先（D19）；apk-only，OpenWrt 24.10+（D18）。

## 1. 技术栈

| 层 | 技术 | 约束 |
|---|---|---|
| 前端 | LuCI client JS（单文件 view/netsteer.js，零构建零框架） | LuCI view 基类 + Vantage 主题 token；`_()` 包裹待 po 化 |
| 后端 | POSIX ash 脚本 ×11（/usr/bin/netsteer-*） | busybox 兼容：awk 无 gawk 扩展、无 bash 数组 |
| 内核机制 | sysfs（IRQ affinity/rps/xps）、tc cake（SQM）、conntrack netlink、nftables/iptables（DSCP 标记与 P2P 直通） | nf_conntrack_acct=1 自动开；flow offload 冲突检测提示 |
| 数据 | 纯文本数据集 + sha256 manifest（jsDelivr CDN→GitHub raw→自定义镜像三级回退） | 数据热更新不发版（D11） |
| 打包 | apk（4 架构：aarch64/arm_cortex-a7/mipsel/x86_64） | CI 构建 + Release 分发；目标进官方 packages feed |
| 质量 | 单测 287（node 直跑 extractor）+ shell 测试 20（qos-awk 9 + feed 11）+ e2e 14（Playwright 真机） | 发版铁律：本地构建→真机 apk 终装→e2e 全绿→才 tag |

## 2. 分层架构

```
┌─ LuCI 三 Tab（客户端 JS）
│   总览（纯展示四格：场景/集中度/队列/转发链路）
│   智能模式（总开关+场景卡+设备加速+P2P 直通）
│   专家模式（IRQ/SQM/分核/审计）
│        │ fetch → ubus (uci.set/apply) + rpcd fs.exec（ACL 白名单）
│        ▼
├─ CLI 工具层（ash，11 个）
│   netsteer-qos      场景引擎宿主：观测面采样 + 判定 + SQM 档位应用 + bench
│   netsteer-feed     数据集热更新（sha256 校验/原子替换/自动回滚）
│   netsteer-apply    sysfs 应用（RPS/XPS/IRQ affinity，幂等+回读验证）
│   netsteer-irq      中断发现与亲和
│   netsteer-mode     档位切换（普通/游戏 DSCP CS4→cake video tin）
│   netsteer-p2p      P2P 直通（UDP 端口绕过整形）
│   netsteer-bench    出口延迟/吞吐基准（8s 窗口）
│   netsteer-detect   首装环境探测 / netsteer-audit 冲突审计 / check / netdev
│        ▼
├─ 内核与系统
│   tc cake 双向整形（diffserv3/4）· IRQ/smp_affinity · RPS/XPS/RFS
│   conntrack 表（netlink 采样）· dnsmasq 日志 · nft DSCP 标记
│        ▲
├─ init.d/netsteer（开机应用+预热探测）
├─ hotplug.d/iface/99-netsteer（pppoe 重拨自愈）
└─ /etc/config/netsteer（uci 持久化）+ /usr/share/netsteer/（数据集）
```

早期单层调度架构（v1.0，RPS/XPS/RFS 默认预设）已被上表完整包含，历史细节见 git 历史。

## 3. 场景感知引擎（核心差异化）

**观测面**（三通道 auto 选择，uci `netsteer.qos.dns_observer`）：
1. mihomo 连接表（在场则用，SNI 域名最准——增强通道）
2. **自研 conntrack 面**（主通道，v1.17.4）：`conntrack -L` netlink 采样
   （~1s/8k flows）+ dnsmasq reply 反查域名 + 仅 LAN 出站 flow；零代理依赖
3. dnsmasq 日志（降级兜底；被代理劫持 53 的环境拿不到域名，走 IP 段+端口）

**判定**（v1.18 已下沉后端：`/usr/share/netsteer/sense.awk` 独立引擎 + `netsteer-qos sense-daemon`
常驻 30s 轮询 + 防抖原子落盘 `/tmp/netsteer/sense.json`；**页面关闭判定不中断**，前端场景卡
优先读后端结果，缺失/过期回退本地判定——本地 senseClassify 保留为回退路径）：
- 四场景：视频/游戏/视频会议/下载 + 默认普通浏览
- 量门槛三档（D16，宁漏勿误）：域名连接 <32KB=保活不算证据；
  会议/STUN ≥64KB 双向；流媒体 ≥512KB 真实下行
- bulk "大下行=视频"证据限 80/443/1935 + 下行主导（v>u×10）
- 网盘 CDN 域名直判下载；2 采样窗防抖（后端防抖，前端不二次防抖）
- 设备排除（D14）：`netsteer.qos.sense_exclude` IP 列表，采样管道滤除
  （对外服务设备如网心云不再污染判定——已真机验证）
- 联动（D14）：`netsteer.qos.sense_linked=1` 时稳定档切换自动切档
  （gaming/work→latency，其余→standard；只接管 standard↔latency 区间，
  用户手选 p2p/throughput/steering/off 不覆盖——已真机双向验证）
- 已知边界：对外服务设备（网心云类）flow 层与看视频同构 → 设备排除根治（已落地）

## 4. 数据生态

| 文件 | 内容 | 源 |
|---|---|---|
| gamedomains.txt | 158 后缀/22 平台 | cache-domains (MIT) |
| gameips.txt / gameports.txt | IP 段 + 知名端口 | Valve SDR 官方 + 社区 |
| streamdomains.txt | 流媒体平台域名 | 自维护（中文生态优先：B站/腾讯/爱奇艺…） |
| downloadports.txt + JS 内置网盘域 | 下载端口 + 网盘 CDN | 实测（baidupcs/bcsp2p）→ 迁 feed 待办 |
| manifest.tsv | sha256 清单 | gen-manifest.py |

feed 更新链：repo data/ → jsDelivr CDN 主源 → GitHub raw 回退 → 用户自定义镜像（`netsteer.feed.url`）。

## 5. 质量与发版体系

- 单测：`node tests/unit/core.test.js`（extractor 双列表：WANT 数组 + eval export，
  新纯函数两处都加且必须是顶层 `function` 声明）
- e2e：Playwright 直连真机 LuCI（14 项，`ignore_https_errors`）
- 发版顺序铁律（v1.16.2 白屏事故后立）：本地构建候选 → 真机 apk 终装 → e2e 全绿
  → tag → 双推（Gitea 主仓 + GitHub 镜像）→ CI 绿 → Release 4 架构 → Release 产物终装复验
- md5 对账：以包内 JS 内容 md5 三方一致为准（CI 与本地整包 md5 必不同=构建环境差异）

## 6. 部署

- 开发在沙箱；真机 scp 推送 JS 即生效（LuCI 按时间戳拉新版）；发布走 CI apk
- 文件落 /www、/usr/share、/etc 三处；卸载 = 删文件 + uci drop（e2e 含装卸循环）

## 7. 路线总览

**已交付里程碑**（详见 03-roadmap.md）：
v1.0 IRQ/转发调度 → v1.3-1.9 LuCI+审计 → v1.10-1.12 SQM cake+bench → v1.13-1.15 游戏通道+平台识别+feed → v1.16 IA 重构 → v1.17 智能模式（场景卡/量门槛/自研观测面/文案治理）

**进行中路线**（市场视角，用户旅程排序）：

| 阶段 | 内容 | 市场逻辑 |
|---|---|---|
| P0 v1.18 | 首次使用向导（3 步可用）+ D13 校准并入向导 + D14 场景×档位联动（用户语言呈现+锁定卡+设备排除） | 装上就能用 + "智能"兑现 |
| P1 | 官方 packages feed 准入（英文 po）+ 环境矩阵验证（x86/DHCP/双版本/无代理链路）+ 硬件要求声明 | 可发现性 + 普适性 |
| P2 | soak 7×24 / issue 模板+netsteer-doctor / e2e 场景注入 / 域名迁 feed / 官网同步 | 信任基建 |
| P3 | 三架构真机 / conntrack 万级 flows / 定时自愈 | 机会主义 |

**已拍板不做**：ipk 双格式（apk-only）/ 观测面来源上 UI / nDPI（内存超预算）。
**策略**：中文市场优先（D19）——恩山/中文社区先行，中文平台生态=识别准确率主场。
