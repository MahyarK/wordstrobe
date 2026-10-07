// Spike: does the Web Speech API inside WKWebView (what Tauri uses on macOS) fire word-boundary events?
// Run: swiftc -O -o /tmp/webspeech spikes/webspeech_boundary.swift && /tmp/webspeech
// Result on macOS 26.6: yes - `boundary word charIndex=N len=M t=S` per word, then `end`.
// Gotcha: getVoices() is empty until the `voiceschanged` event fires.
import AppKit
import WebKit

final class Log: NSObject, WKScriptMessageHandler {
    func userContentController(_ c: WKUserContentController, didReceive m: WKScriptMessage) {
        let line = "\(m.body)"
        print(line)
        if line.hasPrefix("end") || line.hasPrefix("error") { exit(0) }
    }
}

let app = NSApplication.shared
let cfg = WKWebViewConfiguration()
let log = Log()
cfg.userContentController.add(log, name: "log")
let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 200, height: 200), configuration: cfg)
let win = NSWindow(contentRect: web.frame, styleMask: [.borderless], backing: .buffered, defer: false)
win.contentView = web
web.loadHTMLString("""
<script>
const log = m => webkit.messageHandlers.log.postMessage(m);
log('speechSynthesis available: ' + ('speechSynthesis' in window));
setTimeout(() => {
  log('voices at t=0.5s: ' + speechSynthesis.getVoices().length);
  const u = new SpeechSynthesisUtterance('Rapid serial visual presentation, read aloud.');
  u.volume = 0; // silent: we only want the events
  u.onboundary = e => log(`boundary ${e.name} charIndex=${e.charIndex} len=${e.charLength} t=${e.elapsedTime.toFixed(2)}`);
  u.onend = () => log('end');
  u.onerror = e => log('error ' + e.error);
  speechSynthesis.speak(u);
}, 500);
</script>
""", baseURL: nil)
DispatchQueue.main.asyncAfter(deadline: .now() + 15) { print("timeout"); exit(1) }
app.run()
