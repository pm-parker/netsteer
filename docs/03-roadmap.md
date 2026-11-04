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
