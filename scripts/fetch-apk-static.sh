#!/usr/bin/env bash
# fetch-apk-static.sh — resolve the current Alpine edge apk-tools-static and extract sbin/apk.static.
# Usage: fetch-apk-static.sh DEST_DIR [BASE_URL]
# Used by scripts/build-apk.sh and by CI package verification (pull request build and tag release).
# HTTP errors fail the script. The body is checked for gzip before tar, so an HTML error page is never extracted.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: fetch-apk-static.sh DEST_DIR [BASE_URL]" >&2
  exit 2
fi

DEST=$1
BASE=${2:-https://dl-cdn.alpinelinux.org/alpine/edge/main/x86_64}
BASE=${BASE%/}

INDEX=$(mktemp)
APK=$(mktemp)
trap 'rm -f "$INDEX" "$APK"' EXIT

if ! curl -fsSL --retry 0 --connect-timeout 20 --max-time 120 -o "$INDEX" "$BASE/"; then
  echo "ERROR: apk-tools index fetch failed: $BASE/" >&2
  exit 1
fi

# Directory listing is HTML. Pick the newest apk-tools-static-*.apk (version sort: 3.0.11 > 3.0.9).
NAME=$(grep -oE 'apk-tools-static-[0-9][^"<[:space:]]*\.apk' "$INDEX" | sort -V -u | tail -n 1 || true)
if [ -z "${NAME}" ]; then
  echo "ERROR: cannot resolve apk-tools-static name from $BASE/" >&2
  exit 1
fi
case "$NAME" in
  *[!a-zA-Z0-9._-]*)
    echo "ERROR: refused apk-tools-static name: $NAME" >&2
    exit 1 ;;
  apk-tools-static-[0-9]*.apk) ;;
  *)
    echo "ERROR: refused apk-tools-static name: $NAME" >&2
    exit 1 ;;
esac

if ! curl -fsSL --retry 0 --connect-timeout 20 --max-time 120 -o "$APK" "$BASE/$NAME"; then
  echo "ERROR: apk-tools-static download failed: $BASE/$NAME" >&2
  exit 1
fi

SIG=$(od -An -N2 -tx1 "$APK" | tr -d '[:space:]')
if [ "$SIG" != "1f8b" ] || ! gzip -t "$APK"; then
  echo "ERROR: downloaded apk-tools-static is not a gzip package" >&2
  exit 1
fi

# Do not tar-extract: a sbin/apk.static symlink is materialized as a link, and chmod follows it.
# Read the regular-file member and write it only inside DEST, without following links.
if [ -L "$DEST" ]; then
  echo "ERROR: refusing to follow symlink at destination" >&2
  exit 1
fi
mkdir -p "$DEST"
python3 - "$DEST" "$APK" <<'PY'
import os
import stat
import sys
import tarfile

dest, apk_path = sys.argv[1], sys.argv[2]

def fail(msg):
    sys.stderr.write(f"ERROR: refusing {msg}\n")
    sys.exit(1)

def canonical(name):
    if not name or name.startswith("/"):
        return None
    while name.startswith("./"):
        name = name[2:]
    name = name.rstrip("/")
    parts = name.split("/")
    if any(part in ("", "..") for part in parts):
        return None
    return name

try:
    tf = tarfile.open(apk_path, "r:gz")
except (tarfile.TarError, OSError) as exc:
    sys.stderr.write(f"ERROR: apk-tools archive is not a readable gzip tar ({exc})\n")
    sys.exit(1)

member = None
data = None
try:
    # open() can succeed on a valid gzip of a short tar. getmembers()/read()
    # then raise ReadError ("unexpected end of data") once the member body ends.
    with tf:
        for info in tf.getmembers():
            name = canonical(info.name)
            if name == "sbin":
                if info.issym() or info.islnk() or not info.isdir():
                    fail("unsafe archive link for sbin")
            elif name == "sbin/apk.static":
                if info.issym() or info.islnk() or not info.isreg():
                    fail("unsafe archive link for apk.static")
                if member is not None:
                    fail("duplicate apk.static member")
                payload = tf.extractfile(info)
                if payload is None:
                    fail("unsafe archive link for apk.static")
                member = info
                data = payload.read()
except tarfile.ReadError as exc:
    sys.stderr.write(f"ERROR: apk-tools archive is truncated ({exc})\n")
    sys.exit(1)
if member is None or data is None:
    sys.stderr.write("ERROR: archive has no regular sbin/apk.static\n")
    sys.exit(1)

dest = os.path.abspath(dest)
if os.path.islink(dest):
    fail("to follow symlink at destination")
real_dest = os.path.realpath(dest)
sbin = os.path.join(dest, "sbin")
if os.path.islink(sbin):
    fail("to follow symlink at destination sbin")
os.makedirs(sbin, exist_ok=True)
if os.path.islink(sbin) or not os.path.isdir(sbin):
    fail("to follow symlink at destination sbin")
real_sbin = os.path.realpath(sbin)
try:
    if os.path.commonpath([real_dest, real_sbin]) != real_dest:
        fail("to write apk.static outside destination")
except ValueError:
    fail("to write apk.static outside destination")

# Open sbin itself with O_NOFOLLOW so a parent symlink cannot redirect the write.
try:
    dirfd = os.open(sbin, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
except OSError:
    fail("to follow symlink at destination sbin")
try:
    def lstat_in(name):
        try:
            return os.lstat(name, dir_fd=dirfd)
        except FileNotFoundError:
            return None

    def regular_in_dir(st):
        return st is not None and stat.S_ISREG(st.st_mode) and not stat.S_ISLNK(st.st_mode) and st.st_nlink == 1

    existing = lstat_in("apk.static")
    if existing is not None and not regular_in_dir(existing):
        fail("to replace linked apk.static")
    partial_st = lstat_in(".apk.static.partial")
    if partial_st is not None:
        if not regular_in_dir(partial_st):
            fail("to replace linked temporary apk.static")
        os.unlink(".apk.static.partial", dir_fd=dirfd)
    flags = os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
    fd = os.open(".apk.static.partial", flags, 0o755, dir_fd=dirfd)
    try:
        os.fchmod(fd, 0o755)
        view = memoryview(data)
        while view:
            written = os.write(fd, view)
            if written <= 0:
                fail("to write apk.static")
            view = view[written:]
    finally:
        os.close(fd)
    os.rename(".apk.static.partial", "apk.static", src_dir_fd=dirfd, dst_dir_fd=dirfd)
    st = lstat_in("apk.static")
    if not regular_in_dir(st):
        fail("unsafe apk.static after extract")
finally:
    os.close(dirfd)
PY
if [ -L "$DEST/sbin/apk.static" ] || [ ! -x "$DEST/sbin/apk.static" ]; then
  echo "ERROR: sbin/apk.static missing after extract" >&2
  exit 1
fi
echo ">> fetched $NAME" >&2
