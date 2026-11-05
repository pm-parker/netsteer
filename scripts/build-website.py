#!/usr/bin/env python3
# 生成 netsteer 官网单文件 HTML (图片 base64 内嵌)
import base64, os

IM = "/home/abc/.hermes/workspace/netsteer/docs/images"
def b64(f):
    return "data:image/png;base64," + base64.b64encode(open(os.path.join(IM,f),'rb').read()).decode()

ab_bench = b64("netsteer-ab-benchmark.png")
overview = b64("screenshot-overview.png")
mobile   = b64("screenshot-mobile.png")

html = """<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>NetSteer · OpenWrt 的整合网络加速方案</title>
<style>
  * { margin:0; padding:0; box-sizing:border-box; }
  :root {
    --ink:#10192E; --blue:#1D5AEA; --logo-blue:#1F6FEB;
    --body:#1F2937; --sub:#4B5563; --muted:#9CA3AF;
    --line:#E5E7EB; --btn:#0A0A0A; --btn-fg:#FFFFFF;
    --page:#FFFFFF; --card:#FFFFFF; --card-hi:#F6F9FF; --card-hi-line:#DCE4F8;
    --win-bg:#F5FBF6; --win-line:#CDE7D2; --win-t:#2F7A3D;
    --cost-bg:#FCF8F5; --cost-line:#F3E2D8; --cost-t:#A15C2B;
    --ghost-line:#D6DAE2;
    --hero-1:#0A1E52; --hero-2:#2262EE; --hero-3:#A8CBF8; --hero-4:#FFFFFF;
    --shadow: 0 12px 30px rgba(16,25,46,.08);
  }
  /* 手动主题优先于系统 */
  html[data-theme="dark"] {
    --ink:#E8EDF5; --blue:#6EA0FF; --logo-blue:#5B8DEF;
    --body:#C3CBD8; --sub:#98A2B3; --muted:#6B7684;
    --line:#232A34; --btn:#F2F5F9; --btn-fg:#0B1220;
    --page:#0E1116; --card:#151A21; --card-hi:#141C2B; --card-hi-line:#26364F;
    --win-bg:#111C15; --win-line:#22422B; --win-t:#6FBF83;
    --cost-bg:#1E1611; --cost-line:#3E2C1E; --cost-t:#D69357;
    --ghost-line:#2A323D;
    --hero-1:#050B18; --hero-2:#12347F; --hero-3:#1E4FA8; --hero-4:#0E1116;
    --shadow: 0 12px 30px rgba(0,0,0,.45);
    color-scheme: dark;
  }
  /* 未手动指定时跟随系统 */
  @media (prefers-color-scheme: dark) {
    html:not([data-theme]) {
      --ink:#E8EDF5; --blue:#6EA0FF; --logo-blue:#5B8DEF;
      --body:#C3CBD8; --sub:#98A2B3; --muted:#6B7684;
      --line:#232A34; --btn:#F2F5F9; --btn-fg:#0B1220;
      --page:#0E1116; --card:#151A21; --card-hi:#141C2B; --card-hi-line:#26364F;
      --win-bg:#111C15; --win-line:#22422B; --win-t:#6FBF83;
      --cost-bg:#1E1611; --cost-line:#3E2C1E; --cost-t:#D69357;
      --ghost-line:#2A323D;
      --hero-1:#050B18; --hero-2:#12347F; --hero-3:#1E4FA8; --hero-4:#0E1116;
      --shadow: 0 12px 30px rgba(0,0,0,.45);
      color-scheme: dark;
    }
  }
  html { scroll-behavior:smooth; }
  html, body { max-width:100%; overflow-x:clip; }
  body { overflow-wrap:break-word; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",Arial,sans-serif;
         background:var(--page); color:var(--body); -webkit-font-smoothing:antialiased;
         transition:background .25s ease,color .25s ease; }
  a { text-decoration:none; color:inherit; }

  /* ===== 导航 ===== */
  nav { height:88px; display:flex; align-items:center; justify-content:space-between;
        padding:0 clamp(24px,6vw,90px); background:var(--page); position:sticky; top:0; z-index:50;
        border-bottom:1px solid transparent; transition:background .25s ease; }
  .nav-l { display:flex; align-items:center; gap:44px; }
  .brand { display:flex; align-items:center; gap:11px; }
  .brand svg { width:30px; height:30px; }
  .brand .name { font-size:20px; font-weight:800; color:var(--ink); letter-spacing:.02em; }
  .nav-menu { display:flex; gap:44px; font-size:16px; color:var(--body); font-weight:500; }
  .nav-menu a:hover { color:var(--blue); }
  .theme-btn { width:38px; height:38px; border:1px solid var(--ghost-line); border-radius:10px; background:transparent;
               color:var(--sub); cursor:pointer; display:flex; align-items:center; justify-content:center; }
  .theme-btn:hover { color:var(--blue); border-color:var(--blue); }
  .nav-burger { display:none; width:42px; height:42px; border:1px solid #D6DAE2; border-radius:11px;
                background:#FFF; align-items:center; justify-content:center; cursor:pointer; }
  .nav-burger span { display:block; width:17px; height:2px; background:#111; border-radius:2px; position:relative; }
  .nav-burger span::before,.nav-burger span::after { content:""; position:absolute; left:0; width:17px; height:2px;
                background:#111; border-radius:2px; }
  .nav-burger span::before { top:-6px; } .nav-burger span::after { top:6px; }
  .nav-burger.x span { background:transparent; }
  .nav-burger.x span::before { top:0; transform:rotate(45deg); }
  .nav-burger.x span::after { top:0; transform:rotate(-45deg); }
  .nav-drawer { display:none; position:absolute; top:100%; left:0; right:0; background:var(--page);
                border-bottom:1px solid var(--line); padding:8px 24px 16px; box-shadow:var(--shadow); }
  .nav-drawer a { display:flex; align-items:center; justify-content:space-between; gap:12px;
                 min-height:48px; padding:13px 4px; font-size:16.5px; color:var(--body);
                 white-space:nowrap; border-bottom:1px solid var(--line); }
  .nav-drawer a:last-child { border-bottom:none; }
  .nav-drawer a .zh { color:var(--sub); font-size:14px; }
  .nav-drawer.open { display:block; }
  .nav-scrim { display:none; position:fixed; inset:0; background:rgba(6,10,18,.52); z-index:40; backdrop-filter:blur(2px); }
  .nav-scrim.on { display:block; }
  @media (max-width:860px){
    .nav-menu { display:none; }
    .nav-burger { display:flex; order:3; }
    nav { height:64px; }
    .nav-wrap { position:relative; display:flex; align-items:center; justify-content:space-between; width:100%; }
    .nav-l { gap:0; }
    .nav-r { gap:10px; }
    .nav-r > a span.hide-m { display:none; }
  }
  .nav-r { display:flex; align-items:center; gap:14px; }
  .nav-r a { font-size:16px; display:flex; align-items:center; gap:7px; color:var(--sub); }
  .nav-r a:hover { color:var(--ink); }

  /* ===== 内容列 ===== */
  main { max-width:1080px; margin:0 auto; padding:0 24px 120px; }

  .crumb { margin-top:64px; font-size:16px; color:var(--muted); }
  .crumb b { color:var(--sub); font-weight:500; }

  h1 { margin-top:22px; text-align:center; font-size:clamp(44px,6.5vw,68px); line-height:1.02;
       font-weight:900; color:var(--ink); letter-spacing:-.015em; }
  h1 .accent { color:var(--blue); font-style:italic; }
  h1 .suffix { font-size:24px; font-weight:400; color:var(--muted); margin-left:10px; }
  .tagline { margin-top:26px; text-align:center; font-size:clamp(18px,2.2vw,24px); color:var(--sub); font-weight:400; }

  .cta-row { margin-top:38px; display:flex; justify-content:center; gap:16px; flex-wrap:wrap; }
  .btn-primary { display:inline-flex; align-items:center; gap:9px; background:var(--btn); color:var(--btn-fg);
                 font-size:18px; font-weight:500; padding:17px 32px; border-radius:12px; transition:transform .15s ease, box-shadow .15s ease; }
  .btn-primary:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(10,10,10,.18); }
  .btn-ghost { display:inline-flex; align-items:center; gap:9px; color:var(--ink); font-size:18px; font-weight:500;
               padding:17px 30px; border-radius:12px; border:1px solid var(--ghost-line); transition:border-color .15s; }
  .btn-ghost:hover { border-color:var(--blue); color:var(--blue); }

  /* ===== Hero 点阵图 ===== */
  .hero-wrap { margin-top:52px; border-radius:16px; overflow:hidden; position:relative;
               width:100%; height:clamp(240px, 30vw, 360px);
               background: linear-gradient(180deg, var(--hero-1) 0%, var(--hero-2) 46%, var(--hero-3) 78%, var(--hero-4) 100%);
               transition:background .3s ease; }
  .hero-wrap canvas { position:absolute; inset:0; width:100%; height:100%; }

  /* ===== 正文章节 ===== */
  section { margin-top:104px; }
  h2 { font-size:clamp(28px,3.4vw,38px); font-weight:700; color:var(--ink); letter-spacing:-.01em; }
  .rule { margin-top:18px; border:none; border-top:1px solid var(--line); }
  section p.lead { margin-top:34px; font-size:19px; line-height:1.72; color:var(--body); }
  section p.lead b { color:var(--ink); font-weight:650; }
  section p.lead .n { color:var(--blue); font-weight:650; }

  /* 四能力卡 */
  .cap-grid { margin-top:40px; display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  .table-wrap { margin-top:38px; overflow-x:auto; -webkit-overflow-scrolling:touch; }
  .table-wrap table { margin-top:0; min-width:560px; }
  @media (max-width:640px){
    h1 { font-size:clamp(34px,10vw,48px); }
    h1 .suffix { display:block; margin-left:0; margin-top:8px; font-size:19px; }
    .crumb { margin-top:40px; font-size:14px; }
    .tagline { font-size:17px; }
    .cta-row { gap:12px; } .btn-primary,.btn-ghost { font-size:16px; padding:15px 24px; width:100%; justify-content:center; }
    .hero-wrap { margin-top:34px; height:210px; border-radius:12px; }
    section { margin-top:72px; }
    section p.lead { font-size:17px; }
    pre { font-size:13px; padding:18px 16px; }
    .duo { grid-template-columns:1fr; }
  }
  @media (max-width:760px){ .cap-grid { grid-template-columns:1fr; } }
  .cap { border:1px solid var(--line); border-radius:14px; padding:26px 26px 22px; background:var(--card); transition:border-color .15s, box-shadow .15s, background .25s; }
  .cap:hover { border-color:#C9D6F5; box-shadow:0 6px 22px rgba(29,90,234,.07); }
  .cap .idx { font-size:13px; font-weight:600; color:var(--blue); letter-spacing:.12em; }
  .cap h3 { margin-top:10px; font-size:20px; font-weight:650; color:var(--ink); }
  .cap p { margin-top:10px; font-size:15.5px; line-height:1.66; color:var(--sub); }

  .master-note { margin-top:34px; border:1px solid var(--card-hi-line); background:var(--card-hi); border-radius:14px;
                 padding:22px 26px; font-size:16px; line-height:1.7; color:var(--sub); }
  .master-note b { color:var(--ink); }

  /* 截图 */
  .shot { margin-top:38px; border:1px solid var(--line); border-radius:14px; overflow:hidden; background:#FFF; }
  .shot img { display:block; width:100%; height:auto; }
  .duo { margin-top:22px; display:grid; grid-template-columns:1.8fr 1fr; gap:22px; align-items:start; }
  @media (max-width:760px){ .duo { grid-template-columns:1fr; } }
  .caption { margin-top:14px; font-size:14.5px; color:var(--muted); text-align:center; }

  /* 数据表 */
  table { margin-top:38px; width:100%; border-collapse:collapse; font-size:16px; }
  th { text-align:left; font-size:14px; font-weight:600; color:var(--muted); letter-spacing:.06em;
       padding:12px 14px; border-bottom:1px solid var(--line); }
  td { padding:14px; border-bottom:1px solid var(--line); color:var(--body); }
  td.hl { font-weight:650; color:var(--blue); }
  td.dim { color:var(--sub); }

  /* 代码块 */
  pre { margin-top:34px; background:#1D1E20; border-radius:12px; padding:24px 28px; overflow-x:auto;
        font-size:14.5px; line-height:1.75; color:#C4C4C5; font-family:"SF Mono",ui-monospace,Menlo,Consolas,monospace; }
  pre .c { color:#9B9C9D; } pre .k { color:#8AADF4; } pre .s { color:#A6DA95; } pre .p { color:#ED8796; }

  /* 取舍表 */
  .trade { margin-top:38px; display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  @media (max-width:760px){ .trade { grid-template-columns:1fr; } }
  .trade .card { border-radius:14px; padding:26px; border:1px solid var(--line); }
  .trade .card { background:var(--card); }
  .trade .card.win { border-color:var(--win-line); background:var(--win-bg); }
  .trade .card.cost { border-color:var(--cost-line); background:var(--cost-bg); }
  .trade h3 { font-size:17px; font-weight:650; }
  .trade .win h3 { color:var(--win-t); } .trade .cost h3 { color:var(--cost-t); }
  .trade ul { margin-top:14px; list-style:none; }
  .trade li { font-size:15.5px; line-height:1.6; color:var(--sub); padding:7px 0 7px 22px; position:relative; }
  .trade .win li::before { content:"+"; position:absolute; left:2px; color:var(--win-t); font-weight:700; }
  .trade .cost li::before { content:"–"; position:absolute; left:2px; color:var(--cost-t); font-weight:700; }

  footer { border-top:1px solid var(--line); margin-top:110px; padding:44px 24px 60px;
           display:flex; justify-content:center; gap:40px; font-size:15px; color:var(--muted); flex-wrap:wrap; }
  footer a:hover { color:var(--ink); }
</style>
</head>
<body>

<nav>
 <div class="nav-wrap">
  <div class="nav-l">
    <a class="brand" href="#top">
      <svg viewBox="0 0 32 32" fill="none">
        <rect x="2" y="2" width="28" height="28" rx="7" fill="#1F6FEB"/>
        <path d="M9 12h14M9 20h9" stroke="#FFF" stroke-width="2.6" stroke-linecap="round" opacity=".95"/>
        <circle cx="23" cy="20" r="1.9" fill="#FFF"/>
      </svg>
      <span class="name">NetSteer</span>
    </a>
    <div class="nav-menu">
      <a href="#capabilities">Capabilities</a>
      <a href="#benchmark">Benchmark</a>
      <a href="#install">Install</a>
      <a href="#tradeoffs">Trade-offs</a>
    </div>
  </div>
  <button class="nav-burger" id="burger" aria-label="菜单"><span></span></button>
  <div class="nav-r">
    <button class="theme-btn" id="themeBtn" aria-label="切换深浅色" title="切换深浅色">
      <svg id="themeIcon" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>
      </svg>
    </button>
    <a href="https://github.com/pm-parker/netsteer" target="_blank">
      <svg width="19" height="19" viewBox="0 0 16 16" fill="#4B5563"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      GitHub
    </a>
  </div>
  <div class="nav-drawer" id="drawer">
    <a href="#capabilities">Capabilities <span class="zh">功能</span></a>
    <a href="#benchmark">Benchmark <span class="zh">实测</span></a>
    <a href="#install">Install <span class="zh">安装</span></a>
    <a href="#tradeoffs">Trade-offs <span class="zh">取舍</span></a>
    <a href="https://github.com/pm-parker/netsteer" target="_blank">GitHub <span class="zh">源码</span></a>
  </div>
 </div>
</nav>

<div class="nav-scrim" id="scrim"></div>
<main id="top">

  <p class="crumb">Product updates <span style="margin:0 8px;color:#D1D5DB">/</span> <b>2026 年 11 月 · v1.12.4</b></p>

  <h1>Net<span class="accent">Steer</span><span class="suffix">for OpenWrt</span></h1>
  <p class="tagline">一个总开关，两种网络体验 —— OpenWrt 的整合网络加速方案</p>

  <div class="cta-row">
    <a class="btn-primary" href="https://github.com/pm-parker/netsteer" target="_blank">
      <svg width="20" height="20" viewBox="0 0 16 16" fill="#FFF"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      GitHub ›
    </a>
    <a class="btn-ghost" href="https://github.com/pm-parker/netsteer/releases/latest" target="_blank">下载 Releases</a>
  </div>

  <div class="hero-wrap"><canvas id="hero"></canvas></div>

  <!-- 1. 引言 -->
  <section id="intro">
    <h2>1. 为什么需要它</h2>
    <hr class="rule">
    <p class="lead">
      家用宽带的真实痛点很少是「带宽不够」，而是：<b>一边下载，游戏和视频会议就卡成 PPT</b> —— 满载时延迟从
      <span class="n">5.8 ms</span> 飙到 <span class="n">70+ ms</span>（bufferbloat）；4 核软路由把收包全压在一个核上，
      千兆一跑满就丢包；P2P 应用因为 NAT 类型拿不到公网直连。
      <br><br>
      这些问题在 OpenWrt 上各有一个零散解法（SQM、RPS、fullcone…），但把它们<b>调对、联动、并证明真的有效</b>，
      需要读几十页论坛帖。NetSteer 把这一整套收进一个 LuCI 应用：<b>一键体检、场景模式、总开关，
      每个数字都是在你自己的设备上实测出来的。</b>
    </p>
  </section>

  <!-- 2. 能力 -->
  <section id="capabilities">
    <h2>2. 整合了什么</h2>
    <hr class="rule">
    <div class="cap-grid">
      <div class="cap">
        <div class="idx">01 · SQM</div>
        <h3>满载延迟整形（cake）</h3>
        <p>按你的上行带宽自动配置 cake 队列管理。满载下载时平均延迟 58.6 → 7.8 ms，p99 108 → 14 ms。游戏/会议不再被后台下载拖垮。</p>
      </div>
      <div class="cap">
        <div class="idx">02 · RPS</div>
        <h3>全核分摊收包</h3>
        <p>把单队列网卡的软中断摊到全部核心，消灭「一个核跑满、其他核看戏」。20 路并发下载实测持续吞吐 +17%。</p>
      </div>
      <div class="cap">
        <div class="idx">03 · NAT</div>
        <h3>P2P 直通（DMZ 型）</h3>
        <p>为指定设备提供 Fullcone 等效 NAT，游戏主机 / PT / 网心云类应用拿到公网直连能力，ICE 成功率显著提升。</p>
      </div>
      <div class="cap">
        <div class="idx">04 · UX</div>
        <h3>体检 · 场景 · 守卫</h3>
        <p>一键环境体检并给出两档方案（稳/激进）；游戏/下载/P2P 场景模式一键切换；依赖守卫防止其他包悄悄破坏配置。</p>
      </div>
    </div>
    <div class="master-note">
      <b>总开关：</b>关掉它，先自动测一组「关闭基线」；再打开，面板直接显示 <b>真实 A/B 增益</b>（延迟 ↓%、吞吐曲线 vs 基线点线）。
      不承诺固定数字 —— 空载时增益很小就如实显示「持平」，你的设备测出多少是多少。
    </div>
  </section>

  <!-- 3. 实测 -->
  <section id="benchmark">
    <h2>3. 实测：关 vs 开</h2>
    <hr class="rule">
    <p class="lead">
      NanoPi R5C（4×Cortex-A55）· 电信 1000M↓/50M↑。16 线程满载下载 30 秒 × 2 轮均值，下载进行中并发 ping：
    </p>
    <div class="shot"><img src="__AB_BENCH__" alt="NetSteer A/B 极限压测对比图"></div>
    <p class="caption">四面板：满载延迟（avg/p50/p99/max）、空载延迟、满载吞吐、延迟跨度 —— 全部指标如实呈现</p>
    <div class="table-wrap"><table>
      <tr><th>指标</th><th>OFF 基线</th><th>NetSteer ON</th><th>变化</th></tr>
      <tr><td>平均满载延迟</td><td>58.6 ms</td><td class="hl">7.8 ms</td><td class="hl">↓ 87%</td></tr>
      <tr><td>满载延迟跨度 (p99−p50)</td><td>56.4 ms</td><td class="hl">6.9 ms</td><td class="hl">↓ 88%</td></tr>
      <tr><td>空载延迟</td><td>5.79 ms</td><td class="dim">5.91 ms</td><td class="dim">基本持平</td></tr>
      <tr><td>满载吞吐</td><td>823 Mbps</td><td class="dim">581 Mbps</td><td class="dim">−29%（见取舍）</td></tr>
    </table></div>
  </section>

  <!-- 4. UI -->
  <section id="ui">
    <h2>4. 界面</h2>
    <hr class="rule">
    <div class="duo">
      <div class="shot"><img src="__OVERVIEW__" alt="NetSteer 总览仪表盘：总开关、网络路径、健康卡、吞吐曲线"></div>
      <div class="shot"><img src="__MOBILE__" alt="移动端布局"></div>
    </div>
    <p class="caption">总览仪表盘（左）与移动端（右）：面板内显示的 ↓9% 为空载实时抽测增益；满载极限数据见上节。深浅主题跟随 LuCI，触控热区 44px，悬停交互均有点按等价物</p>
  </section>

  <!-- 5. 快速开始 -->
  <section id="install">
    <h2>5. 快速开始</h2>
    <hr class="rule">
    <p class="lead">从 Releases 下载对应架构的 APK（aarch64 / x86_64 / arm_cortex-a7 / arm_cortex-a9），推到路由器安装：</p>
<pre><span class="c"># 沙箱/电脑 → 路由器（按架构选包）</span>
scp -O luci-app-netsteer-1.12.4-aarch64_generic.apk root@<span class="s">192.168.1.1</span>:/tmp/

<span class="c"># 路由器上</span>
apk add --allow-untrusted /tmp/luci-app-netsteer-1.12.4-aarch64_generic.apk

<span class="c"># 浏览器打开 LuCI → 服务 → NetSteer</span>
<span class="c"># 第一次进入会引导「一键体检」，随后按建议启用即可</span></pre>
    <p class="lead" style="margin-top:26px">依赖会在体检时自动检测：SQM 需要 <b>sqm-scripts + cake</b>，P2P 直通需要防火墙放行。
    缺什么、装什么、影响什么，界面上都会讲清楚 —— 从小白到专家调教用户都能各取所需。</p>
  </section>

  <!-- 6. 取舍 -->
  <section id="tradeoffs">
    <h2>6. 设计取舍（诚实版）</h2>
    <hr class="rule">
    <div class="trade">
      <div class="card win">
        <h3>你得到</h3>
        <ul>
          <li>满载延迟 ↓87%（58.6 → 7.8 ms），p99 ↓87%</li>
          <li>延迟确定性 ↑：跨度 56.4 → 6.9 ms，几乎无抖动</li>
          <li>P2P 设备公网直连能力</li>
          <li>全核分摊：多核利用率均衡，吞吐 +17%（单维度）</li>
        </ul>
      </div>
      <div class="card cost">
        <h3>你付出</h3>
        <ul>
          <li>满载吞吐 −29%（cake 在 4 核软转发上的整形开销）</li>
          <li>空载延迟 +0.1 ms 量级的微开销</li>
          <li>需要正确的上行带宽配置（体检会帮你测）</li>
        </ul>
      </div>
    </div>
    <p class="lead" style="margin-top:34px">
      判断标准很简单：<b>如果你的宽带速率远高于日常实际用量（大多数家庭如此），用延迟确定性换一点峰值吞吐是净赚。</b>
      总开关随时可关，关掉即恢复系统默认 —— 两侧的真实数字都会摆在你面前。
    </p>
  </section>

  <footer>
    <a href="https://github.com/pm-parker/netsteer" target="_blank">GitHub</a>
    <a href="https://github.com/pm-parker/netsteer/releases" target="_blank">Releases</a>
    <span>MIT License</span>
    <span>v1.12.4</span>
  </footer>
</main>

<script>
(function(){
  // 移动端菜单 (抽屉 + 遮罩)
  const bg=document.getElementById('burger'), dw=document.getElementById('drawer'), sc=document.getElementById('scrim');
  function closeNav(){ dw.classList.remove('open'); sc.classList.remove('on'); bg.classList.remove('x');
    document.body.style.overflow=''; }
  if(bg){
    bg.addEventListener('click', ()=>{ const on=dw.classList.toggle('open');
      sc.classList.toggle('on', on); bg.classList.toggle('x', on);
      document.body.style.overflow = on ? 'hidden' : ''; });
    sc.addEventListener('click', closeNav);
    dw.querySelectorAll('a').forEach(a=>a.addEventListener('click', closeNav));
    window.addEventListener('keydown', e=>{ if(e.key==='Escape') closeNav(); });
  }
  // 主题切换: localStorage 优先, 未设置则跟随系统
  const TB=document.getElementById('themeBtn');
  function applyTheme(t){
    if(t) document.documentElement.setAttribute('data-theme', t);
    else document.documentElement.removeAttribute('data-theme');
    const dark = t ? t==='dark'
      : window.matchMedia('(prefers-color-scheme: dark)').matches;
    const ic=document.getElementById('themeIcon');
    ic.innerHTML = dark
      ? '<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/>'
      : '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>';
  }
  let saved=null; try{ saved=localStorage.getItem('ns-theme'); }catch(e){}
  applyTheme(saved);
  TB.addEventListener('click', ()=>{
    const cur = document.documentElement.getAttribute('data-theme')
      || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
    const next = cur==='dark' ? 'light' : 'dark';
    try{ localStorage.setItem('ns-theme', next); }catch(e){}
    applyTheme(next);
  });
  // 点阵路由器 hero —— 把图形栅格化采样为圆点, 颜色随深度渐隐 (ERNIE halftone 手法)
  const cv = document.getElementById('hero');
  function render(){
    const W = cv.clientWidth, H = cv.clientHeight, DPR = Math.min(2, window.devicePixelRatio||1);
    cv.width = W*DPR; cv.height = H*DPR;
    const g = cv.getContext('2d'); g.scale(DPR,DPR); g.clearRect(0,0,W,H);
    // 离屏画路由器形状
    const off = document.createElement('canvas');
    off.width = W; off.height = H;
    const o = off.getContext('2d');
    const cx = W/2, cy = H*0.53;
    const bw = Math.min(W*0.26, 270), bh = bw*0.34;
    o.strokeStyle = '#fff'; o.fillStyle = '#fff'; o.lineWidth = Math.max(9, bw*0.055); o.lineCap='round';
    // 天线 (斜线)
    o.beginPath(); o.moveTo(cx-bw*0.34, cy-bh*0.52); o.lineTo(cx-bw*0.48, cy-bh*1.32); o.stroke();
    o.beginPath(); o.moveTo(cx+bw*0.34, cy-bh*0.52); o.lineTo(cx+bw*0.48, cy-bh*1.32); o.stroke();
    // 机身 (圆角矩形)
    const r = bh*0.26, x = cx-bw/2, y = cy-bh/2;
    o.beginPath();
    o.moveTo(x+r,y); o.arcTo(x+bw,y,x+bw,y+bh,r); o.arcTo(x+bw,y+bh,x,y+bh,r);
    o.arcTo(x,y+bh,x,y,r); o.arcTo(x,y,x+bw,y,r); o.closePath();
    o.lineWidth = Math.max(7, bw*0.045); o.stroke();
    // 信号点 (机身内 3 点)
    [-0.26, 0, 0.26].forEach((k,i)=>{
      o.beginPath(); o.arc(cx+bw*k, cy, bh*0.13, 0, 7); o.fill();
    });
    // 采样点阵
    const step = Math.max(6, Math.round(W/150));
    const img = o.getImageData(0,0,W,H).data;
    for(let py=step/2; py<H; py+=step){
      for(let px=step/2; px<W; px+=step){
        const a = img[((py|0)*W + (px|0))*4 + 3];
        if(a > 120){
          const depth = py/H;                     // 0 顶 → 1 底
          const alpha = 0.95 - depth*0.55;        // 自上而下渐隐
          g.beginPath();
          g.fillStyle = 'rgba(255,255,255,'+alpha.toFixed(3)+')';
          g.arc(px, py, step*0.30, 0, 7); g.fill();
        }
      }
    }
    // 漂浮粒子 (上密下疏)
    let seed = 42;
    const rnd = ()=> (seed = (seed*16807)%2147483647) / 2147483647;
    for(let i=0;i<70;i++){
      const px = rnd()*W, py = rnd()*H*0.62, s = rnd();
      if(rnd() < (0.5 - py/H*0.5)){
        g.beginPath();
        g.fillStyle = 'rgba(255,255,255,'+(0.16+s*0.36).toFixed(3)+')';
        g.arc(px, py, 1.1+s*1.9, 0, 7); g.fill();
      }
    }
  }
  render();
  let t; window.addEventListener('resize', ()=>{ clearTimeout(t); t=setTimeout(render,180); });
})();
</script>
</body>
</html>
"""

html = html.replace("__AB_BENCH__", ab_bench).replace("__OVERVIEW__", overview).replace("__MOBILE__", mobile)
out = "/home/abc/.hermes/workspace/netsteer-site.html"
open(out, "w").write(html)
print(out, os.path.getsize(out)//1024, "KB")
