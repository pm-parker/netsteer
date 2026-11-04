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
