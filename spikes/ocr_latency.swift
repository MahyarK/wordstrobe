// Spike: Vision OCR latency, cold vs warm, on a rendered screen-like 1600x1000 px image.
// Run: swiftc -O -o /tmp/ocr_latency spikes/ocr_latency.swift && /tmp/ocr_latency
// Result on M3 Pro / macOS 26.6: accurate 508 ms cold, ~300 ms warm; fast ~35 ms;
// RecognizeDocumentsRequest ~270 ms and returns ready-made paragraphs.
import AppKit
import Vision

let para = """
Rapid serial visual presentation shows words one at a time at a fixed focal point, \
removing the eye movements that dominate normal reading. Most readers can comfortably \
reach 400 to 500 words per minute after a short warm-up, while comprehension depends on \
punctuation pauses and the ability to rewind a sentence.
"""
let text = Array(repeating: para, count: 3).joined(separator: "\n\n")

let size = NSSize(width: 1600, height: 1000) // ~ an 800x500 pt region on a Retina screen
let img = NSImage(size: size)
img.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: size).fill()
(text as NSString).draw(in: NSRect(x: 40, y: 40, width: size.width - 80, height: size.height - 80),
                        withAttributes: [.font: NSFont.systemFont(ofSize: 26), .foregroundColor: NSColor.black])
img.unlockFocus()
var rect = NSRect(origin: .zero, size: size)
let cg = img.cgImage(forProposedRect: &rect, context: nil, hints: nil)!

func ms(since t0: Date) -> Int { Int(Date().timeIntervalSince(t0) * 1000) }

for i in 1...3 {
    var t0 = Date()
    var accurate = RecognizeTextRequest()
    accurate.recognitionLevel = .accurate
    let lines = try await accurate.perform(on: cg)
    print("text accurate #\(i): \(ms(since: t0)) ms, \(lines.count) lines")

    t0 = Date()
    var fast = RecognizeTextRequest()
    fast.recognitionLevel = .fast
    _ = try await fast.perform(on: cg)
    print("text fast     #\(i): \(ms(since: t0)) ms")

    t0 = Date()
    let docs = try await RecognizeDocumentsRequest().perform(on: cg) // macOS 26+
    let paragraphs = docs.first?.document.paragraphs ?? []
    print("documents     #\(i): \(ms(since: t0)) ms, \(paragraphs.count) paragraphs")
    if i == 3 { print("first paragraph: " + (paragraphs.first?.transcript ?? "<none>")) }
}
