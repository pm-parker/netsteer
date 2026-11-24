#!/bin/sh
# fetch-apk-static 守卫: 当前包名解析、HTTP 错误必须失败、HTTP 200 的 HTML 不得当 gzip 解包。
# CI 的包校验与 release 校验都必须走 scripts/fetch-apk-static.sh, 不再钉死已下架的 edge URL。
# 用法: sh tests/unit/fetch-apk-static.test.sh
set -u
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
WORK=$(mktemp -d)
PASS=0; FAIL=0
SRV=
ok() { PASS=$((PASS+1)); printf 'ok %d - %s\n' "$PASS" "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'not ok - %s\n' "$1"; }
cleanup() { [ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null; rm -rf "$WORK"; }
trap cleanup EXIT

CI="$ROOT/.github/workflows/ci.yml"
BUILD="$ROOT/scripts/build-apk.sh"
FETCH="$ROOT/scripts/fetch-apk-static.sh"

step_block() {
	python3 - "$CI" "$1" <<'PY'
import sys
path, name = sys.argv[1], sys.argv[2]
lines = open(path, encoding="utf-8").read().splitlines(True)
start = None
for i, line in enumerate(lines):
    if line.startswith("      - name: ") and name in line:
        start = i
        break
if start is None:
    sys.exit(2)
out = [lines[start]]
for line in lines[start + 1:]:
    if line.startswith("      - "):
        break
    out.append(line)
sys.stdout.write("".join(out))
PY
}

# ---- 调用点: 构建后校验 + release 校验都走同一脚本 ----
VERIFY=$(step_block "Verify package integrity" || true)
RELEASE=$(step_block "Verify every package before attaching" || true)
printf '%s' "$VERIFY" | grep -q './scripts/fetch-apk-static.sh' \
	&& ok "CI 包校验调用 fetch-apk-static.sh" \
	|| bad "CI 包校验未调用 fetch-apk-static.sh"
printf '%s' "$VERIFY" | grep -q 'curl ' \
	&& bad "CI 包校验仍直接 curl" \
	|| ok "CI 包校验不再直接 curl"
printf '%s' "$RELEASE" | grep -q './scripts/fetch-apk-static.sh' \
	&& ok "release 校验调用 fetch-apk-static.sh" \
	|| bad "release 校验未调用 fetch-apk-static.sh"
printf '%s' "$RELEASE" | grep -q 'curl ' \
	&& bad "release 校验仍直接 curl" \
	|| ok "release 校验不再直接 curl"
grep -q 'apk-tools-static-3.0.9-r0' "$CI" \
	&& bad "ci.yml 仍钉死已下架的 apk-tools-static-3.0.9-r0" \
	|| ok "ci.yml 不再引用 apk-tools-static-3.0.9-r0"
grep -q "if: startsWith(github.ref, 'refs/tags/v')" "$CI" \
	&& ok "release 触发条件未改" \
	|| bad "release 触发条件被改动"
grep -q 'scripts/fetch-apk-static.sh' "$BUILD" \
	&& ok "build-apk.sh 复用 fetch-apk-static.sh" \
	|| bad "build-apk.sh 未复用 fetch-apk-static.sh"
grep -q 'curl ' "$BUILD" \
	&& bad "build-apk.sh 仍自行 curl apk-tools" \
	|| ok "build-apk.sh 不再自行 curl apk-tools"
grep -q 'tests/unit/fetch-apk-static.test.sh' "$CI" \
	&& ok "CI 会跑 fetch-apk-static 测试" \
	|| bad "CI 未挂上 fetch-apk-static 测试"

cat > "$WORK/server.py" <<'PY'
#!/usr/bin/env python3
"""Local Alpine-edge stand-in. Modes: ok, http-error, html-200."""
import gzip
import io
import sys
import tarfile
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

mode, log_path, port_path = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])

def gzip_tar():
    raw = io.BytesIO()
    with tarfile.open(fileobj=raw, mode="w") as tar:
        data = b"#!/bin/sh\necho apk-static-ok\n"
        info = tarfile.TarInfo("sbin/apk.static")
        info.size = len(data)
        info.mode = 0o755
        tar.addfile(info, io.BytesIO(data))
    out = io.BytesIO()
    with gzip.GzipFile(fileobj=out, mode="wb", mtime=0) as gz:
        gz.write(raw.getvalue())
    return out.getvalue()

PKG = gzip_tar()
HTML = b"<!DOCTYPE html><html><body>not a package</body></html>"
INDEX = b"""<html><body><pre>
<a href="apk-tools-static-3.0.9-r0.apk">apk-tools-static-3.0.9-r0.apk</a>
<a href="apk-tools-static-3.0.11-r0.apk">apk-tools-static-3.0.11-r0.apk</a>
</pre></body></html>"""

class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def do_GET(self):
        path = self.path.split("?", 1)[0]
        with log_path.open("a", encoding="utf-8") as fh:
            fh.write(path + "\n")
        if path.endswith("/"):
            self._send(200, INDEX, "text/html; charset=utf-8")
            return
        if mode == "ok" and path.endswith("apk-tools-static-3.0.11-r0.apk"):
            self._send(200, PKG, "application/octet-stream")
            return
        if mode == "ok" and path.endswith("apk-tools-static-3.0.9-r0.apk"):
            self._send(200, PKG, "application/octet-stream")
            return
        if mode == "http-error":
            # Body is a real gzip package. Status is the failure; content must not be extracted.
            self._send(404, PKG, "application/octet-stream")
            return
        if mode == "html-200":
            self._send(200, HTML, "text/html; charset=utf-8")
            return
        self._send(404, HTML, "text/html; charset=utf-8")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        return

server = HTTPServer(("127.0.0.1", 0), Handler)
port_path.write_text(str(server.server_address[1]), encoding="utf-8")
server.serve_forever()
PY

start_server() {
	MODE=$1
	rm -f "$WORK/port" "$WORK/req.log"
	python3 "$WORK/server.py" "$MODE" "$WORK/req.log" "$WORK/port" &
	SRV=$!
	i=0
	while [ ! -s "$WORK/port" ] && [ "$i" -lt 50 ]; do i=$((i+1)); sleep 0.05; done
	PORT=$(cat "$WORK/port")
	i=0
	while [ "$i" -lt 50 ]; do
		curl -s -o /dev/null "http://127.0.0.1:$PORT/" && break
		i=$((i+1)); sleep 0.05
	done
}

stop_server() {
	[ -n "${SRV:-}" ] && kill "$SRV" 2>/dev/null || true
	wait "$SRV" 2>/dev/null || true
	SRV=
}

run_fetch() {
	DEST=$1
	rm -rf "$DEST"
	mkdir -p "$DEST"
	OUT=$("$FETCH" "$DEST" "http://127.0.0.1:$PORT" 2>&1) && RC=0 || RC=$?
}

# ---- 正常 gzip: 目录里同时有旧名与现名时取现名, 并抽出可执行 apk.static ----
start_server ok
DEST=$WORK/ok
run_fetch "$DEST"
[ "$RC" -eq 0 ] && ok "gzip 包退出码 0" || bad "gzip 包应成功, rc=$RC out=$OUT"
[ -x "$DEST/sbin/apk.static" ] && ok "抽出可执行 sbin/apk.static" || bad "未抽出可执行 sbin/apk.static"
GOT=$("$DEST/sbin/apk.static" 2>/dev/null || true)
[ "$GOT" = "apk-static-ok" ] && ok "抽出的工具可运行" || bad "抽出的工具输出异常: $GOT"
APK_REQ=$(grep '\.apk$' "$WORK/req.log" || true)
printf '%s\n' "$APK_REQ" | grep -q 'apk-tools-static-3.0.11-r0.apk' \
	&& ok "解析到当前包名 3.0.11-r0" \
	|| bad "未请求 3.0.11-r0: $APK_REQ"
printf '%s\n' "$APK_REQ" | grep -q 'apk-tools-static-3.0.9-r0.apk' \
	&& bad "仍下载已下架的 3.0.9-r0: $APK_REQ" \
	|| ok "未下载已下架的 3.0.9-r0"
stop_server

# ---- HTTP 错误: 正文即使是合法 gzip 也必须失败, 且不得解包 ----
start_server http-error
DEST=$WORK/http
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "HTTP 错误非 0 退出" || bad "HTTP 错误应失败, rc=$RC out=$OUT"
[ ! -e "$DEST/sbin/apk.static" ] && ok "HTTP 错误未解出 apk.static" || bad "HTTP 错误仍解出了 apk.static"
printf '%s\n' "$OUT" | grep -q 'download failed' \
	&& ok "HTTP 错误有明确失败信息" \
	|| bad "HTTP 错误缺少 download failed: $OUT"
stop_server

# ---- HTTP 200 的 HTML: 不得当成 gzip 包去 tar ----
start_server html-200
DEST=$WORK/html
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "HTTP 200 HTML 非 0 退出" || bad "HTTP 200 HTML 应失败, rc=$RC out=$OUT"
[ ! -e "$DEST/sbin/apk.static" ] && ok "HTTP 200 HTML 未解出 apk.static" || bad "HTTP 200 HTML 仍解出了 apk.static"
printf '%s\n' "$OUT" | grep -q 'not a gzip' \
	&& ok "HTTP 200 HTML 在解包前被拒绝" \
	|| bad "HTTP 200 HTML 未被识别为非 gzip: $OUT"
stop_server

echo "# pass $PASS  fail $FAIL"
[ "$FAIL" -eq 0 ]
