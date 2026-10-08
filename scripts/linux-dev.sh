#!/usr/bin/env bash
# Build, test and smoke-run Wordstrobe for Linux inside Docker (Ubuntu 24.04, WebKitGTK 4.1).
#
#   scripts/linux-dev.sh image            (re)build the image `wordstrobe-linux-dev`
#   scripts/linux-dev.sh build            npm ci + debug binary (`tauri build --debug --no-bundle`)
#   scripts/linux-dev.sh test             npm test + cargo test
#   scripts/linux-dev.sh clippy           cargo clippy --all-targets -- -D warnings
#   scripts/linux-dev.sh check            build + test + clippy
#   scripts/linux-dev.sh e2e <png> [text] run the debug binary under Xvfb with `--read-image <png>` and
#                                         wait for `reader:load` in its log; with [text], that text must
#                                         be in the OCR result (case-insensitive). E2E_LANG sets $LANG.
#   scripts/linux-dev.sh shell            interactive shell in the container
#   scripts/linux-dev.sh run <cmd...>     any command in the container, at /work
#   scripts/linux-dev.sh clean            remove the build volumes (node_modules, dist, cargo target, caches)
#
# The repo is mounted at /work, but everything with native binaries lives in named Docker volumes,
# never in the macOS checkout: /work/node_modules, /work/dist, the cargo target dir (/cache/target)
# and the cargo registry.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
image=wordstrobe-linux-dev
volumes=(wordstrobe-linux-node-modules wordstrobe-linux-dist wordstrobe-linux-target wordstrobe-cargo-registry wordstrobe-cargo-git)

build_image() { docker build -f "$root/scripts/linux-dev.Dockerfile" -t "$image" "$root/scripts"; }

# docker_run [extra docker args --] <bash script>
docker_run() {
    local extra=()
    while [[ $# -gt 1 && $1 != -- ]]; do extra+=("$1"); shift; done
    [[ ${1:-} == -- ]] && shift
    docker image inspect "$image" >/dev/null 2>&1 || build_image
    local tty=-i
    [[ -t 0 && -t 1 ]] && tty=-it
    docker run --rm "$tty" \
        -v "$root":/work \
        -v wordstrobe-linux-node-modules:/work/node_modules \
        -v wordstrobe-linux-dist:/work/dist \
        -v wordstrobe-linux-target:/cache/target \
        -v wordstrobe-cargo-registry:/usr/local/cargo/registry \
        -v wordstrobe-cargo-git:/usr/local/cargo/git \
        ${extra[@]+"${extra[@]}"} \
        "$image" bash -c "$1"
}

# Runs inside the container before every command: JS dependencies, reinstalled only when the lockfile changed.
prelude='
set -euo pipefail
cd /work
lock=$(md5sum package-lock.json | cut -d" " -f1)
if [ ! -x node_modules/.bin/tauri ] || [ "$(cat node_modules/.lock-hash 2>/dev/null)" != "$lock" ]; then
  npm ci --no-audit --no-fund
  echo "$lock" > node_modules/.lock-hash
fi
'

case "${1:-}" in
image)
    build_image
    ;;
build)
    docker_run -- "$prelude"'
npm run tauri build -- --debug --no-bundle
ls -la /cache/target/debug/wordstrobe
'
    ;;
test)
    docker_run -- "$prelude"'
npm test
# generate_context! needs the built frontend; the crate also builds its icons and capabilities.
[ -f dist/reader.html ] || npm run build
cd src-tauri && cargo test
'
    ;;
clippy)
    docker_run -- "$prelude"'
[ -f dist/reader.html ] || npm run build
cd src-tauri && cargo clippy --all-targets -- -D warnings
'
    ;;
check)
    "$0" build && "$0" test && "$0" clippy
    ;;
e2e)
    png=${2:?usage: linux-dev.sh e2e <png> [expected text]}
    expect=${3:-}
    [[ -f $png ]] || { echo "no such file: $png" >&2; exit 2; }
    png="$(cd "$(dirname "$png")" && pwd)/$(basename "$png")"
    docker_run -v "$png":/input/capture.png:ro -e "E2E_LANG=${E2E_LANG:-C.UTF-8}" -e "E2E_EXPECT=$expect" -e "E2E_TIMEOUT=${E2E_TIMEOUT:-90}" -- '
set -uo pipefail
bin=/cache/target/debug/wordstrobe
[ -x "$bin" ] || { echo "no debug binary: run scripts/linux-dev.sh build first" >&2; exit 2; }
log=/tmp/e2e.log; : > "$log"
# Xvfb + a private session bus (single-instance and the tray talk D-Bus). WebKitGTK gets software rendering.
xvfb-run -a -s "-screen 0 1920x1080x24" dbus-run-session -- bash -c '"'"'
  export LANG="$E2E_LANG" LC_ALL="$E2E_LANG" GDK_BACKEND=x11 LIBGL_ALWAYS_SOFTWARE=1 \
         WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1
  "$0" --read-image /input/capture.png > "$1" 2>&1 &
  pid=$!
  for _ in $(seq "$E2E_TIMEOUT"); do
    grep -q "emitted reader:load\|ocr failed" "$1" && break
    kill -0 "$pid" 2>/dev/null || break
    sleep 1
  done
  sleep 1; kill "$pid" 2>/dev/null; wait "$pid" 2>/dev/null
  exit 0
'"'"' "$bin" "$log"
echo "----- app log"; cat "$log"; echo "-----"
grep -q "emitted reader:load" "$log" || { echo "E2E FAIL: no reader:load in the log" >&2; exit 1; }
if [ -n "$E2E_EXPECT" ] && ! grep -i "emitted reader:load" "$log" | grep -qiF -- "$E2E_EXPECT"; then
  echo "E2E FAIL: reader:load does not contain: $E2E_EXPECT" >&2; exit 1
fi
echo "E2E OK: $(grep -o "ocr [0-9]* ms[^,]*" "$log" | head -1)"
'
    ;;
shell)
    docker_run -- 'cd /work && exec bash'
    ;;
run)
    shift
    [[ $# -gt 0 ]] || { echo "usage: linux-dev.sh run <cmd...>" >&2; exit 2; }
    docker_run -- "cd /work && $*"
    ;;
clean)
    docker volume rm "${volumes[@]}" 2>/dev/null || true
    ;;
*)
    sed -n '2,/^set -/p' "${BASH_SOURCE[0]}" | sed '$d' | sed 's/^# \{0,1\}//'
    exit 2
    ;;
esac
