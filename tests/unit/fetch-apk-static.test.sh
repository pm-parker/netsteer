#!/bin/sh
# fetch-apk-static 守卫: 当前包名解析、HTTP 错误必须失败、HTTP 200 的 HTML 不得当 gzip 解包。
# 归档内的符号链接/硬链接不得被跟随, 也不得改动解压目录以外的内容或权限。
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
        if mode == "custom" and path.endswith("apk-tools-static-3.0.11-r0.apk"):
            data = (port_path.parent / "custom.apk").read_bytes()
            self._send(200, data, "application/octet-stream")
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

# 恶意 gzip tar。victim 在解压目录之外, 模式 0644, 内容固定。
make_apk() {
	python3 - "$1" "$2" "$WORK/custom.apk" <<'PY'
import gzip, io, sys, tarfile
kind, arg, out = sys.argv[1:]
raw = io.BytesIO()
with tarfile.open(fileobj=raw, mode="w") as tar:
    if kind == "symlink":
        info = tarfile.TarInfo("sbin/apk.static")
        info.type = tarfile.SYMTYPE
        info.linkname = arg
        tar.addfile(info)
    elif kind == "parent-symlink":
        link = tarfile.TarInfo("sbin")
        link.type = tarfile.SYMTYPE
        link.linkname = arg
        tar.addfile(link)
        data = b"SHOULD-NOT-LAND\n"
        reg = tarfile.TarInfo("sbin/apk.static")
        reg.size = len(data)
        reg.mode = 0o644
        tar.addfile(reg, io.BytesIO(data))
    elif kind == "hardlink":
        info = tarfile.TarInfo("sbin/apk.static")
        info.type = tarfile.LNKTYPE
        info.linkname = arg
        tar.addfile(info)
    else:
        sys.stderr.write("unknown kind\n")
        sys.exit(2)
with gzip.GzipFile(out, "wb", mtime=0) as gz:
    gz.write(raw.getvalue())
PY
}

victim_ok() {
	V=$1
	LABEL=$2
	[ "$(stat -c '%a' "$V")" = "644" ] && ok "$LABEL 外部权限仍是 644" || bad "$LABEL 外部权限被改成 $(stat -c '%a' "$V")"
	[ "$(stat -c '%h' "$V")" = "1" ] && ok "$LABEL 外部链接数仍是 1" || bad "$LABEL 外部链接数变成 $(stat -c '%h' "$V")"
	cmp -s "$V" "$V.orig" && ok "$LABEL 外部内容未变" || bad "$LABEL 外部内容被改写"
}

# ---- 绝对符号链接: chmod 不得把外部文件 0644 改成 0755 ----
V=$WORK/victim-abs
printf 'SECRET-ABS\n' > "$V"
cp "$V" "$V.orig"
chmod 644 "$V"
make_apk symlink "$V"
start_server custom
DEST=$WORK/link-abs
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "绝对符号链接被拒绝" || bad "绝对符号链接应失败, rc=$RC out=$OUT"
printf '%s\n' "$OUT" | grep -q 'refusing' \
	&& ok "绝对符号链接有 refusing" \
	|| bad "绝对符号链接未明确拒绝: $OUT"
victim_ok "$V" "绝对符号链接"
stop_server

# ---- 指向父目录之外的相对符号链接 ----
V=$WORK/victim-rel
printf 'SECRET-REL\n' > "$V"
cp "$V" "$V.orig"
chmod 644 "$V"
make_apk symlink "../../victim-rel"
start_server custom
DEST=$WORK/rel-dest
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "父目录相对符号链接被拒绝" || bad "父目录相对符号链接应失败, rc=$RC out=$OUT"
printf '%s\n' "$OUT" | grep -q 'refusing' \
	&& ok "父目录相对符号链接有 refusing" \
	|| bad "父目录相对符号链接未明确拒绝: $OUT"
victim_ok "$V" "父目录相对符号链接"
# 解压结果本身也不得是指向外部的符号链接
if [ -L "$DEST/sbin/apk.static" ]; then
	bad "父目录相对符号链接仍被物化到目标目录"
else
	ok "父目录相对符号链接未物化"
fi
stop_server

# ---- 同路径父目录 sbin 本身是指向外部目录的符号链接, 且带普通文件成员 ----
OUTDIR=$WORK/outside-parent
mkdir -p "$OUTDIR"
printf 'KEEP-PARENT\n' > "$OUTDIR/marker"
cp "$OUTDIR/marker" "$OUTDIR/marker.orig"
chmod 644 "$OUTDIR/marker"
make_apk parent-symlink "$OUTDIR"
start_server custom
DEST=$WORK/parent-dest
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "父目录符号链接归档被拒绝" || bad "父目录符号链接归档应失败, rc=$RC out=$OUT"
printf '%s\n' "$OUT" | grep -q 'refusing' \
	&& ok "父目录符号链接有 refusing" \
	|| bad "父目录符号链接未明确拒绝: $OUT"
[ "$(stat -c '%a' "$OUTDIR/marker")" = "644" ] && ok "父目录符号链接未改外部权限" || bad "父目录符号链接改了外部权限 $(stat -c '%a' "$OUTDIR/marker")"
cmp -s "$OUTDIR/marker" "$OUTDIR/marker.orig" && ok "父目录符号链接未改外部内容" || bad "父目录符号链接改了外部内容"
[ ! -e "$OUTDIR/apk.static" ] && ok "父目录符号链接未把文件写到外部" || bad "父目录符号链接把 apk.static 写到了外部目录"
stop_server

# ---- 硬链接成员: 不得连到外部 inode, 也不得改它的权限/内容 ----
# GNU tar 1.35 会剥掉硬链接目标里的 / 和 ../ 并在对不上已有文件时失败;
# 助手仍必须自己拒绝 LNKTYPE, 这样即使 tar 真的连上了也不会 chmod 外部文件。
V=$WORK/victim-hard
printf 'SECRET-HARD\n' > "$V"
cp "$V" "$V.orig"
chmod 644 "$V"
make_apk hardlink "$V"
start_server custom
DEST=$WORK/hard-dest
run_fetch "$DEST"
[ "$RC" -ne 0 ] && ok "硬链接成员被拒绝" || bad "硬链接成员应失败, rc=$RC out=$OUT"
printf '%s\n' "$OUT" | grep -q 'refusing' \
	&& ok "硬链接成员有 refusing" \
	|| bad "硬链接成员未明确拒绝: $OUT"
victim_ok "$V" "硬链接"
stop_server

# ---- 目标目录里预先放好的 sbin 符号链接, 普通包也不得写穿 ----
start_server ok
OUTDIR=$WORK/outside-pre
mkdir -p "$OUTDIR"
printf 'KEEP-PRE\n' > "$OUTDIR/apk.static"
cp "$OUTDIR/apk.static" "$OUTDIR/apk.static.orig"
chmod 644 "$OUTDIR/apk.static"
DEST=$WORK/pre-dest
rm -rf "$DEST"
mkdir -p "$DEST"
ln -s "$OUTDIR" "$DEST/sbin"
OUT=$("$FETCH" "$DEST" "http://127.0.0.1:$PORT" 2>&1) && RC=0 || RC=$?
[ "$RC" -ne 0 ] && ok "预先存在的父目录符号链接被拒绝" || bad "预先存在的父目录符号链接应失败, rc=$RC out=$OUT"
[ "$(stat -c '%a' "$OUTDIR/apk.static")" = "644" ] && ok "预先存在的符号链接未改外部权限" || bad "预先存在的符号链接改了外部权限"
cmp -s "$OUTDIR/apk.static" "$OUTDIR/apk.static.orig" && ok "预先存在的符号链接未改外部内容" || bad "预先存在的符号链接改了外部内容"
stop_server

echo "# pass $PASS  fail $FAIL"
[ "$FAIL" -eq 0 ]
