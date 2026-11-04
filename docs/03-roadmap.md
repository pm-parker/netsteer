# 路线图

## M1 — 内核应用层（先见效）
- [x] /etc/config/netsteer 默认配置
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
