#!/usr/bin/env python3
"""E2E against a real router running luci-app-netsteer.

Env: ROUTER_HOST (default 192.168.11.1), ROUTER_PW (admin password).
Requires: pip install playwright && playwright install chromium.
Covers: first-run ask modal, compact lede, help popover, runtime core detection,
        dynamic uci interfaces, IRQ radios, autotune button, badge, preset round-trip,
        autotune_done flag, mobile popover.
"""
import os, sys, time
from playwright.sync_api import sync_playwright

HOST = os.environ.get("ROUTER_HOST", "192.168.11.1")
PW = os.environ.get("ROUTER_PW")
BASE = f"http://{HOST}/cgi-bin/luci"
if not PW:
    sys.exit("set ROUTER_PW")

PASS = []
def ok(name): PASS.append(name); print("PASS:", name)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 1280, "height": 900}, ignore_https_errors=True)  # 路由器自签证书 (R5C local CA)
    pg = ctx.new_page()
    pg.goto(BASE, wait_until="domcontentloaded"); pg.wait_for_timeout(1000)
    pg.locator("input[type='password']").first.fill(PW)
    pg.locator("button:has-text('Log in')").first.click(); pg.wait_for_timeout(2200)
    pg.goto(BASE + "/admin/services/netsteer", wait_until="domcontentloaded"); pg.wait_for_timeout(4500)

    # first-run ask modal (only when autotune_done unset)
    body = pg.inner_text("body")
    if "首次使用建议" in body:
        ok("首装询问弹窗出现")
        pg.get_by_text("稍后再说").click(); pg.wait_for_timeout(600)
        ok("稍后再说 → 关闭")
    else:
        print("SKIP: 首装弹窗 (autotune_done 已标记)")

    if "NetSteer" not in body and "网络分核" not in body:
        sys.exit("page did not render — is the app installed?")

    if "把网络负载摊到全部" in body and len([l for l in body.split("\n") if "把网络负载摊到全部" in l][0]) < 60:
        ok("lede 精简")

    n_chips = pg.locator(".netsteer-chip[data-sec='eth0'][data-kind='rps']").count()
    assert n_chips >= 2, f"chip count {n_chips}"
    ok(f"NCPU 运行时探测: {n_chips} 芯片")

    n_cards = pg.locator(".netsteer-card").count()
    assert n_cards >= 6, f"card count {n_cards}"
    ok(f"卡片全景: {n_cards} 卡 (仪表盘/审计/P2P/游戏/软中断/IRQ)")

    assert pg.locator(".netsteer-chip[data-sec='eth0'][data-kind='irq']").count() > 0
    ok("IRQ radio 在位")

    assert pg.get_by_text("智能测速推荐").count() == 1
    ok("智能测速按钮在位")

    badge = pg.inner_text("#netsteer-badge")
    assert "当前" in badge
    ok(f"徽标: {badge.strip()}")

    # 问号浮窗 (按钮在专家调教面板头部)
    pg.locator(".netsteer-tab[data-tab='pro']").first.click(); pg.wait_for_timeout(800)
    pg.locator(".netsteer-help").first.click(); pg.wait_for_timeout(500)
    assert pg.locator("#netsteer-help-pop").count() == 1
    ok("问号浮窗可打开 (专家调教页)")
    pg.keyboard.press("Escape"); pg.wait_for_timeout(300)
    # 预设卡在本面板 (专家调教), 直接往返

    # preset round-trip
    cur = pg.locator(".netsteer-preset.on").first.get_attribute("data-preset")
    other = "pairs" if cur != "pairs" else "all"
    pg.locator(f".netsteer-preset[data-preset='{other}']").first.click(); pg.wait_for_timeout(2200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    pg.locator(f".netsteer-preset[data-preset='{cur}']").first.click(); pg.wait_for_timeout(2200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    assert pg.locator(f".netsteer-preset[data-preset='{cur}'].on").count() == 1
    ok(f"预设往返 {other}→{cur}")
    # v1.17: 整形分桶卡归专家调教 (术语只出现在这一页)
    for sel in ("#netsteer-tins", "#ns-tins", "#ns-cakeinfo"):
        assert pg.locator(sel).count() == 1, f"missing {sel}"
    ok("专家调教: 整形分桶卡在位 (tc 计数)")

    # v1.17.1 总览=纯展示: 四格统计首格=当前场景 (AI 智能识别), 无总开关
    assert pg.locator("#ns-scene-tile-value").count() == 1, "missing scene tile"
    assert pg.locator("#netsteer-panel-overview #ns-master").count() == 0, "总开关不应在总览"
    assert pg.locator("#netsteer-panel-smart #ns-master").count() == 1, "总开关应在智能模式页"
    ok("总览: 当前场景格在位 (AI 智能识别), 无开关; 总开关归位智能模式")

    # v1.17.1 智能模式 = 总开关 + 场景识别 + 设备加速 + P2P
    pg.locator(".netsteer-tab[data-tab='smart']").first.click(); pg.wait_for_timeout(1500)
    import time as _t
    for sel in ("#ns-master", "#ns-toggle", "#netsteer-scene", "#ns-sense-body",
                "#ns-feed-status", "#ns-feed-btn", "#netsteer-game", "#netsteer-game-badge",
                "#netsteer-game-ip", "#ns-game-spark", "#ns-game-suggest", "#netsteer-p2p"):
        assert pg.locator(sel).count() == 1, f"missing {sel}"
    tabnames = pg.locator(".netsteer-tab").all_inner_texts()
    assert "智能模式" in tabnames and "专家模式" in tabnames, f"tab 名不对: {tabnames}"
    sense_txt = ""
    for _ in range(15):  # 轮询最长 15s: pollLive 周期 8s + rpc dnslog 往返
        sense_txt = pg.inner_text("#ns-sense-body")
        if any(k in sense_txt for k in ("游戏", "会议", "视频", "下载", "浏览", "流量")):
            break
        _t.sleep(1.0)
    assert any(k in sense_txt for k in ("游戏", "会议", "视频", "下载", "浏览", "流量")), f"sense body empty: {sense_txt!r}"
    assert "置信度" not in sense_txt, "置信度百分比不应再展示"
    ok(f"智能模式: 总开关+场景识别+设备加速+P2P 在位 → {sense_txt.splitlines()[0][:20]}")

    b0 = pg.inner_text("#netsteer-game-badge").strip()
    if "优先中" in b0:  # 若初始为开, 先关掉保证起点确定
        pg.locator("#netsteer-game-toggle").first.click(); pg.wait_for_timeout(9000)
        b0 = pg.inner_text("#netsteer-game-badge").strip()
    assert "未开启" in b0, f"unexpected initial badge: {b0}"
    pg.locator("#netsteer-game-ip").fill("192.168.11.123")
    pg.locator("#netsteer-game-toggle").first.click(); pg.wait_for_timeout(9000)
    b1 = pg.inner_text("#netsteer-game-badge").strip()
    assert "优先中" in b1 and "192.168.11.123" in b1, f"toggle-on failed: {b1}"
    ok(f"设备加速: UI 开启生效 ({b1})")
    pg.locator("#netsteer-game-toggle").first.click(); pg.wait_for_timeout(9000)
    b2 = pg.inner_text("#netsteer-game-badge").strip()
    assert "未开启" in b2, f"toggle-off failed: {b2}"
    ok(f"设备加速: UI 关闭还原 ({b2})")

    # mobile popover (新 context 需重新登录)
    m = b.new_context(viewport={"width": 390, "height": 844}, ignore_https_errors=True)
    mp = m.new_page()
    mp.goto(BASE, wait_until="domcontentloaded"); mp.wait_for_timeout(1000)
    mp.locator("input[type='password']").first.fill(PW)
    mp.locator("button:has-text('Log in')").first.click(); mp.wait_for_timeout(2200)
    mp.goto(BASE + "/admin/services/netsteer", wait_until="domcontentloaded"); mp.wait_for_timeout(4500)
    if mp.get_by_text("稍后再说").count():
        mp.get_by_text("稍后再说").click(); mp.wait_for_timeout(400)
    # 390px 视口下 tab 条可能横向滚动, JS 直发 click 切到专家页
    mp.locator(".netsteer-tab[data-tab='pro']").first.evaluate("el => el.click()"); mp.wait_for_timeout(800)
    mp.locator(".netsteer-help").first.click(); mp.wait_for_timeout(500)
    assert mp.locator("#netsteer-help-pop").count() == 1
    ok("移动端: 问号浮窗可开")
    # v1.16.2: 页脚版本行 (build 注入真实版本号; dev=开发直推)
    foot = pg.inner_text("#ns-version-foot")
    assert foot.startswith("NetSteer v") and foot != "NetSteer vundefined", f"version foot bad: {foot!r}"
    ok(f"页脚版本行: {foot[:40]}")
    m.close(); ctx.close(); b.close()

print(f"ALL GREEN ({len(PASS)} checks)")
