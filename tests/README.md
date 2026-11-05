# Tests

## Unit (CI, no router needed)

```sh
node tests/unit/core.test.js
```

34 assertions over the multi-core preset/mask logic (2/4/8/16 cores), extracted
directly from `netsteer.js` source — tests automatically track code changes.

## E2E (manual, needs a real router)

Full browser pass against a live OpenWrt box (LuCI render, first-run modal,
presets round-trip, autotune, mobile popover):

```sh
pip install playwright && playwright install chromium
ROUTER_HOST=192.168.11.1 ROUTER_PW=yourpassword python3 tests/e2e/e2e.py
```

Hardware-in-the-loop checks that CI cannot do (real NIC, real PPPoE):

- `apk add` / `apk del` / reinstall round-trip on the target device
- 20-stream WAN download A/B benchmark (stock vs installed) — see
  `docs/images/benchmark-before-after*.png` for the method and results
- reboot persistence (init.d boot + hotplug re-apply)
