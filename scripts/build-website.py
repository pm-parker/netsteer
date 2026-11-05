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
    --line:#E5E7EB; --btn:#0A0A0A;
    --hero-1:#0A1E52; --hero-2:#2262EE; --hero-3:#A8CBF8; --hero-4:#FFFFFF;
  }
  html { scroll-behavior:smooth; }
  body { font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Noto Sans SC",Arial,sans-serif;
         background:#FFF; color:var(--body); -webkit-font-smoothing:antialiased; }
  a { text-decoration:none; color:inherit; }

  /* ===== 导航 ===== */
  nav { height:88px; display:flex; align-items:center; justify-content:space-between;
        padding:0 clamp(24px,6vw,90px); background:#FFF; position:sticky; top:0; z-index:50; }
  .nav-l { display:flex; align-items:center; gap:44px; }
  .brand { display:flex; align-items:center; gap:11px; }
  .brand svg { width:30px; height:30px; }
  .brand .name { font-size:20px; font-weight:800; color:#111; letter-spacing:.02em; }
  .nav-menu { display:flex; gap:44px; font-size:16px; color:var(--body); font-weight:500; }
  .nav-menu a:hover { color:var(--blue); }
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
  .btn-primary { display:inline-flex; align-items:center; gap:9px; background:var(--btn); color:#FFF;
                 font-size:18px; font-weight:500; padding:17px 32px; border-radius:12px; transition:transform .15s ease, box-shadow .15s ease; }
  .btn-primary:hover { transform:translateY(-1px); box-shadow:0 8px 24px rgba(10,10,10,.18); }
  .btn-ghost { display:inline-flex; align-items:center; gap:9px; color:var(--ink); font-size:18px; font-weight:500;
               padding:17px 30px; border-radius:12px; border:1px solid #D6DAE2; transition:border-color .15s; }
  .btn-ghost:hover { border-color:var(--blue); color:var(--blue); }

  /* ===== Hero 点阵图 ===== */
  .hero-wrap { margin-top:52px; border-radius:16px; overflow:hidden; position:relative;
               aspect-ratio: 3 / 1.05; min-height:300px;
               background: linear-gradient(180deg, var(--hero-1) 0%, var(--hero-2) 46%, var(--hero-3) 78%, var(--hero-4) 100%); }
  .hero-wrap canvas { position:absolute; inset:0; width:100%; height:100%; }

  /* ===== 正文章节 ===== */
  section { margin-top:104px; }
  h2 { font-size:clamp(28px,3.4vw,38px); font-weight:700; color:#111827; letter-spacing:-.01em; }
  .rule { margin-top:18px; border:none; border-top:1px solid var(--line); }
  section p.lead { margin-top:34px; font-size:19px; line-height:1.72; color:var(--body); }
  section p.lead b { color:var(--ink); font-weight:650; }
  section p.lead .n { color:var(--blue); font-weight:650; }

  /* 四能力卡 */
  .cap-grid { margin-top:40px; display:grid; grid-template-columns:1fr 1fr; gap:22px; }
  @media (max-width:760px){ .cap-grid { grid-template-columns:1fr; } }
  .cap { border:1px solid var(--line); border-radius:14px; padding:26px 26px 22px; transition:border-color .15s, box-shadow .15s; }
  .cap:hover { border-color:#C9D6F5; box-shadow:0 6px 22px rgba(29,90,234,.07); }
  .cap .idx { font-size:13px; font-weight:600; color:var(--blue); letter-spacing:.12em; }
  .cap h3 { margin-top:10px; font-size:20px; font-weight:650; color:var(--ink); }
  .cap p { margin-top:10px; font-size:15.5px; line-height:1.66; color:var(--sub); }

  .master-note { margin-top:34px; border:1px solid #DCE4F8; background:#F6F9FF; border-radius:14px;
                 padding:22px 26px; font-size:16px; line-height:1.7; color:var(--sub); }
  .master-note b { color:var(--ink); }

  /* 截图 */
  .shot { margin-top:38px; border:1px solid var(--line); border-radius:14px; overflow:hidden; }
  .shot img { display:block; width:100%; height:auto; }
  .duo { margin-top:22px; display:grid; grid-template-columns:1.8fr 1fr; gap:22px; align-items:start; }
  @media (max-width:760px){ .duo { grid-template-columns:1fr; } }
  .caption { margin-top:14px; font-size:14.5px; color:var(--muted); text-align:center; }

  /* 数据表 */
  table { margin-top:38px; width:100%; border-collapse:collapse; font-size:16px; }
  th { text-align:left; font-size:14px; font-weight:600; color:var(--muted); letter-spacing:.06em;
       padding:12px 14px; border-bottom:1px solid var(--line); }
  td { padding:14px; border-bottom:1px solid #F0F2F5; color:var(--body); }
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
  .trade .card.win { border-color:#CDE7D2; background:#F5FBF6; }
  .trade .card.cost { border-color:#F3E2D8; background:#FCF8F5; }
  .trade h3 { font-size:17px; font-weight:650; }
  .trade .win h3 { color:#2F7A3D; } .trade .cost h3 { color:#A15C2B; }
  .trade ul { margin-top:14px; list-style:none; }
  .trade li { font-size:15.5px; line-height:1.6; color:var(--sub); padding:7px 0 7px 22px; position:relative; }
  .trade .win li::before { content:"+"; position:absolute; left:2px; color:#2F7A3D; font-weight:700; }
  .trade .cost li::before { content:"–"; position:absolute; left:2px; color:#A15C2B; font-weight:700; }

  footer { border-top:1px solid var(--line); margin-top:110px; padding:44px 24px 60px;
           display:flex; justify-content:center; gap:40px; font-size:15px; color:var(--muted); }
  footer a:hover { color:var(--ink); }
</style>
</head>
<body>

<nav>
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
  <div class="nav-r">
    <a href="https://github.com/pm-parker/netsteer" target="_blank">
      <svg width="19" height="19" viewBox="0 0 16 16" fill="#4B5563"><path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z"/></svg>
      GitHub
    </a>
  </div>
</nav>

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
    <table>
      <tr><th>指标</th><th>OFF 基线</th><th>NetSteer ON</th><th>变化</th></tr>
      <tr><td>平均满载延迟</td><td>58.6 ms</td><td class="hl">7.8 ms</td><td class="hl">↓ 87%</td></tr>
      <tr><td>满载延迟跨度 (p99−p50)</td><td>56.4 ms</td><td class="hl">6.9 ms</td><td class="hl">↓ 88%</td></tr>
      <tr><td>空载延迟</td><td>5.79 ms</td><td class="dim">5.91 ms</td><td class="dim">基本持平</td></tr>
      <tr><td>满载吞吐</td><td>823 Mbps</td><td class="dim">581 Mbps</td><td class="dim">−29%（见取舍）</td></tr>
    </table>
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
