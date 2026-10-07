# Wordstrobe

Read any text on your screen faster. Press a shortcut, drag a box around text like a screenshot,
and a small popup flashes it one word at a time (Rapid Serial Visual Presentation), with optional
read-aloud. Everything runs on-device.

**Status:** planning. See [PLAN.md](PLAN.md) for the architecture, specs, milestones and the cross-platform roadmap.
macOS first (Tauri v2 + Apple Vision), then Windows and Linux.

## Spikes

The numbers in the plan come from these. Both need macOS 26 and Xcode:

```bash
swiftc -O -o /tmp/ocr_latency spikes/ocr_latency.swift && /tmp/ocr_latency
```

```bash
swiftc -O -o /tmp/webspeech spikes/webspeech_boundary.swift && /tmp/webspeech
```
