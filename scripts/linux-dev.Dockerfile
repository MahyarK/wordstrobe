# Linux build/test environment for Wordstrobe (see scripts/linux-dev.sh).
# Ubuntu 24.04 = WebKitGTK 4.1, the same baseline as the AppImage/.deb target.
FROM ubuntu:24.04

ARG NODE_VERSION=22.23.3
ENV DEBIAN_FRONTEND=noninteractive \
    LANG=C.UTF-8 \
    RUSTUP_HOME=/usr/local/rustup \
    CARGO_HOME=/usr/local/cargo \
    PATH=/usr/local/cargo/bin:/usr/local/node/bin:$PATH

# Tauri v2 Linux prerequisites, plus what the overlay (xcap: X11/Wayland capture) and the e2e
# harness (Xvfb) need. xdg-desktop-portal is optional: only the Wayland capture path talks to it.
RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates curl wget file xz-utils git sudo \
        build-essential pkg-config patchelf \
        libwebkit2gtk-4.1-dev libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev \
        libdbus-1-dev libclang-dev libpipewire-0.3-dev libgbm-dev libxcb1-dev libxrandr-dev \
        libxcb-randr0-dev libxcb-shm0-dev libx11-dev \
        tesseract-ocr tesseract-ocr-eng tesseract-ocr-deu \
        xvfb xdotool x11-utils dbus-x11 imagemagick feh fonts-dejavu \
        xdg-desktop-portal \
    && rm -rf /var/lib/apt/lists/*

# Node 22 (>= 22.18: `node --test` strips TypeScript types natively). Arch-aware: arm64 on Apple Silicon.
RUN set -eux; \
    arch="$(dpkg --print-architecture)"; \
    case "$arch" in amd64) n=x64 ;; arm64) n=arm64 ;; *) echo "unsupported arch $arch"; exit 1 ;; esac; \
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${n}.tar.xz" \
        | tar -xJ -C /usr/local && mv "/usr/local/node-v${NODE_VERSION}-linux-${n}" /usr/local/node

# Rust stable (rustup), with clippy for the `-D warnings` check.
RUN curl -fsSL https://sh.rustup.rs | sh -s -- -y --profile minimal --default-toolchain stable \
    && rustup component add clippy rustfmt

# Build artifacts live in volumes, never in the macOS checkout (see linux-dev.sh).
ENV CARGO_TARGET_DIR=/cache/target
WORKDIR /work
