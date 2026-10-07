// wordstrobe-ocr: long-lived Vision OCR helper for Wordstrobe (PLAN.md section 3 and 7).
//
//   stdin  one JSON request per line:  {"id":7,"path":"/abs/x.png","langs":[],"fast":false}
//   stdout exactly one JSON line per request, written (not buffered) as soon as it is ready
//   stderr diagnostics only
//
// `wordstrobe-ocr --selftest` renders known passages and checks OCR accuracy through the same
// `recognize` and `respond` functions. Build with scripts/build-helper.sh (needs the macOS 26 SDK, runs on 15+).
import CoreText
import Foundation
import ImageIO
import NaturalLanguage
import UniformTypeIdentifiers
import Vision

// MARK: - OCR (shared by requests and --selftest)

struct Failure: LocalizedError {
    let errorDescription: String?
    init(_ message: String) { errorDescription = message }
}

struct Line: Sendable { let t: String; let x, y, w, h, c: Double }  // normalized, top-left origin
struct Paragraph: Sendable { let text: String; let lines: [Line] }

struct Ocr: Sendable {
    var paragraphs: [Paragraph]?   // RecognizeDocumentsRequest (macOS 26+)
    var tables = 0
    var lines: [Line] = []         // RecognizeTextRequest
    var lang = "und"
    var texts: [String] { paragraphs?.map(\.text) ?? lines.map(\.t) }
    var characters: Int { texts.reduce(0) { $0 + $1.count } }
}

func line(_ obs: RecognizedTextObservation) -> Line? {
    guard let top = obs.topCandidates(1).first else { return nil }
    let b = obs.boundingBox  // normalized, bottom-left origin -> flip y to top-left
    return Line(t: top.string, x: b.origin.x, y: 1 - b.origin.y - b.height, w: b.width, h: b.height, c: Double(top.confidence))
}

/// One Vision request on one image. `documents: false` forces the text path on macOS 26+ (the selftest compares both).
func recognizeOnce(_ image: CGImage, languages: [Locale.Language], fast: Bool, documents: Bool) async throws -> Ocr {
    var ocr = Ocr()
    if #available(macOS 26, *), documents, !fast {
        var request = RecognizeDocumentsRequest()
        request.textRecognitionOptions.useLanguageCorrection = true
        request.textRecognitionOptions.automaticallyDetectLanguage = languages.isEmpty
        if !languages.isEmpty { request.textRecognitionOptions.recognitionLanguages = languages }
        let document = try await request.perform(on: image).first?.document
        ocr.paragraphs = (document?.paragraphs ?? []).map { Paragraph(text: $0.transcript, lines: $0.lines.compactMap(line)) }
            .filter { !$0.text.isEmpty }
        ocr.tables = document?.tables.count ?? 0
    } else {
        var request = RecognizeTextRequest()
        request.recognitionLevel = fast ? .fast : .accurate
        request.usesLanguageCorrection = true
        // Vision's default (1/32 of the image height) makes .fast drop all text smaller than that, i.e. most captures.
        request.minimumTextHeightFraction = 0
        request.automaticallyDetectsLanguage = languages.isEmpty
        if !languages.isEmpty { request.recognitionLanguages = languages }
        ocr.lines = try await request.perform(on: image).compactMap(line)
    }
    return ocr
}

// Vision's accurate model is unreliable on large and on tight images, so `recognize` works around three measured failures:
//  - tall: 2400x3956 px read 134 of 3800 words. Images above `bandMax` rows are read in overlapping bands, see `readBands`.
//  - wide: 2200-5120 px images lose whole lines (5120x1776 read 0 words), but the fast model, Latin only, reads them
//    all. Wider than `wideMin` px, both run and the one that read clearly more text wins.
//  - tight: 1-2 line crops lose their first letters ("ie schnelle") or turn to garbage, only when dark on light (46 of 396 images
//    at 11-14 px, 0 of 594 light on dark). A margin alone fixed the garbage but not the letters; inverting to light on dark
//    plus the margin leaves 2. So every image gets `margin` px of its corner colour on all sides and is made light on dark.
let bandMax = 2000
let bandHeight = 1400
let bandOverlap = 200
let wideMin = 2000
let margin = 48

/// n equal row ranges of at most `bandHeight` rows, each overlapping the next by `bandOverlap`.
func bandRows(_ height: Int) -> [Range<Int>] {
    guard height > bandMax else { return [0..<height] }
    let n = Int((Double(height - bandOverlap) / Double(bandHeight - bandOverlap)).rounded(.up))
    let h = (height + (n - 1) * bandOverlap + n - 1) / n
    return (0..<n).map { let top = $0 * (h - bandOverlap); return top..<min(top + h, height) }
}

/// Bands are read concurrently. A line belongs to the band whose own region (the band minus half the overlap at each seam)
/// holds its centre, so every line is read once, away from a band edge, with no text to compare. A paragraph that
/// began above a band's region continues the paragraph the previous band left in the same column.
func readBands(_ image: CGImage, languages: [Locale.Language], fast: Bool, documents: Bool) async throws -> Ocr {
    let rows = bandRows(image.height), height = Double(image.height)
    let bands = try rows.map { r -> CGImage in
        if rows.count == 1 { return image }
        guard let band = image.cropping(to: CGRect(x: 0, y: r.lowerBound, width: image.width, height: r.count)) else { throw Failure("cannot crop image") }
        return band
    }
    let parts = try await withThrowingTaskGroup(of: (Int, Ocr).self) { group in
        for (i, band) in bands.enumerated() {
            group.addTask { (i, try await recognizeOnce(band, languages: languages, fast: fast, documents: documents)) }
        }
        return try await group.reduce(into: [Ocr](repeating: Ocr(), count: bands.count)) { $0[$1.0] = $1.1 }
    }
    var ocr = Ocr()
    for (i, r) in rows.enumerated() {
        let top = Double(r.lowerBound) / height, span = Double(r.count) / height
        func place(_ l: Line) -> Line { Line(t: l.t, x: l.x, y: top + l.y * span, w: l.w, h: l.h * span, c: l.c) }
        let lo = i == 0 ? -Double.infinity : Double(r.lowerBound + bandOverlap / 2) / height
        let hi = i == rows.count - 1 ? Double.infinity : Double(r.upperBound - bandOverlap / 2) / height
        func mine(_ l: Line) -> Bool { (lo..<hi).contains(l.y + l.h / 2) }
        ocr.tables += parts[i].tables
        ocr.lines += parts[i].lines.map(place).filter(mine)
        let earlier = ocr.paragraphs?.count ?? 0
        if parts[i].paragraphs != nil { ocr.paragraphs = ocr.paragraphs ?? [] }
        for p in parts[i].paragraphs ?? [] {
            let lines = p.lines.map(place), own = lines.filter(mine)
            guard let first = own.first else { continue }
            let text = own.count == lines.count ? p.text : own.map(\.t).joined(separator: " ")
            if let head = lines.first, !mine(head), let k = ocr.paragraphs![..<earlier].lastIndex(where: {
                $0.lines.last.map { $0.x < first.x + first.w && first.x < $0.x + $0.w } ?? false
            }) {
                ocr.paragraphs![k] = Paragraph(text: ocr.paragraphs![k].text + " " + text, lines: ocr.paragraphs![k].lines + own)
            } else {
                ocr.paragraphs!.append(Paragraph(text: text, lines: own))
            }
        }
    }
    return ocr
}

/// `image` with `margin` px of its top-left pixel's colour on every side, light-on-dark: a light background is inverted.
func framed(_ image: CGImage) -> CGImage {
    guard let corner = image.cropping(to: CGRect(x: 0, y: 0, width: 1, height: 1)) else { return image }
    let light = rowBytes(corner).prefix(3).reduce(0) { $0 + Int($1) } > 3 * 127
    let w = image.width + 2 * margin, h = image.height + 2 * margin
    return makeImage(w, h, dark: false) {
        $0.interpolationQuality = .none
        $0.draw(corner, in: CGRect(x: 0, y: 0, width: w, height: h))
        $0.draw(image, in: CGRect(x: margin, y: margin, width: image.width, height: image.height))
        if light {
            $0.setBlendMode(.difference)
            $0.setFillColor(CGColor(gray: 1, alpha: 1))
            $0.fill(CGRect(x: 0, y: 0, width: w, height: h))
        }
    }
}

// A selection dragged through a line leaves half its glyphs along the top or bottom edge. Vision reads that sliver as
// garbage ("mu murny upi ununs", 16 px tall in a document of 26 px lines) that also decides the language: vi for English.
// Measured on 144 images with the first or last line cut (4 paragraphs, en + de, 11/14/20 px, both polarities, 30/50/70 %
// of the line left; 135 garbage lines), against 96 crops with 0-4 px of margin and 72 more of lines with no ascenders or
// descenders ("more cows"), none of which has a cut line:
//  - confidence does not tell them apart: garbage reads 0.06-0.48, but "users" reads 0.46 and "Region" 0.38 on the documents
//    path, and the text path says only 0.3, 0.5 or 1.0 (garbage included).
//  - nor does glyph height: garbage is 0.19-0.69 of the other lines', whole lines without ascenders 0.5-0.7.
//  - the pixels do. A cut line has glyph ink in the image's own first (or last) pixel row under 31-88 % of its columns.
//    A whole line has none from 2 px (1 pt) of margin on; with 1 px at most 7 % (34 % without ascenders), and only a
//    crop at its very ink goes up to 52 %, and loses that line.
// So a line whose box reaches the top or bottom edge, with ink under at least `cutInk` of its columns in that row, is dropped.
let edgeReach = 2.0   // px: a line box this close to the top or bottom edge reaches it (cut lines overshoot it by 2-8 px)
let inkContrast = 64  // a pixel is glyph ink when one of its channels differs this much (of 255) from the top-left pixel
let cutInk = 0.15     // share of a line's columns

/// RGBA bytes of a one-pixel-high `strip`, drawn over white like everything `makeImage` makes.
func rowBytes(_ strip: CGImage) -> [UInt8] {
    let row = makeImage(strip.width, 1, dark: false) { $0.draw(strip, in: CGRect(x: 0, y: 0, width: strip.width, height: 1)) }
    return row.dataProvider?.data.map { Array(UnsafeBufferPointer(start: CFDataGetBytePtr($0), count: strip.width * 4)) } ?? []
}

/// `ocr` without the lines that the top or bottom edge of `image` (the unframed one) cuts through.
func withoutCutLines(_ ocr: Ocr, in image: CGImage) -> Ocr {
    let w = image.width, h = Double(image.height)
    guard let first = image.cropping(to: CGRect(x: 0, y: 0, width: w, height: 1)),
          let last = image.cropping(to: CGRect(x: 0, y: image.height - 1, width: w, height: 1))
    else { return ocr }
    let top = rowBytes(first), bottom = rowBytes(last)
    guard top.count >= w * 4, bottom.count >= w * 4 else { return ocr }
    func inked(_ row: [UInt8], _ l: Line) -> Bool {
        let from = max(0, Int(l.x * Double(w))), to = min(w, Int(((l.x + l.w) * Double(w)).rounded(.up)))
        let ink = (from..<max(from, to)).filter { x in (0..<3).contains { abs(Int(row[x * 4 + $0]) - Int(top[$0])) > inkContrast } }
        return !ink.isEmpty && Double(ink.count) >= cutInk * Double(to - from)
    }
    func cut(_ l: Line) -> Bool { (l.y * h < edgeReach && inked(top, l)) || ((l.y + l.h) * h > h - edgeReach && inked(bottom, l)) }

    var result = ocr
    result.lines = ocr.lines.filter { !cut($0) }
    result.paragraphs = ocr.paragraphs?.compactMap { p in
        let kept = p.lines.filter { !cut($0) }
        if kept.count == p.lines.count { return p }
        return kept.isEmpty ? nil : Paragraph(text: transcript(p, keeping: kept), lines: kept)
    }
    return result
}

/// `p`'s transcript cut down to the kept lines. Vision joins lines itself (it drops the hyphen of "Verkehrs-" + "infrastruktur"
/// but keeps that of "e-" + "mail"), so the transcript is cut at the kept lines rather than their texts joined again.
func transcript(_ p: Paragraph, keeping kept: [Line]) -> String {
    func stem(_ l: Line) -> String { l.t.hasSuffix("-") ? String(l.t.dropLast()) : l.t }  // a line-end hyphen may be gone from the transcript
    let text = p.text
    guard let from = text.range(of: stem(kept.first!)), let to = text.range(of: stem(kept.last!), options: .backwards),
          from.lowerBound <= to.lowerBound
    else { return kept.map(\.t).joined(separator: " ") }
    let end = kept.last!.t.hasSuffix("-") && text[to.upperBound...].hasPrefix("-") ? text.index(after: to.upperBound) : to.upperBound
    return String(text[from.lowerBound..<end])
}

/// BCP-47 language of `texts` (the kept ones), or "und" when NLLanguageRecognizer is not at least `minLanguageShare` sure:
/// "Hello world" is 0.31 en, a lone garbage line next to three list items was 0.32 vi. The reader falls back to the system voice.
let minLanguageShare = 0.5

func language(of texts: [String]) -> String {
    let recognizer = NLLanguageRecognizer()
    recognizer.processString(texts.joined(separator: "\n"))
    guard let best = recognizer.languageHypotheses(withMaximum: 1).first, best.value >= minLanguageShare else { return "und" }
    return best.key.rawValue
}

/// `documents: false` forces the text path on macOS 26+ (the selftest compares both).
func recognize(_ source: CGImage, langs: [String], fast: Bool, documents: Bool = true) async throws -> Ocr {
    let languages = langs.map { Locale.Language(identifier: $0) }  // empty = auto-detect
    let image = framed(source), wide = !fast && image.width > wideMin
    async let quick = wide ? try? await readBands(image, languages: languages, fast: true, documents: false) : nil
    var ocr = try await readBands(image, languages: languages, fast: fast, documents: documents)
    if let quick = await quick, quick.characters * 100 > ocr.characters * 125 { ocr = quick }
    // back to the unframed image
    let sx = Double(image.width) / Double(image.width - 2 * margin), sy = Double(image.height) / Double(image.height - 2 * margin)
    let ox = Double(margin) / Double(image.width - 2 * margin), oy = Double(margin) / Double(image.height - 2 * margin)
    func inner(_ l: Line) -> Line { Line(t: l.t, x: l.x * sx - ox, y: l.y * sy - oy, w: l.w * sx, h: l.h * sy, c: l.c) }
    ocr.lines = ocr.lines.map(inner)
    ocr.paragraphs = ocr.paragraphs?.map { Paragraph(text: $0.text, lines: $0.lines.map(inner)) }
    ocr = withoutCutLines(ocr, in: source)
    ocr.lang = language(of: ocr.texts)
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

/// One request line in, one response object out (`serve` writes it; --selftest checks it).
func respond(_ text: String) async -> [String: Any] {
    guard let request = (try? JSONSerialization.jsonObject(with: Data(text.utf8))) as? [String: Any] else {
        return ["id": NSNull(), "error": "malformed request: expected one JSON object per line"]
    }
    let id = request["id"] ?? NSNull()
    guard let path = request["path"] as? String else { return ["id": id, "error": "missing \"path\""] }
    let t0 = ContinuousClock.now
    do {
        let ocr = try await recognize(try loadImage(path), langs: request["langs"] as? [String] ?? [],
                                      fast: request["fast"] as? Bool ?? false)
        var response: [String: Any] = ["id": id, "lang": ocr.lang]
        if let paragraphs = ocr.paragraphs {
            response["paragraphs"] = paragraphs.map(\.text)
            response["tables"] = ocr.tables
        } else {
            response["lines"] = ocr.lines.map {
                ["t": $0.t, "x": round4($0.x), "y": round4($0.y), "w": round4($0.w), "h": round4($0.h), "c": round4($0.c)] as [String: Any]
            }
        }
        response["ms"] = ms(since: t0)
        return response
    } catch {
        return ["id": id, "error": error.localizedDescription]
    }
}

func serve(_ text: String) async { send(await respond(text)) }

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

/// A rendered paragraph and its lines: the text of each and its ink rows, in px from the top of the image.
struct Layout {
    let image: CGImage
    let lines: [(text: String, top: Double, bottom: Double)]
}

/// Text wrapped to `width` pt, drawn at 2x like a Retina capture.
func layout(_ text: String, size: CGFloat, fontName: String?, dark: Bool, width: CGFloat = 640) -> Layout {
    let scale: CGFloat = 2, pad: CGFloat = 20
    let font = fontName.map { CTFontCreateWithName($0 as CFString, size, nil) } ?? CTFontCreateUIFontForLanguage(.system, size, nil)!
    let attributes: [CFString: Any] = [kCTFontAttributeName: font, kCTForegroundColorAttributeName: CGColor(gray: dark ? 1 : 0, alpha: 1)]
    let string = CFAttributedStringCreate(nil, text as CFString, attributes as CFDictionary)!
    let setter = CTFramesetterCreateWithAttributedString(string)
    let fit = CTFramesetterSuggestFrameSizeWithConstraints(setter, CFRange(), nil, CGSize(width: width - 2 * pad, height: .greatestFiniteMagnitude), nil)
    let box = CGRect(x: pad, y: pad, width: width - 2 * pad, height: ceil(fit.height) + 2)
    let frame = CTFramesetterCreateFrame(setter, CFRange(), CGPath(rect: box, transform: nil), nil)
    let image = makeImage(Int(width * scale), Int((box.height + 2 * pad) * scale), dark: dark) {
        $0.scaleBy(x: scale, y: scale)
        CTFrameDraw(frame, $0)
    }
    let lines = CTFrameGetLines(frame) as? [CTLine] ?? []
    var origins = [CGPoint](repeating: .zero, count: lines.count)
    CTFrameGetLineOrigins(frame, CFRange(), &origins)
    return Layout(image: image, lines: zip(lines, origins).map { line, origin in
        let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds), range = CTLineGetStringRange(line)
        let top = box.height + 2 * pad - (box.minY + origin.y + ink.maxY), bottom = box.height + 2 * pad - (box.minY + origin.y + ink.minY)
        return ((text as NSString).substring(with: NSRange(location: range.location, length: range.length))
                    .trimmingCharacters(in: .whitespacesAndNewlines), Double(top * scale), Double(bottom * scale))
    })
}

func render(_ text: String, size: CGFloat, fontName: String?, dark: Bool, width: CGFloat = 640) -> CGImage {
    layout(text, size: size, fontName: fontName, dark: dark, width: width).image
}

/// The paragraph with only `visible` of the ink of its first (`top`) or last line left, the rest cut away by the image edge,
/// as when a selection is dragged through that line.
func halfCut(_ page: Layout, top: Bool, visible: Double) -> CGImage {
    let line = top ? page.lines.first! : page.lines.last!
    let from = top ? (line.top + (1 - visible) * (line.bottom - line.top)).rounded() : 0
    let to = top ? Double(page.image.height) : (line.top + visible * (line.bottom - line.top)).rounded()
    return page.image.cropping(to: CGRect(x: 0, y: from, width: Double(page.image.width), height: to - from))!
}

/// Runs the real OCR path once on a little rendered text, so Vision has loaded the recognizer before the first request.
/// (A blank image finishes in ~90 ms without loading it: the first real request then cost 60-90 ms more.)
func warmUp() async {
    do { _ = try await recognize(render("Warm up the reader now.", size: 14, fontName: nil, dark: false), langs: [], fast: false) }
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

func table(_ name: String, _ path: String, _ score: Double, _ elapsed: Int, pass: Bool = true) {
    print(name.padding(toLength: 28, withPad: " ", startingAt: 0) + path.padding(toLength: 7, withPad: " ", startingAt: 0)
          + String(format: "%7.3f  %5d", score, elapsed) + (pass ? "" : "  FAIL"))
}

/// docs and text (accurate) use automatic language detection and must reach `minAccuracy`.
/// fast is informational: it needs the language pinned and only supports Latin scripts.
func selftest() async -> Bool {
    await warmUp()
    print("case".padding(toLength: 28, withPad: " ", startingAt: 0) + "path   accuracy     ms")
    var failures = 0
    func check(_ name: String, _ path: String, _ score: Double, _ elapsed: Int, min: Double = minAccuracy, informational: Bool = false) {
        let pass = informational || score >= (relaxedAccuracy[name] ?? min)
        if !pass { failures += 1 }
        table(name, path, score, elapsed, pass: pass)
    }
    func expect(_ ok: Bool, _ what: String) {
        if !ok { failures += 1; print("FAIL  \(what)") }
    }
    var read = "", detected = ""  // what the last `score` call read, and the language it detected
    func score(_ image: CGImage, _ text: String, _ path: Path, langs: [String] = [], stripSpaces: Bool = false) async -> (Double, Int) {
        let t0 = ContinuousClock.now
        let ocr = try? await recognize(image, langs: path == .fast ? langs : [], fast: path == .fast, documents: path == .docs)
        let elapsed = ms(since: t0)
        read = (ocr?.texts ?? []).joined(separator: " ")
        detected = ocr?.lang ?? ""
        return (accuracy(expected: text, got: read, stripSpaces: stripSpaces), elapsed)
    }
    var paths: [Path] = [.text, .fast]
    if #available(macOS 26, *) { paths.insert(.docs, at: 0) }

    for passage in passages {
        for dark in [false, true] {
            for size in [11, 14, 20, 28] as [CGFloat] {
                let image = render(passage.text, size: size, fontName: passage.font, dark: dark)
                let name = "\(passage.name) \(Int(size))px \(dark ? "light-on-dark" : "dark-on-light")"
                for path in paths {
                    let (s, elapsed) = await score(image, passage.text, path, langs: [passage.language], stripSpaces: passage.name == "zh")
                    check(name, path.rawValue, s, elapsed, informational: path == .fast)
                }
            }
        }
    }

    // Tight crops: 1-2 lines, text almost touching the edges. The German two-liner lost "D" and "A" before the margin.
    let crops = [
        "Rapid serial visual presentation shows words one at a time.",
        "Rapid serial visual presentation shows words one at a time at a fixed focal point, removing the eye movements that dominate normal reading.",
        "Die schnelle serielle Präsentation zeigt Wörter einzeln an einer festen Stelle.",
        "Die schnelle serielle Präsentation zeigt Wörter einzeln an einer festen Stelle, sodass die Augen kaum noch springen müssen. Große Texte lassen sich so bequem überfliegen.",
    ]
    for text in crops {
        for size in [11, 14, 20] as [CGFloat] {
            let image = render(text, size: size, fontName: nil, dark: false)
            for path in paths where path != .fast {
                let (s, elapsed) = await score(image, text, path)
                check("\(text.prefix(2)) crop \(text.count)c \(Int(size))px", path.rawValue, s, elapsed)
                // One lost letter costs under 2 %, so check the first word on its own.
                expect(read.hasPrefix(text.prefix { $0 != " " }), "\(text.prefix(2)) crop \(Int(size))px \(path.rawValue) lost the first letters: \(read.prefix(20))")
            }
        }
    }

    // Cut lines: a selection dragged through the first or last line leaves part of its glyphs along the edge. Vision read that
    // sliver as garbage, and as "vi" for English. It must be gone, the lines beside it intact, the language right.
    let cuts: [(passage: Int, size: CGFloat, dark: Bool, top: Bool, visible: Double)] = [
        (0, 14, false, true, 0.5), (0, 14, true, false, 0.3), (0, 11, false, true, 0.7), (0, 20, true, false, 0.5),
        (1, 14, false, false, 0.7), (1, 11, true, true, 0.3), (1, 14, false, true, 0.5), (1, 20, true, false, 0.3),
    ]
    for c in cuts {
        let passage = passages[c.passage], page = layout(passage.text, size: c.size, fontName: nil, dark: c.dark)
        let whole = page.lines.dropFirst(c.top ? 1 : 0).dropLast(c.top ? 0 : 1).map(\.text).joined(separator: " ")
        let image = halfCut(page, top: c.top, visible: c.visible)
        let name = "cut \(passage.name) \(Int(c.size)) \(c.top ? "top" : "bot") \(Int(c.visible * 100))% \(c.dark ? "dark" : "light")-bg"
        for path in paths where path != .fast {
            let (s, elapsed) = await score(image, whole, path)
            check(name, path.rawValue, s, elapsed)
            expect(read.hasPrefix(whole.prefix { $0 != " " }), "\(name) \(path.rawValue) lost the first letters: \(read.prefix(20))")
            expect(detected == String(passage.language.prefix(2)), "\(name) \(path.rawValue) language \(detected)")
        }
    }
    expect(language(of: ["120 135 98 110"]) == "und", "language of digits only")

    // Tall: every section has a unique number, so a line lost or repeated at a band seam shows up.
    let sections = (1...24).map { "Section \($0). " + passages[$0 % 2].text }
    let tall = render(sections.joined(separator: "\n"), size: 14, fontName: nil, dark: false)
    print("tall image \(tall.width)x\(tall.height) px, \(bandRows(tall.height).count) bands")
    for path in paths where path != .fast {
        let (s, elapsed) = await score(tall, sections.joined(separator: " "), path)
        check("tall \(tall.height)px", path.rawValue, s, elapsed)
    }

    // Wide: lines of ~300 characters, which the accurate model alone loses.
    let wide = render(passages[0].text + " " + passages[0].text + " " + passages[0].text, size: 14, fontName: nil, dark: false, width: 1500)
    print("wide image \(wide.width)x\(wide.height) px")
    for path in paths where path != .fast {
        let (s, elapsed) = await score(wide, [passages[0].text, passages[0].text, passages[0].text].joined(separator: " "), path)
        check("wide \(wide.width)px", path.rawValue, s, elapsed)
    }

    // Protocol: the same function `serve` uses, with a real file and the JSON the Rust side sends.
    let dir = FileManager.default.temporaryDirectory.appendingPathComponent("wordstrobe-selftest-\(getpid())")
    try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    defer { try? FileManager.default.removeItem(at: dir) }
    func request(_ image: CGImage, id: Int, langs: [String], fast: Bool) async -> [String: Any] {
        let file = dir.appendingPathComponent("\(id).png")
        guard let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.png.identifier as CFString, 1, nil) else { return [:] }
        CGImageDestinationAddImage(destination, image, nil)
        CGImageDestinationFinalize(destination)
        let line = String(data: try! JSONSerialization.data(withJSONObject: ["id": id, "path": file.path, "langs": langs, "fast": fast] as [String: Any]), encoding: .utf8)!
        let response = await respond(line)
        // what the parent sees: one JSON line
        guard let data = try? JSONSerialization.data(withJSONObject: response),
              let parsed = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { expect(false, "request \(id): response is not JSON"); return [:] }
        return parsed
    }
    var id = 100
    for (passage, lang) in zip(passages, ["en", "de", "zh-Hans"]) {
        id += 1
        let r = await request(render(passage.text, size: 14, fontName: passage.font, dark: false), id: id, langs: [], fast: false)
        expect(r["id"] as? Int == id && r["lang"] as? String == lang && r["error"] == nil && r["ms"] is Int,
               "protocol \(passage.name): id/lang/ms in \(r.keys.sorted()), lang=\(r["lang"] ?? "nil") want \(lang)")
        expect((r["paragraphs"] as? [String])?.isEmpty == false || (r["lines"] as? [[String: Any]])?.isEmpty == false, "protocol \(passage.name): no text")
    }
    for (image, name) in [(render(passages[0].text, size: 14, fontName: nil, dark: false), "en"), (tall, "tall")] {
        id += 1
        let r = await request(image, id: id, langs: ["en-US"], fast: true)  // the text path (`lines`) on every macOS
        let ys = (r["lines"] as? [[String: Any]] ?? []).compactMap { $0["y"] as? Double }
        expect(r["id"] as? Int == id && ["en", "de"].contains(r["lang"] as? String ?? "") && ys.count > 2, "protocol \(name) fast: id/lang/lines in \(r.keys.sorted())")
        expect(zip(ys, ys.dropFirst()).allSatisfy { $0 < $1 } && ys.allSatisfy { 0...1 ~= $0 }, "protocol \(name) fast: lines not top to bottom")
    }
    // The case that went wrong: half a line of English above short lines (a list), as in a selection dragged through a document.
    let doc = layout("Intro paragraph about the quarterly numbers and what they mean for us.\n\n1. First list item about apples\n2. Second list item about bananas\n3. Third list item about cherries\n\nClosing paragraph after the table.",
                     size: 14, fontName: nil, dark: false)
    for fast in [false, true] {
        id += 1
        let r = await request(halfCut(doc, top: true, visible: 0.5), id: id, langs: fast ? ["en-US"] : [], fast: fast)
        let first = (r["paragraphs"] as? [String])?.first ?? (r["lines"] as? [[String: Any]])?.first?["t"] as? String ?? ""
        expect(r["lang"] as? String == "en" && first.hasPrefix("1. First list item"), "protocol cut first line (fast: \(fast)): lang=\(r["lang"] ?? "nil") first=\(first.prefix(30))")
    }
    let errors: [(String, String)] = [("not json", #"{"id":1,"path":"/nonexistent.png"}"#), ("no path", #"{"id":2}"#), ("garbage", "garbage")]
    for (name, line) in errors {
        let r = await respond(line)
        expect(r["error"] is String && r["lines"] == nil && r["paragraphs"] == nil, "protocol \(name): expected an error, got \(r)")
    }

    print(failures == 0 ? "selftest passed (fast rows are informational)" : "selftest FAILED: \(failures) case(s)")
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
