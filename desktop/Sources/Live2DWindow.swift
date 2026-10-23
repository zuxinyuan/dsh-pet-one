// Live2DWindow — a transparent, always-on-top WKWebView that renders the
// A8Chann/whale-girl Live2D model with its vendor engine, plus a tiny local
// HTTP server (python -m http.server) so the model files load normally.
import AppKit
import WebKit

final class Live2DWindow: NSPanel, WKScriptMessageHandler {
    private var webView: WKWebView!
    private var server: Process?
    private var port: Int = 0
    private var ready = false
    private var pendingPid: pid_t?

    var onPat: (() -> Void)?
    var onMenu: (() -> Void)?
    var onError: ((String) -> Void)?

    init(directory: URL) {
        let size = NSSize(width: 320, height: 420)
        super.init(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        level = .statusBar
        hidesOnDeactivate = false
        isMovableByWindowBackground = false
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        let config = WKWebViewConfiguration()
        config.userContentController.add(self, name: "live2d")
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")
        webView = WKWebView(frame: NSRect(origin: .zero, size: size), configuration: config)
        webView.setValue(false, forKey: "drawsBackground")
        webView.autoresizingMask = [.width, .height]
        contentView = webView

        startServer(directory: directory)
    }

    // MARK: server

    private func startServer(directory: URL) {
        guard let python = Self.pythonBinary() else {
            onError?("找不到 python3，Live2D 无法加载")
            return
        }
        for candidate in [8791, 8792, 8793, 8794, 8795, 8796, 8797, 8798] {
            let process = Process()
            process.executableURL = URL(fileURLWithPath: python)
            process.arguments = ["-m", "http.server", String(candidate), "--bind", "127.0.0.1", "--directory", directory.path]
            process.standardOutput = FileHandle.nullDevice
            process.standardError = FileHandle.nullDevice
            do {
                try process.run()
            } catch {
                continue
            }
            if waitForServer(port: candidate) {
                server = process
                port = candidate
                loadPage()
                return
            }
            process.terminate()
        }
        onError?("Live2D 本地服务启动失败")
    }

    private func waitForServer(port: Int) -> Bool {
        let deadline = Date().addingTimeInterval(2.0)
        let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
        while Date() < deadline {
            var request = URLRequest(url: url)
            request.timeoutInterval = 0.3
            let semaphore = DispatchSemaphore(value: 0)
            var ok = false
            URLSession.shared.dataTask(with: request) { _, response, _ in
                if let http = response as? HTTPURLResponse, http.statusCode == 200 { ok = true }
                semaphore.signal()
            }.resume()
            _ = semaphore.wait(timeout: .now() + 0.5)
            if ok { return true }
            Thread.sleep(forTimeInterval: 0.1)
        }
        return false
    }

    private func loadPage() {
        let url = URL(string: "http://127.0.0.1:\(port)/index.html")!
        webView.load(URLRequest(url: url))
    }

    // MARK: window

    func showAtDefaultPosition() {
        if let screen = NSScreen.screens.first {
            let frame = screen.visibleFrame
            let size = self.frame.size
            let origin = NSPoint(
                x: frame.maxX - size.width - 24,
                y: frame.minY + 24
            )
            setFrameOrigin(origin)
        }
        orderFrontRegardless()
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

    func stop() {
        server?.terminate()
        server = nil
    }

    deinit {
        server?.terminate()
    }

    static func pythonBinary() -> String? {
        for path in ["/usr/bin/python3", "/opt/homebrew/bin/python3", "/usr/local/bin/python3"] {
            if FileManager.default.isExecutableFile(atPath: path) { return path }
        }
        return nil
    }

    // MARK: messages

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "live2d", let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }
        switch action {
        case "ready":
            ready = true
        case "drag":
            if let dx = body["dx"] as? Double, let dy = body["dy"] as? Double {
                var origin = frame.origin
                origin.x += dx
                origin.y -= dy
                setFrameOrigin(origin)
            }
        case "pat":
            onPat?()
        case "menu":
            onMenu?()
        case "error":
            onError?(body["message"] as? String ?? "Live2D 渲染失败")
        default:
            break
        }
    }
}
