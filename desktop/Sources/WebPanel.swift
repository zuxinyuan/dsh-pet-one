// WebPanel — the Honkai: Star Rail styled dashboard, rendered as HTML/CSS in a
// WKWebView so the whole look can be iterated like a web page.
import AppKit
import WebKit

final class WebPanel: NSPanel, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var ready = false
    private var latestState: [String: Any]?
    var onAction: ((String, [String: Any]) -> Void)?

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 400, height: 640),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = true
        level = .statusBar
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "pet")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 400, height: 640), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")

        webView.autoresizingMask = [.width, .height]
        contentView = webView

        let root = Bundle.main.resourceURL?.appendingPathComponent("panel")
            ?? URL(fileURLWithPath: FileManager.default.currentDirectoryPath).appendingPathComponent("panel")
        webView.loadFileURL(root.appendingPathComponent("index.html"), allowingReadAccessTo: root)
    }

    override var canBecomeKey: Bool { true }

    func push(_ state: [String: Any]) {
        latestState = state
        guard ready, JSONSerialization.isValidJSONObject(state),
              let data = try? JSONSerialization.data(withJSONObject: state),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__render(\(json))")
    }

    func snapshot(to path: String) {
        let config = WKSnapshotConfiguration()
        webView.takeSnapshot(with: config) { image, _ in
            guard let image, let tiff = image.tiffRepresentation,
                  let rep = NSBitmapImageRep(data: tiff),
                  let png = rep.representation(using: .png, properties: [:]) else { return }
            try? png.write(to: URL(fileURLWithPath: path))
        }
    }

    func show(near petFrame: NSRect) {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        var origin = NSPoint(x: petFrame.minX - frame.width - 14, y: petFrame.maxY - frame.height)
        if origin.x < screen.minX + 8 {
            origin.x = min(screen.maxX - frame.width - 8, petFrame.maxX + 14)
        }
        origin.y = min(max(origin.y, screen.minY + 8), screen.maxY - frame.height - 8)
        setFrameOrigin(origin)
        orderFrontRegardless()
        makeKey()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.03) { [weak self] in
            self?.webView.evaluateJavaScript("window.__replayIntro && window.__replayIntro()")
        }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "pet", let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        if action == "ready" {
            ready = true
            if let latestState { push(latestState) }
            return
        }
        onAction?(action, body)
    }
}
