// Exercise macOS's actual WKWebView engine against the same production fixture
// as Chromium. The window stays offscreen and does not activate the app.
import AppKit
import WebKit

final class MermaidReview: NSObject, WKNavigationDelegate, WKScriptMessageHandler {
    private let webView: WKWebView
    private let window: NSWindow
    private let base: String
    private let output: URL
    private var index = 0
    private var results: [[String: Any]] = []
    private let cases = [
        "theme=light&variant=tools", "theme=light&variant=tools&hostile=1",
        "theme=dark&variant=tools&hostile=1", "theme=light&variant=shapes&hostile=1",
        "theme=dark&variant=shapes&hostile=1", "theme=dark&variant=directives&hostile=1",
        "theme=light&variant=long-circle&hostile=1", "theme=dark&variant=long-circle&hostile=1",
        "theme=light&variant=explicit-breaks&hostile=1", "theme=dark&variant=explicit-breaks&hostile=1",
        "theme=light&variant=markdown-multiline&hostile=1", "theme=dark&variant=markdown-multiline&hostile=1",
        "theme=light&variant=flowchart-custom&hostile=1&isolation=1",
        "theme=dark&variant=flowchart-custom&hostile=1&isolation=1"
    ]

    init(base: String, output: URL) {
        self.base = base
        self.output = output
        let configuration = WKWebViewConfiguration()
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1024, height: 900), configuration: configuration)
        window = NSWindow(contentRect: NSRect(x: -4000, y: 0, width: 1024, height: 900), styleMask: .borderless, backing: .buffered, defer: false)
        super.init()
        window.contentView = webView
        configuration.userContentController.add(self, name: "mermaidReview")
        webView.navigationDelegate = self
    }

    func start() {
        window.orderFrontRegardless()
        loadNext()
    }

    private func fail(_ message: String) -> Never {
        fputs("WKWebView Mermaid review failed: \(message)\n", stderr)
        window.orderOut(nil)
        exit(1)
    }

    private func loadNext() {
        if index == cases.count {
            do {
                let data = try JSONSerialization.data(withJSONObject: results, options: [.prettyPrinted, .sortedKeys])
                try data.write(to: output.appendingPathComponent("webkit-geometry.json"))
            } catch { fail(String(describing: error)) }
            print("WKWebView rendered \(results.count) production diagram configurations.")
            window.orderOut(nil)
            exit(0)
        }
        print("WKWebView loading \(index + 1)/\(cases.count): \(cases[index])")
        fflush(stdout)
        webView.load(URLRequest(url: URL(string: "\(base)/__ui-review?\(cases[index])")!))
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("WKWebView loaded \(index + 1)/\(cases.count)")
        fflush(stdout)
        webView.evaluateJavaScript("""
        void (async () => {
          try {
            const waitForDiagram = async previous => {
              const deadline = Date.now() + 60000;
              while (true) {
                const image = document.querySelector('.md-mermaid-diagram img');
                if (image?.complete && image.naturalWidth > 0 && image.src !== previous) {
                  await image.decode();
                  return;
                }
                const error = document.querySelector('.md-mermaid-error');
                if (error) throw new Error(error.textContent);
                if (Date.now() > deadline) throw new Error('Diagram render timed out');
                await new Promise(resolve => setTimeout(resolve, 50));
              }
            };
            const expected = () => {
              const {kind, source, labels, edges, minLines} = window.__mermaidReview;
              return {kind, source, labels, edges, minLines};
            };
            const select = async variant => {
              const previous = document.querySelector('.md-mermaid-diagram img').src;
              window.__mermaidReview.select(variant);
              await waitForDiagram(previous);
              return window.__mermaidReview.inspect();
            };
            await waitForDiagram();
            const response = {expected: expected(), result: await window.__mermaidReview.inspect()};
            if (new URLSearchParams(location.search).get('isolation') === '1') {
              response.baseline = response.result;
              response.between = await select('directives');
              response.betweenExpected = expected();
              response.result = await select('flowchart-custom');
              response.expected = expected();
            }
            window.webkit.messageHandlers.mermaidReview.postMessage(JSON.stringify(response));
          } catch (error) {
            window.webkit.messageHandlers.mermaidReview.postMessage(JSON.stringify({error: String(error)}));
          }
        })();
        """) { _, error in
            if let error = error { self.fail(String(describing: error)) }
        }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        fail(String(describing: error))
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        fail(String(describing: error))
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        fail("Web content process terminated during case \(index + 1)")
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard let text = message.body as? String,
              let data = text.data(using: .utf8),
              var result = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { fail("Invalid geometry response") }
        if let error = result["error"] { fail(String(describing: error)) }
        result["key"] = "webkit-\(index)"
        result["case"] = cases[index]
        results.append(result)
        webView.takeSnapshot(with: nil) { image, error in
            if let error = error { self.fail(String(describing: error)) }
            guard let data = image?.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: data),
                  let png = bitmap.representation(using: .png, properties: [:])
            else { self.fail("Could not capture WKWebView") }
            do { try png.write(to: self.output.appendingPathComponent("webkit-\(self.index).png")) }
            catch { self.fail(String(describing: error)) }
            self.index += 1
            self.loadNext()
        }
    }
}

guard CommandLine.arguments.count == 3 else {
    fputs("Usage: swift validate-mermaid-webkit.swift BASE_URL OUTPUT_DIRECTORY\n", stderr)
    exit(1)
}
let app = NSApplication.shared
// The review window stays offscreen; keep this user-requested verification
// active so App Nap cannot suspend its WebKit work between navigations.
let activity = ProcessInfo.processInfo.beginActivity(options: [.userInitiatedAllowingIdleSystemSleep], reason: "Validate native diagram rendering")
app.setActivationPolicy(.accessory)
let review = MermaidReview(base: CommandLine.arguments[1], output: URL(fileURLWithPath: CommandLine.arguments[2], isDirectory: true))
Timer.scheduledTimer(withTimeInterval: 180, repeats: false) { _ in
    fputs("WKWebView Mermaid review timed out\n", stderr)
    exit(1)
}
review.start()
app.run()
