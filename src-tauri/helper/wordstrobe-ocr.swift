// wordstrobe-ocr: long-lived Vision OCR helper for Wordstrobe (PLAN.md section 3 and 7).
//
//   stdin  one JSON request per line:  {"id":7,"path":"/abs/x.png","langs":[],"fast":false}
//   stdout exactly one JSON line per request, written (not buffered) as soon as it is ready
//   stderr diagnostics only
//
// `wordstrobe-ocr --selftest` renders known passages and checks OCR accuracy through the same
// `recognize` function. Build with scripts/build-helper.sh (needs the macOS 26 SDK, runs on 15+).
import CoreText
import Foundation
import ImageIO
import NaturalLanguage
import Vision

// MARK: - OCR (shared by requests and --selftest)

struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct Line: Sendable { let t: String; let x, y, w, h, c: Double }

struct Ocr: Sendable {
    var paragraphs: [String]?   // RecognizeDocumentsRequest (macOS 26+)
    var tables = 0
    var lines: [Line] = []      // RecognizeTextRequest
    var lang = "und"
    var texts: [String] { paragraphs ?? lines.map(\.t) }
}

/// `documents: false` forces the text path on macOS 26+ (the selftest compares both).
func recognize(_ image: CGImage, langs: [String], fast: Bool, documents: Bool = true) async throws -> Ocr {
    let languages = langs.map { Locale.Language(identifier: $0) }  // empty = auto-detect
    var ocr = Ocr()
    if #available(macOS 26, *), documents, !fast {
        var request = RecognizeDocumentsRequest()
        request.textRecognitionOptions.useLanguageCorrection = true
        request.textRecognitionOptions.automaticallyDetectLanguage = languages.isEmpty
        if !languages.isEmpty { request.textRecognitionOptions.recognitionLanguages = languages }
        let document = try await request.perform(on: image).first?.document
        ocr.paragraphs = (document?.paragraphs ?? []).map(\.transcript).filter { !$0.isEmpty }
        ocr.tables = document?.tables.count ?? 0
    } else {
        var request = RecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = true
        // Vision's default (1/32 of the image height) makes .fast drop all text smaller than that, i.e. most captures.
        request.minimumTextHeightFraction = 0
        request.automaticallyDetectsLanguage = languages.isEmpty
        if !languages.isEmpty { request.recognitionLanguages = languages }
        ocr.lines = try await request.perform(on: image).compactMap { obs in
            guard let top = obs.topCandidates(1).first else { return nil }
            let b = obs.boundingBox  // normalized, bottom-left origin -> flip y to top-left
            return Line(t: top.string, x: b.origin.x, y: 1 - b.origin.y - b.height, w: b.width, h: b.height,
                        c: Double(top.confidence))
        }
    }
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(ocr.texts.joined(separator: "\n"))
    ocr.lang = recognizer.dominantLanguage?.rawValue ?? "und"
    return ocr
}

func loadImage(_ path: String) throws -> CGImage {
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil)
    else { throw Failure("cannot read image at \(path)") }
    return image
}

// MARK: - JSON lines

func round4(_ v: Double) -> Double { (v * 10_000).rounded() / 10_000 }

func ms(since t0: ContinuousClock.Instant) -> Int { Int((t0.duration(to: .now) / .milliseconds(1)).rounded()) }

/// One write(2) per line, so the parent never waits on a stdio buffer.
func send(_ object: [String: Any]) {
    var object = object
    if !JSONSerialization.isValidJSONObject(object) { object = ["id": object["id"] ?? NSNull(), "error": "unencodable response"] }
    guard var data = try? JSONSerialization.data(withJSONObject: object, options: [.withoutEscapingSlashes]) else { return }
    data.append(10)
    try? FileHandle.standardOutput.write(contentsOf: data)
}

func warn(_ message: String) { try? FileHandle.standardError.write(contentsOf: Data("wordstrobe-ocr: \(message)\n".utf8)) }

func serve(_ text: String) async {
    guard let request = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
        return send(["id": NSNull(), "error": "malformed request: expected one JSON object per line"])
    }
    let id = request["id"] ?? NSNull()
    guard let path = request["path"] as? String else { return send(["id": id, "error": "missing \"path\""]) }
    let t0 = ContinuousClock.now
    do {
        let ocr = try await recognize(try loadImage(path), langs: request["langs"] as? [String] ?? [],
                                      fast: request["fast"] as? Bool ?? false)
        var response: [String: Any] = ["id": id, "lang": ocr.lang]
        if let paragraphs = ocr.paragraphs {
            response["paragraphs"] = paragraphs
            response["tables"] = ocr.tables
        } else {
            response["lines"] = ocr.lines.map {
                ["t": $0.t, "x": round4($0.x), "y": round4($0.y), "w": round4($0.w), "h": round4($0.h), "c": round4($0.c)] as [String: Any]
            }
        }
        response["ms"] = ms(since: t0)
        send(response)
    } catch {
        send(["id": id, "error": error.localizedDescription])
    }
}

// MARK: - Rendering (pre-warm and --selftest)

func makeImage(_ width: Int, _ height: Int, dark: Bool, draw: (CGContext) -> Void = { _ in }) -> CGImage {
    let context = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                            space: CGColorSpace(name: CGColorSpace.sRGB)!,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    context.setFillColor(CGColor(gray: dark ? 0.1 : 1, alpha: 1))
    context.fill(CGRect(x: 0, y: 0, width: width, height: height))
    draw(context)
    return context.makeImage()!
}

/// Text wrapped to 640 pt, drawn at 2x like a Retina capture.
func render(_ text: String, size: CGFloat, fontName: String?, dark: Bool) -> CGImage {
    let scale: CGFloat = 2, width: CGFloat = 640, pad: CGFloat = 20
    let font = fontName.map { CTFontCreateWithName($0 as CFString, size, nil) } ?? CTFontCreateUIFontForLanguage(.system, size, nil)!
    let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: dark ? 1 : 0, alpha: 1)]
    let string = CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!
    let setter = CTFramesetterCreateWithAttributedString(string)
    let fit = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(), nil, CGSize(width: width - 2 * pad, height: .greatestFiniteMagnitude), nil)
    let box = CGRect(x: pad, y: pad, width: width - 2 * pad, height: ceil(fit.height) + 2)
    let frame = CTFramesetterCreateFrame(setter, CFRange(), CGPath(rect: box, transform: nil), nil)
    return makeImage(Int(width * scale), Int((box.height + 2 * pad) * scale), dark: dark) {
        $0.scaleBy(x: scale, y: scale)
        CTFrameDraw(frame, $0)
    }
}

/// Runs the real OCR path once so Vision has loaded its models before the first request.
func warmUp() async {
    do { _ = try await recognize(makeImage(64, 64, dark: false), langs: [], fast: false) }
    catch { warn("pre-warm failed: \(error.localizedDescription)") }
}

// MARK: - --selftest

func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
    var row = Array(0...b.count)
    for (i, x) in a.enumerated() {
        var diagonal = row[0]
        row[0] = i + 1
        for (j, y) in b.enumerated() {
            let above = row[j + 1]
            row[j + 1] = min(above + 1, row[j] + 1, diagonal + (x == y ? 0 : 1))
            diagonal = above
        }
    }
    return row[b.count]
}

func accuracy(expected: String, got: String, stripSpaces: Bool) -> Double {
    func norm(_ s: String) -> [Character] {
        let words = s.split(whereSeparator: \.isWhitespace)
        return Array(words.joined(separator: stripSpaces ? "" : " "))
    }
    let want = norm(expected)
    return max(0, 1 - Double(levenshtein(want, norm(got))) / Double(want.count))
}

struct Passage {
    let name: String, font: String?, language: String, text: String
}

let passages = [
    Passage(name: "en", font: nil, language: "en-US", text: """
        Rapid serial visual presentation shows words one at a time at a fixed focal point, removing the eye \
        movements that dominate normal reading. Most readers can comfortably reach 400 to 500 words per minute \
        after a short break, while comprehension depends on punctuation pauses and the ability to rewind a sentence.
        """),
    Passage(name: "de", font: nil, language: "de-DE", text: """
        Die schnelle serielle Präsentation zeigt Wörter einzeln an einer festen Stelle, sodass die Augen kaum noch \
        springen müssen. Große Texte lassen sich so bequem überfliegen, während Satzzeichen kurze Pausen für das \
        Verständnis schaffen. Weiß ist die Straße vor dem Fußgängertunnel, und über zwanzig Läufer müssen früh starten.
        """),
    Passage(name: "zh", font: "PingFangSC-Regular", language: "zh-Hans", text: """
        快速序列视觉呈现一次只显示一个词，并将它固定在同一个位置，从而减少眼球的移动。大多数读者在短暂的适应之后，\
        可以轻松达到每分钟四百到五百个词的阅读速度，而理解程度取决于标点停顿以及回看上一句的能力。
        """),
]

enum Path: String { case docs, text, fast }

let minAccuracy = 0.98
/// Cases that genuinely cannot reach `minAccuracy`, keyed by "<lang> <size>px <polarity>".
let relaxedAccuracy: [String: Double] = [:]

/// docs and text (accurate) use automatic language detection and must reach `minAccuracy`.
/// fast is informational: it needs the language pinned and only supports Latin scripts.
func selftest() async -> Bool {
    await warmUp()
    print("case".padding(toLength: 28, withPad: " ", startingAt: 0) + "path   accuracy     ms")
    var failures = 0
    for passage in passages {
        for dark in [false, true] {
            for size in [11, 14, 20, 28] as [CGFloat] {
                let image = render(passage.text, size: size, fontName: passage.font, dark: dark)
                let name = "\(passage.name) \(Int(size))px \(dark ? "light-on-dark" : "dark-on-light")"
                var paths: [Path] = [.text, .fast]
                if #available(macOS 26, *) { paths.insert(.docs, at: 0) }
                for path in paths {
                    let t0 = ContinuousClock.now
                    let ocr = try? await recognize(image, langs: path == .fast ? [passage.language] : [], fast: path == .fast,
                                                   documents: path == .docs)
                    let elapsed = ms(since: t0)
                    let got = (ocr?.texts ?? []).joined(separator: " ")
                    let score = accuracy(expected: passage.text, got: got, stripSpaces: passage.name == "zh")
                    let pass = path == .fast || score >= (relaxedAccuracy[name] ?? minAccuracy)
                    if !pass { failures += 1 }
                    print(name.padding(toLength: 28, withPad: " ", startingAt: 0) + path.rawValue.padding(toLength: 7, withPad: " ", startingAt: 0)
                          + String(format: "%7.3f  %5d", score, elapsed) + (pass ? "" : "  FAIL"))
                }
            }
        }
    }
    print(failures == 0 ? "selftest passed (fast rows are informational)" : "selftest FAILED: \(failures) case(s) below \(minAccuracy)")
    return failures == 0
}

// MARK: - main

if CommandLine.arguments.contains("--selftest") {
    exit(await selftest() ? 0 : 1)
}
await warmUp()
send(["ready": true])
while let line = readLine() {
    if line.allSatisfy(\.isWhitespace) { continue }
    await serve(line)
}
