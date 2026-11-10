Download the .apk matching your device architecture (check `/etc/apk/arch` on the router).

Install (OpenWrt 24.10+/25.12):
```
apk add --allow-untrusted /tmp/luci-app-netsteer-*.apk
```

Built automatically by CI from this tag — unit tests + 4-arch build matrix.
Every package is verified with `apk verify` before it is attached.
