# 路线图

## M1 — 内核应用层（先见效）
- [ ] /etc/config/netsteer 默认配置
- [ ] netsteer-apply 脚本（幂等）
- [ ] init.d + hotplug.d 双保险
- [ ] 上机验证：sysfs 生效 + 重启存活 + /proc/softirqs 计数分布变化
- 验收：压测前完成部署，作为 flowtable 压测的前置调优

## M2 — LuCI 页面 MVP
- [ ] menu.d 注册（网络 → NetSteer）
- [ ] rpcd ACL
- [ ] view/netsteer.js：现值展示 + 掩码编辑 + 应用按钮
- [ ] Vantage 风格对齐（提取 vantage-theme CSS token，卡片化布局）
- 验收：手机+桌面双端浏览器可用，主题视觉一致

## M3 — 打磨
- [ ] 每核 softirq 实时条形图（/proc/softirqs 轮询）
- [ ] 预设一键：全核 / 收发分对 / 关闭
- [ ] 压测联动视图（吞吐×核负载对照，数据来自压测记录）
- [ ] 与 SQM 状态互显（当前 cake 档位）
