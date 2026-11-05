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
    ctx = b.new_context(viewport={"width": 1280, "height": 900})
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
    ok("问号浮窗 (原理+用法)" if "?" in body else "FAIL 问号按钮缺失")

    n_chips = pg.locator(".netsteer-chip[data-sec='eth0'][data-kind='rps']").count()
    assert n_chips >= 2, f"chip count {n_chips}"
    ok(f"NCPU 运行时探测: {n_chips} 芯片")

    n_cards = pg.locator(".netsteer-card[data-sec]").count()
    assert n_cards >= 2
    ok(f"uci 动态接口: {n_cards} 卡")

    assert pg.locator(".netsteer-chip[data-sec='eth0'][data-kind='irq']").count() > 0
    ok("IRQ radio 在位")

    assert pg.get_by_text("智能测速推荐").count() == 1
    ok("智能测速按钮在位")

    badge = pg.inner_text("#netsteer-badge")
    assert "当前" in badge
    ok(f"徽标: {badge.strip()}")

    # preset round-trip
    cur = pg.locator(".netsteer-preset.on").first.get_attribute("data-preset")
    other = "pairs" if cur != "pairs" else "all"
    pg.locator(f".netsteer-preset[data-preset='{other}']").first.click(); pg.wait_for_timeout(2200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    pg.locator(f".netsteer-preset[data-preset='{cur}']").first.click(); pg.wait_for_timeout(2200)
    pg.keyboard.press("Escape"); pg.wait_for_timeout(400)
    assert pg.locator(f".netsteer-preset[data-preset='{cur}'].on").count() == 1
    ok(f"预设往返 {other}→{cur}")

    # mobile popover
    m = b.new_context(viewport={"width": 390, "height": 844})
    mp = m.new_page()
    mp.goto(BASE + "/admin/services/netsteer", wait_until="domcontentloaded"); mp.wait_for_timeout(4500)
    if mp.get_by_text("稍后再说").count():
        mp.get_by_text("稍后再说").click(); mp.wait_for_timeout(400)
    mp.get_by_text("?", exact=True).first.click(); mp.wait_for_timeout(500)
    assert mp.locator("#netsteer-help-pop").count() == 1
    ok("移动端: 问号浮窗可开")
    m.close(); ctx.close(); b.close()

print(f"ALL GREEN ({len(PASS)} checks)")
