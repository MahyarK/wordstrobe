#!/usr/bin/env bash
# Builds the Vision OCR sidecar into src-tauri/binaries/ under Tauri's externalBin naming.
#   scripts/build-helper.sh              host target triple only (tauri dev)
#   scripts/build-helper.sh --universal  arm64 + x86_64 + lipo'd wordstrobe-ocr-universal-apple-darwin (release)
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src="$root/src-tauri/helper/wordstrobe-ocr.swift"
out="$root/src-tauri/binaries"
mkdir -p "$out"

# ponytail: fresh = a Mach-O (so a placeholder script never counts) that no input is newer than.
# Only the inputs are checked: after changing flags in this script, touch the .swift to force a rebuild.
fresh() {
    local bin=$1 dep
    [[ $(file -b "$bin" 2>/dev/null) == Mach-O* ]] || return 1
    for dep in "${@:2}"; do
        if /bin/test "$dep" -nt "$bin"; then return 1; fi  # not [[ -nt ]]: bash 3.2 compares whole seconds only
    done
}

build() { # <rust target triple>
    local arch=${1%%-*} bin="$out/wordstrobe-ocr-$1"
    if [[ $arch == aarch64 ]]; then arch=arm64; fi
    if fresh "$bin" "$src"; then return; fi
    echo "building $bin"
    swiftc -O -target "$arch-apple-macos15" "$src" -o "$bin.tmp"
    mv "$bin.tmp" "$bin"
}

if [[ ${1:-} == --universal ]]; then
    build aarch64-apple-darwin
    build x86_64-apple-darwin
    universal="$out/wordstrobe-ocr-universal-apple-darwin"
    if ! fresh "$universal" "$out/wordstrobe-ocr-aarch64-apple-darwin" "$out/wordstrobe-ocr-x86_64-apple-darwin"; then
        echo "building $universal"
        lipo -create "$out/wordstrobe-ocr-aarch64-apple-darwin" "$out/wordstrobe-ocr-x86_64-apple-darwin" -output "$universal.tmp"
        mv "$universal.tmp" "$universal"
    fi
else
    build "$(rustc -vV | sed -n 's/^host: //p')"
fi
