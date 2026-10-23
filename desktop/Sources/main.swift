// DSHPetOne — a tiny always-on-top desktop pet for macOS.
//
// Artwork: character packs (vlln/whale-girl by default, plus any user pack).
// The pet mirrors DeepSeek Harness by reading `~/.dsh/pet-one/live.json`
// (written by the dsh-pet-one host plugin); clicks are pats; interactions are
// queued to `~/.dsh/pet-one/commands.json` and applied by the host, so the web
// panel and this desktop pet share one progression.
//
// Build: ./build.sh   Run: open build/DSHPetOne.app
import AppKit
import QuartzCore
import UniformTypeIdentifiers

// MARK: - Paths

let home = FileManager.default.homeDirectoryForCurrentUser
let petDir: URL = {
    if let override = ProcessInfo.processInfo.environment["PETONE_HOME"], !override.isEmpty {
        return URL(fileURLWithPath: override, isDirectory: true)
    }
    return home.appendingPathComponent(".dsh/pet-one", isDirectory: true)
}()
let liveURL = petDir.appendingPathComponent("live.json")
let stateURL = petDir.appendingPathComponent("state.json")
let commandsURL = petDir.appendingPathComponent("commands.json")
let prefsURL = petDir.appendingPathComponent("desktop.json")
let packsDir = petDir.appendingPathComponent("packs", isDirectory: true)

func ensurePetDir() {
    try? FileManager.default.createDirectory(at: petDir, withIntermediateDirectories: true)
}

// MARK: - Durable desktop preferences

struct DesktopPrefs: Codable {
    var x: Double?
    var y: Double?
    var scale: Double?
    var packId: String?
    var voice: Bool?
    var form: String?
}

func loadPrefs() -> DesktopPrefs {
    guard let data = try? Data(contentsOf: prefsURL),
          let prefs = try? JSONDecoder().decode(DesktopPrefs.self, from: data) else {
        return DesktopPrefs(x: nil, y: nil, scale: nil, packId: nil, voice: nil, form: nil)
    }
    return prefs
}

func savePrefs(_ prefs: DesktopPrefs) {
    ensurePetDir()
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted]
    if let data = try? encoder.encode(prefs) {
        try? data.write(to: prefsURL, options: .atomic)
    }
}

// MARK: - Sprite view

final class PetView: NSView {
    var image: NSImage? {
        didSet { needsDisplay = true }
    }
    var onTap: (() -> Void)?
    var onRightClick: ((NSPoint) -> Void)?
    var onDragStart: (() -> Void)?
    var onDragEnd: ((NSPoint) -> Void)?

    private var dragStartMouse: NSPoint?
    private var dragStartOrigin: NSPoint?
    private var dragged = false

    override var acceptsFirstResponder: Bool { false }
    override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.current?.imageInterpolation = .high
        image?.draw(in: bounds, from: .zero, operation: .sourceOver, fraction: 1.0)
    }

    override func mouseDown(with event: NSEvent) {
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = window?.frame.origin
        dragged = false
        onDragStart?()
    }

    override func mouseDragged(with event: NSEvent) {
        guard let startMouse = dragStartMouse, let startOrigin = dragStartOrigin else { return }
        let mouse = NSEvent.mouseLocation
        let dx = mouse.x - startMouse.x
        let dy = mouse.y - startMouse.y
        if abs(dx) + abs(dy) > 3 { dragged = true }
        window?.setFrameOrigin(NSPoint(x: startOrigin.x + dx, y: startOrigin.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        defer {
            dragStartMouse = nil
            dragStartOrigin = nil
            dragged = false
        }
        guard let origin = window?.frame.origin else { return }
        if dragged {
            onDragEnd?(origin)
        } else {
            onTap?()
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        onRightClick?(NSEvent.mouseLocation)
    }
}

// MARK: - Bubble

final class BubblePanel: NSPanel {
    private let label = NSTextField(labelWithString: "")
    private let container = NSView()

    init() {
        super.init(
            contentRect: NSRect(x: 0, y: 0, width: 200, height: 36),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false
        ignoresMouseEvents = true
        level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 1)
        collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]

        container.wantsLayer = true
        container.layer?.backgroundColor = NSColor(calibratedWhite: 0.07, alpha: 0.92).cgColor
        container.layer?.cornerRadius = 9
        container.layer?.borderWidth = 1
        container.layer?.borderColor = NSColor(calibratedWhite: 1.0, alpha: 0.12).cgColor

        label.font = NSFont.systemFont(ofSize: 12, weight: .medium)
        label.textColor = NSColor(calibratedWhite: 0.96, alpha: 1)
        label.alignment = .center
        label.maximumNumberOfLines = 3
        label.lineBreakMode = .byWordWrapping
        label.translatesAutoresizingMaskIntoConstraints = false

        container.addSubview(label)
        contentView = container
        NSLayoutConstraint.activate([
            label.leadingAnchor.constraint(equalTo: container.leadingAnchor, constant: 9),
            label.trailingAnchor.constraint(equalTo: container.trailingAnchor, constant: -9),
            label.topAnchor.constraint(equalTo: container.topAnchor, constant: 6),
            label.bottomAnchor.constraint(equalTo: container.bottomAnchor, constant: -6),
        ])
        alphaValue = 0
    }

    func show(_ text: String, above petFrame: NSRect, duration: TimeInterval = 3.6) {
        label.stringValue = text
        let maxWidth: CGFloat = 230
        let attr = NSAttributedString(string: text, attributes: [.font: label.font as Any])
        let measured = attr.boundingRect(
            with: NSSize(width: maxWidth, height: 200),
            options: [.usesLineFragmentOrigin, .usesFontLeading]
        )
        let width = min(maxWidth, max(52, ceil(measured.width) + 18))
        let height = min(120, max(28, ceil(measured.height) + 12))
        let origin = NSPoint(x: petFrame.midX - width / 2, y: petFrame.maxY + 6)
        setFrame(NSRect(x: origin.x, y: origin.y, width: width, height: height), display: true)
        orderFrontRegardless()
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.14
            animator().alphaValue = 1
        }
        NSObject.cancelPreviousPerformRequests(withTarget: self, selector: #selector(hideBubble), object: nil)
        perform(#selector(hideBubble), with: nil, afterDelay: duration)
    }

    @objc private func hideBubble() {
        NSAnimationContext.runAnimationGroup({ context in
            context.duration = 0.22
            animator().alphaValue = 0
        }, completionHandler: { self.orderOut(nil) })
    }
}

// MARK: - App delegate

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var panel: NSPanel!
    private var petView: PetView!
    private var bubble: BubblePanel!
    private var infoPanel: WebPanel!
    private var statusItem: NSStatusItem!

    private var packs: [CharacterPack] = []
    private var pack: CharacterPack?
    private var fallbackFrames: [NSImage] = []
    private var prefs = DesktopPrefs(x: nil, y: nil, scale: nil, packId: nil, voice: nil, form: nil)

    private var pollTimer: Timer?
    private var animTimer: Timer?
    private var idleTimer: Timer?
    private var transientTimer: Timer?
    private var isDragging = false
    private var currentState = ""
    private var currentPhase = "idle"
    private var lastAction = Date()
    private var asleep = false

    private var lastDoneAt: Double = 0
    private var petName = "小鲸"
    private var affinity = 0
    private var treats = 20
    private var liveSnapshot: [String: Any]?
    private var live2dWindow: Live2DWindow?
    private var live2dActive = false
    private let voice = Voice()
    private var pomodoroEnd: Date?
    private var pomodoroTimer: Timer?
    private var alarmTimer: Timer?
    private var notesPanel: NSPanel?
    private var notesView: NSTextView?
    private var fishPanel: NSPanel?
    private var fishTimer: Timer?
    private var fishCatches = 0
    private var chatPending = false
    private var lastChatReplyAt: Double = 0

    private var baseSize = NSSize(width: 240, height: 240)

    func applicationDidFinishLaunching(_ notification: Notification) {
        ensurePetDir()
        prefs = loadPrefs()
        loadArtwork()
        buildPanel()
        buildInfoPanel()
        buildStatusItem()
        restorePosition()
        currentPhase = "idle"
        voice.enabled = prefs.voice ?? true
        playState("welcome", transientFor: 2.2)
        if prefs.form == "live2d", ProcessInfo.processInfo.environment["PETONE_OPEN_LIVE2D"] != "0" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in self?.launchLive2D() }
        }
        startBobbing()
        startPolling()
        startIdleWatch()
        NSSound(named: "Pop")?.play()
        if ProcessInfo.processInfo.environment["PETONE_OPEN_PANEL"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) { [weak self] in self?.toggleInfoPanel() }
        }
        if ProcessInfo.processInfo.environment["PETONE_OPEN_LIVE2D"] == "1" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in self?.launchLive2D() }
            if let path = ProcessInfo.processInfo.environment["PETONE_SNAPSHOT_LIVE2D"], !path.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 7.0) { [weak self] in
                    self?.live2dWindow?.snapshot(to: path)
                }
            }
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        live2dWindow?.stop()
        pollTimer?.invalidate()
        animTimer?.invalidate()
        idleTimer?.invalidate()
        transientTimer?.invalidate()
    }

    // MARK: setup

    private func loadArtwork() {
        packs = PackStore.discover()
        let wanted = prefs.packId ?? "whale-girl"
        pack = packs.first(where: { $0.id == wanted }) ?? packs.first
        if let pack {
            baseSize = pack.baseSize
            return
        }
        for name in ["frame0", "frame1"] {
            if let url = Bundle.main.url(forResource: name, withExtension: "png"),
               let image = NSImage(contentsOf: url) {
                fallbackFrames.append(image)
            }
        }
        if fallbackFrames.isEmpty {
            let cwd = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
            for name in ["frame0", "frame1"] {
                if let image = NSImage(contentsOf: cwd.appendingPathComponent("assets/\(name).png")) {
                    fallbackFrames.append(image)
                }
            }
        }
        baseSize = NSSize(width: 132, height: 170)
    }

    private func buildPanel() {
        let scale = prefs.scale ?? 1.0
        let size = NSSize(width: baseSize.width * scale, height: baseSize.height * scale)
        panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: size),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = false
        panel.level = .statusBar
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.isMovableByWindowBackground = false
        panel.hidesOnDeactivate = false
        panel.becomesKeyOnlyIfNeeded = true

        petView = PetView(frame: NSRect(origin: .zero, size: size))
        petView.wantsLayer = true
        petView.onTap = { [weak self] in self?.interact("pat") }
        petView.onDragStart = { [weak self] in self?.beginDrag() }
        petView.onDragEnd = { [weak self] origin in self?.endDrag(at: origin) }
        petView.onRightClick = { [weak self] point in self?.showMenu(at: point) }
        panel.contentView = petView

        bubble = BubblePanel()
        panel.orderFrontRegardless()
    }

    private func buildInfoPanel() {
        infoPanel = WebPanel()
        infoPanel.onAction = { [weak self] action, payload in
            guard let self else { return }
            switch action {
            case "pat", "feed", "play":
                self.interact(action)
            case "chat":
                if let text = payload["text"] as? String { self.sendChat(text) }
            case "drag":
                if let dx = payload["dx"] as? Double, let dy = payload["dy"] as? Double {
                    self.movePanel(dx: dx, dy: dy)
                }
            case "pack":
                if let id = payload["id"] as? String { self.selectPack(id) }
            case "import":
                self.importPack()
            case "pomodoro":
                self.togglePomodoro()
            case "alarm":
                self.scheduleAlarm()
            case "notes":
                self.openNotes()
            case "voice":
                self.toggleVoice()
            case "live2d":
                self.launchLive2D()
            case "close":
                self.infoPanel.orderOut(nil)
            case "dsh":
                NSWorkspace.shared.open(URL(fileURLWithPath: "/Applications/DeepSeek Harness.app"))
            default:
                break
            }
        }
    }

    private func buildStatusItem() {
        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        statusItem.button?.title = "🐋"
        statusItem.button?.toolTip = "DeepSeek 桌宠 · 鲸鱼娘"
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "打开面板", action: #selector(toggleInfoPanel), keyEquivalent: "i"))
        menu.addItem(NSMenuItem(title: "显示桌宠", action: #selector(showPet), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "摸头", action: #selector(patFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        statusItem.menu = menu
    }

    private func restorePosition() {
        let screens = NSScreen.screens
        let primary = screens.first ?? NSScreen.main
        var frame = primary?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = panel.frame.size
        var origin = NSPoint(x: frame.maxX - size.width - 24, y: frame.minY + 12)

        if let x = prefs.x, let y = prefs.y {
            let saved = NSPoint(x: x, y: y)
            if let host = screens.first(where: { $0.visibleFrame.insetBy(dx: 20, dy: 20).contains(saved) }) {
                frame = host.visibleFrame
                origin = saved
            }
        }
        origin.x = min(max(origin.x, frame.minX), frame.maxX - size.width)
        origin.y = min(max(origin.y, frame.minY), frame.maxY - size.height)
        panel.setFrameOrigin(origin)
    }

    // MARK: animation

    private func playState(_ name: String, transientFor seconds: Double? = nil, onEnd: (() -> Void)? = nil) {
        guard let pack, let clip = pack.clip(name) else {
            if fallbackFrames.count > 1, animTimer == nil { startFallbackBlink() }
            return
        }
        transientTimer?.invalidate()
        transientTimer = nil
        currentState = name
        animTimer?.invalidate()
        startTicking(clip, onEnd: onEnd)

        if let seconds {
            transientTimer = Timer.scheduledTimer(withTimeInterval: seconds, repeats: false) { [weak self] _ in
                guard let self, !self.isDragging else { return }
                self.playState(self.stateForPhase(self.currentPhase))
            }
            RunLoop.main.add(transientTimer!, forMode: .common)
        }
    }

    private func startTicking(_ clip: AnimClip, onEnd: (() -> Void)? = nil) {
        var index = 0
        var direction = 1
        let frames = clip.frames

        func tick() {
            guard index >= 0, index < frames.count else { return }
            petView.image = frames[index]
            var delay = 1.0 / max(1.0, clip.fps)
            if clip.playback == "blink" { delay = index == 0 ? 2.4 : 0.11 }
            let last = index >= frames.count - 1
            if clip.playback == "once" && last {
                animTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in onEnd?() }
                RunLoop.main.add(animTimer!, forMode: .common)
                return
            }
            if clip.playback == "pingpong" {
                index += direction
                if index >= frames.count - 1 {
                    index = max(0, frames.count - 1)
                    direction = -1
                }
                if index < 0 {
                    index = 0
                    direction = 1
                }
            } else if clip.playback == "blink" {
                index = index >= frames.count - 1 ? 0 : index + 1
            } else {
                index = (index + 1) % frames.count
            }
            animTimer = Timer.scheduledTimer(withTimeInterval: delay, repeats: false) { _ in tick() }
            RunLoop.main.add(animTimer!, forMode: .common)
        }
        tick()
    }

    private func startFallbackBlink() {
        guard fallbackFrames.count > 1 else { return }
        var tick = 0
        animTimer?.invalidate()
        animTimer = Timer.scheduledTimer(withTimeInterval: 0.16, repeats: true) { [weak self] _ in
            guard let self else { return }
            tick += 1
            let closed = (tick % 30 == 0) || (tick % 30 == 1)
            self.petView.image = self.fallbackFrames[closed ? 0 : 1]
        }
        RunLoop.main.add(animTimer!, forMode: .common)
    }

    private func stateForPhase(_ phase: String) -> String {
        switch phase {
        case "waiting": return "wait"
        case "thinking": return "think"
        case "tool": return "working"
        case "review": return "think"
        case "done": return "celebrate"
        case "failed": return "error"
        default: return "idle"
        }
    }

    private func setPhase(_ phase: String, force: Bool = false) {
        guard force || phase != currentPhase else { return }
        currentPhase = phase
        asleep = false
        guard pack != nil else { return }
        if phase == "failed" {
            playState("error") { [weak self] in
                guard let self, self.currentPhase == "failed" else { return }
                self.playState("disappointed")
            }
        } else {
            playState(stateForPhase(phase))
        }
        applyPhaseMotion(phase)
    }

    private func startIdleWatch() {
        idleTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            guard let self, self.pack != nil, !self.asleep, !self.isDragging else { return }
            guard self.currentPhase == "idle", self.currentState != "sleep" else { return }
            if Date().timeIntervalSince(self.lastAction) > 90 {
                self.asleep = true
                self.playState("sleep")
            }
        }
        RunLoop.main.add(idleTimer!, forMode: .common)
    }

    private func beginDrag() {
        isDragging = true
        lastAction = Date()
        if pack != nil {
            playState("drag")
            petView.layer?.setAffineTransform(CGAffineTransform(rotationAngle: -0.05))
        }
    }

    private func endDrag(at origin: NSPoint) {
        isDragging = false
        lastAction = Date()
        prefs.x = origin.x
        prefs.y = origin.y
        savePrefs(prefs)
        petView.layer?.setAffineTransform(.identity)
        if pack != nil {
            playState(stateForPhase(currentPhase))
        }
    }

    private func startBobbing() {
        guard let layer = petView.layer else { return }
        let bob = CABasicAnimation(keyPath: "transform.translation.y")
        bob.fromValue = 0
        bob.toValue = -4
        bob.duration = 2.0
        bob.autoreverses = true
        bob.repeatCount = .infinity
        bob.timingFunction = CAMediaTimingFunction(name: .easeInEaseOut)
        layer.add(bob, forKey: "bob")
    }

    private func applyPhaseMotion(_ phase: String) {
        guard let layer = petView.layer else { return }
        switch phase {
        case "thinking", "tool": layer.speed = 1.4
        case "done":
            layer.speed = 1.0
            bounce()
        case "failed":
            layer.speed = 1.0
            shake()
        default: layer.speed = 1.0
        }
    }

    private func bounce() {
        guard let layer = petView.layer else { return }
        let anim = CAKeyframeAnimation(keyPath: "transform.translation.y")
        anim.values = [0, -14, 0, -6, 0]
        anim.keyTimes = [0, 0.28, 0.55, 0.75, 1]
        anim.duration = 0.65
        layer.add(anim, forKey: "bounce")
    }

    private func shake() {
        guard let layer = petView.layer else { return }
        let anim = CAKeyframeAnimation(keyPath: "transform.translation.x")
        anim.values = [0, -6, 6, -4, 4, 0]
        anim.duration = 0.45
        layer.add(anim, forKey: "shake")
    }

    // MARK: live state

    private func startPolling() {
        pollTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            self?.pollLive()
        }
        RunLoop.main.add(pollTimer!, forMode: .common)
        pollLive()
    }

    private func pollLive() {
        if let data = try? Data(contentsOf: liveURL),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            liveSnapshot = object
            let phase = object["phase"] as? String ?? "idle"
            let pet = object["pet"] as? [String: Any]
            if let name = pet?["name"] as? String { petName = name }
            if let value = pet?["affinity"] as? Int { affinity = value }
            if let value = pet?["treats"] as? Int { treats = value }

            if phase != currentPhase {
                let previousPhase = currentPhase
                setPhase(phase)
                switch phase {
                case "waiting":
                    if previousPhase == "tool" || previousPhase == "thinking" {
                        showBubble("有个请求在等你确认…")
                    }
                case "done":
                    let now = Date().timeIntervalSince1970
                    if now - lastDoneAt > 3 {
                        lastDoneAt = now
                        let others = max(0, (object["activeCount"] as? Int ?? 0) - 1)
                        showBubble(others > 0 ? "完成啦！还有 \(others) 个会话在跑" : "完成啦！")
                        NSSound(named: "Glass")?.play()
                    }
                case "failed":
                    showBubble("出错了…")
                case "thinking":
                    showBubble("思考中…")
                default:
                    break
                }
            }
            if let chat = object["chat"] as? [String: Any],
               let reply = chat["reply"] as? [String: Any],
               let at = reply["at"] as? Double, at > lastChatReplyAt,
               let text = reply["text"] as? String {
                lastChatReplyAt = at
                chatPending = false
                showBubble(text)
                if reply["error"] as? Bool == true {
                    NSSound(named: "Basso")?.play()
                } else {
                    voice.speak(text)
                }
            }
            if infoPanel.isVisible { infoPanel.push(panelState()) }
            if let dump = ProcessInfo.processInfo.environment["PETONE_DUMP_PANEL"], !dump.isEmpty {
                try? panelText().write(toFile: dump, atomically: true, encoding: .utf8)
            }
        }
    }

    // MARK: panel text

    private func panelTitle() -> String {
        let level = (liveSnapshot?["pet"] as? [String: Any])?["level"] as? [String: Any]
        let title = level?["title"] as? String ?? ""
        let number = level?["level"] as? Int ?? 1
        return "🐋 \(petName) · Lv.\(number) \(title)"
    }

    private func fmt(_ value: Any?) -> String {
        let number = (value as? Int) ?? Int((value as? Double) ?? 0)
        if number >= 1_000_000 { return String(format: "%.1fM", Double(number) / 1_000_000) }
        if number >= 1_000 { return String(format: "%.1fk", Double(number) / 1_000) }
        return String(number)
    }

    private func panelText() -> String {
        guard let snapshot = liveSnapshot else { return "等待宿主数据…\n\n打开一次 DSH 会话后这里会显示状态与养成。" }
        let pet = snapshot["pet"] as? [String: Any] ?? [:]
        let level = pet["level"] as? [String: Any] ?? [:]
        let ledger = snapshot["ledger"] as? [String: Any] ?? [:]
        let balance = snapshot["balance"] as? [String: Any]
        let phase = snapshot["phase"] as? String ?? "idle"
        let active = snapshot["activeCount"] as? Int ?? 0

        var lines: [String] = []
        let phaseLabel: String
        switch phase {
        case "waiting": phaseLabel = "等待中"
        case "thinking": phaseLabel = "思考中"
        case "tool": phaseLabel = "调用工具"
        case "review": phaseLabel = "整理回复"
        case "done": phaseLabel = "完成"
        case "failed": phaseLabel = "出错"
        default: phaseLabel = "空闲"
        }
        lines.append("状态    \(phaseLabel) · \(active) 个会话")

        let points = pet["affinity"] as? Int ?? 0
        let next = level["next"] as? Int
        let progress = level["progress"] as? Double ?? 0
        let filled = max(0, min(10, Int(progress * 10)))
        let bar = String(repeating: "▰", count: filled) + String(repeating: "▱", count: 10 - filled)
        lines.append("好感    \(bar) \(points)/\(next.map(String.init) ?? "MAX")")
        lines.append("零食    \(pet["treats"] as? Int ?? 0)    头 \(pet["pats"] as? Int ?? 0) · 喂 \(pet["feeds"] as? Int ?? 0) · 玩 \(pet["plays"] as? Int ?? 0)")

        lines.append("")
        lines.append("── 今日 ──")
        lines.append("回合 \(ledger["turns"] as? Int ?? 0)  工具 \(ledger["tools"] as? Int ?? 0)  调用 \(ledger["calls"] as? Int ?? 0)")
        lines.append("Token 入 \(fmt(ledger["tokensIn"])) / 出 \(fmt(ledger["tokensOut"])) / 缓存 \(fmt(ledger["cacheRead"]))")
        lines.append("上下文 \(fmt(ledger["contextTokens"]))")
        if let balance, balance["ok"] as? Bool == true {
            let total = balance["total"] as? Double ?? 0
            lines.append(String(format: "余额 %.2f %@", total, balance["currency"] as? String ?? "CNY"))
        } else {
            lines.append("余额 —（未配置 DEEPSEEK_API_KEY）")
        }

        lines.append("")
        lines.append("── 每日任务 ──")
        if let quests = snapshot["quests"] as? [[String: Any]] {
            for quest in quests {
                let done = quest["done"] as? Bool == true
                let name = quest["name"] as? String ?? ""
                let current = quest["progress"] as? Int ?? 0
                let target = quest["target"] as? Int ?? 0
                let reward = quest["reward"] as? Int ?? 0
                lines.append("\(done ? "✔" : "○") \(name) \(current)/\(target)  +\(reward)零食")
            }
        }

        lines.append("")
        lines.append("── 成就 ──")
        if let achievements = snapshot["achievements"] as? [[String: Any]] {
            let unlocked = achievements.filter { $0["unlocked"] as? Bool == true }
            lines.append("已解锁 \(unlocked.count)/\(achievements.count)")
            for achievement in achievements {
                let mark = achievement["unlocked"] as? Bool == true ? "✔" : "○"
                let name = achievement["name"] as? String ?? ""
                let desc = achievement["desc"] as? String ?? ""
                lines.append("\(mark) \(name) · \(desc)")
            }
        }

        lines.append("")
        lines.append("── 记忆 ──")
        if let memories = snapshot["memories"] as? [[String: Any]], !memories.isEmpty {
            for memory in memories.prefix(6) {
                lines.append("· \(memory["text"] as? String ?? "")")
            }
        } else {
            lines.append("· 还没有记忆，多陪陪它")
        }

        if let end = pomodoroEnd {
            let left = max(0, Int(end.timeIntervalSinceNow.rounded()))
            lines.append("")
            lines.append(String(format: "🍅 专注中 %02d:%02d", left / 60, left % 60))
        }
        if chatPending {
            lines.append("")
            lines.append("💬 已发到当前会话，等回复…")
        }

        lines.append("")
        lines.append("── 角色 ──")
        let current = pack?.name ?? "—"
        lines.append("当前 \(current)")
        lines.append("可用 " + packs.map { $0.name }.joined(separator: " / "))
        return lines.joined(separator: "\n")
    }

    // MARK: packs

    private func selectPack(_ id: String, announce: Bool = true) {
        guard let next = packs.first(where: { $0.id == id }), next.id != pack?.id else { return }
        pack = next
        baseSize = next.baseSize
        prefs.packId = id
        let scale = prefs.scale ?? 1.0
        let size = NSSize(width: baseSize.width * scale, height: baseSize.height * scale)
        let old = panel.frame
        var frame = NSRect(x: old.midX - size.width / 2, y: old.midY - size.height / 2, width: size.width, height: size.height)
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        frame.origin.x = min(max(frame.origin.x, screen.minX), screen.maxX - size.width)
        frame.origin.y = min(max(frame.origin.y, screen.minY), screen.maxY - size.height)
        panel.setFrame(frame, display: true)
        petView.frame = NSRect(origin: .zero, size: size)
        savePrefs(prefs)
        queueCommand("pack", extra: ["pack": id])
        setPhase(currentPhase, force: true)
        if announce { showBubble("换上了「\(next.name)」") }
        if infoPanel.isVisible { infoPanel.push(panelState()) }
    }

    private func showPackMenu(at point: NSPoint) {
        let menu = NSMenu()
        for candidate in packs {
            let item = NSMenuItem(title: candidate.name, action: #selector(selectPackFromMenu(_:)), keyEquivalent: "")
            item.representedObject = candidate.id
            item.state = candidate.id == pack?.id ? .on : .off
            item.target = self
            menu.addItem(item)
        }
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @objc private func selectPackFromMenu(_ sender: NSMenuItem) {
        guard let id = sender.representedObject as? String else { return }
        selectPack(id)
    }

    private func importPack() {
        let open = NSOpenPanel()
        open.title = "选择一张 8×9 精灵图（Codex / Petdex 格式）"
        open.allowsMultipleSelection = false
        open.canChooseDirectories = false
        open.allowedContentTypes = [.png, .jpeg, .image]
        guard open.runModal() == .OK, let url = open.url, let image = NSImage(contentsOf: url) else { return }
        let id = "import-\(Int(Date().timeIntervalSince1970))"
        let dir = packsDir.appendingPathComponent(id)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let ext = url.pathExtension.lowercased()
        let name = "spritesheet.\(ext.isEmpty ? "png" : ext)"
        try? FileManager.default.copyItem(at: url, to: dir.appendingPathComponent(name))
        let cellW = max(1, Int(image.size.width / 8))
        let cellH = max(1, Int(image.size.height / 9))
        let manifest: [String: Any] = [
            "displayName": "导入 \(id.suffix(4))",
            "sprite2d": [
                "spritesheetPath": name,
                "cell": ["width": cellW, "height": cellH],
                "columns": 8,
                "atlasRows": 9,
                "frames": Array(repeating: 8, count: 9),
                "tracks": [:],
            ],
        ]
        if let data = try? JSONSerialization.data(withJSONObject: manifest, options: [.prettyPrinted]) {
            try? data.write(to: dir.appendingPathComponent("pet.json"))
        }
        packs = PackStore.discover()
        selectPack(id)
        showBubble("新角色装好啦")
    }

    @objc private func toggleInfoPanel() {
        if infoPanel.isVisible {
            infoPanel.orderOut(nil)
        } else {
            infoPanel.push(panelState())
            infoPanel.show(near: panel.frame)
            if let path = ProcessInfo.processInfo.environment["PETONE_SNAPSHOT_PANEL"], !path.isEmpty {
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak self] in
                    self?.infoPanel.snapshot(to: path)
                }
            }
        }
    }

    private func movePanel(dx: Double, dy: Double) {
        var origin = infoPanel.frame.origin
        origin.x += dx
        origin.y -= dy
        infoPanel.setFrameOrigin(origin)
    }

    private func panelState() -> [String: Any] {
        let snapshot = liveSnapshot ?? [:]
        let pet = snapshot["pet"] as? [String: Any] ?? [:]
        let level = pet["level"] as? [String: Any] ?? [:]
        let ledger = snapshot["ledger"] as? [String: Any] ?? [:]
        let balance = snapshot["balance"] as? [String: Any]
        let phase = snapshot["phase"] as? String ?? currentPhase
        let quests = snapshot["quests"] as? [[String: Any]] ?? []
        let achievements = snapshot["achievements"] as? [[String: Any]] ?? []
        let memories = snapshot["memories"] as? [[String: Any]] ?? []

        let phaseLabels = [
            "idle": "空闲", "waiting": "等待中", "thinking": "思考中",
            "tool": "调用工具", "review": "整理回复", "done": "完成", "failed": "出错",
        ]

        let questItems: [[String: Any]] = quests.map { item in
            [
                "name": item["name"] as? String ?? "",
                "progress": item["progress"] as? Int ?? 0,
                "target": item["target"] as? Int ?? 1,
                "reward": item["reward"] as? Int ?? 0,
                "done": item["done"] as? Bool ?? false,
            ]
        }
        let achItems: [[String: Any]] = achievements.map { item in
            [
                "name": item["name"] as? String ?? "",
                "desc": item["desc"] as? String ?? "",
                "unlocked": item["unlocked"] as? Bool ?? false,
            ]
        }
        let unlocked = achItems.filter { $0["unlocked"] as? Bool == true }.count

        return [
            "phase": phase,
            "phaseLabel": phaseLabels[phase] ?? "空闲",
            "line": snapshot["line"] as? String ?? "",
            "active": snapshot["activeCount"] as? Int ?? 0,
            "pet": [
                "name": petName,
                "level": level["level"] as? Int ?? 1,
                "title": level["title"] as? String ?? "初见",
                "affinity": affinity,
                "next": level["next"] as? Int ?? 40,
                "progress": level["progress"] as? Double ?? 0,
                "treats": treats,
                "pats": pet["pats"] as? Int ?? 0,
                "feeds": pet["feeds"] as? Int ?? 0,
                "plays": pet["plays"] as? Int ?? 0,
            ],
            "ledger": [
                "turns": ledger["turns"] as? Int ?? 0,
                "tools": ledger["tools"] as? Int ?? 0,
                "calls": ledger["calls"] as? Int ?? 0,
                "tokensIn": ledger["tokensIn"] as? Int ?? 0,
                "tokensOut": ledger["tokensOut"] as? Int ?? 0,
                "cacheRead": ledger["cacheRead"] as? Int ?? 0,
                "context": ledger["contextTokens"] as? Int ?? 0,
            ],
            "balance": balance ?? ["ok": false],
            "quests": questItems,
            "achievements": ["unlocked": unlocked, "total": achItems.count, "items": achItems],
            "memories": memories.map { ["text": $0["text"] as? String ?? ""] },
            "packs": packs.map { ["id": $0.id, "name": $0.name] },
            "packId": pack?.id ?? "",
            "chat": ["pending": chatPending],
            "pomodoro": pomodoroEnd.map { max(0, $0.timeIntervalSinceNow) } ?? NSNull(),
            "voice": voice.enabled,
            "live2d": live2dActive,
        ]
    }

    // MARK: chat & tools

    private func sendChat(_ text: String) {
        chatPending = true
        queueCommand("chat", extra: ["text": text])
        showBubble("收到，我去问问…")
        if infoPanel.isVisible { infoPanel.push(panelState()) }
    }

    private func toggleVoice() {
        voice.enabled.toggle()
        prefs.voice = voice.enabled
        savePrefs(prefs)
        showBubble(voice.enabled ? "语音已打开" : "语音已关闭")
        if voice.enabled { voice.speak("语音已打开", force: true) }
    }

    private func togglePomodoro() {
        if pomodoroEnd != nil {
            pomodoroEnd = nil
            pomodoroTimer?.invalidate()
            pomodoroTimer = nil
            showBubble("番茄钟取消")
            return
        }
        pomodoroEnd = Date().addingTimeInterval(25 * 60)
        voice.speak("专注二十五分钟，开始", force: true)
        showBubble("🍅 专注 25 分钟，开始！")
        pomodoroTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            guard let self, let end = self.pomodoroEnd else { return }
            if end.timeIntervalSinceNow <= 0 {
                self.pomodoroEnd = nil
                self.pomodoroTimer?.invalidate()
                self.pomodoroTimer = nil
                self.showBubble("🍅 25 分钟到，休息一下")
                self.voice.speak("时间到，休息一下吧", force: true)
                NSSound(named: "Glass")?.play()
            }
            if self.infoPanel.isVisible { self.infoPanel.push(panelState()) }
        }
        RunLoop.main.add(pomodoroTimer!, forMode: .common)
    }

    private func scheduleAlarm() {
        let alert = NSAlert()
        alert.messageText = "设置闹钟"
        alert.informativeText = "多少分钟后提醒你？"
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 200, height: 24))
        field.stringValue = "10"
        alert.accessoryView = field
        alert.addButton(withTitle: "好")
        alert.addButton(withTitle: "取消")
        guard alert.runModal() == .alertFirstButtonReturn else { return }
        let minutes = max(1, min(240, Int(field.stringValue.trimmingCharacters(in: .whitespaces)) ?? 10))
        alarmTimer?.invalidate()
        alarmTimer = Timer.scheduledTimer(withTimeInterval: Double(minutes) * 60, repeats: false) { [weak self] _ in
            self?.showBubble("⏰ 时间到！")
            self?.voice.speak("时间到了", force: true)
            NSSound(named: "Glass")?.play()
        }
        showBubble("⏰ \(minutes) 分钟后提醒你")
    }

    private func openNotes() {
        if let panel = notesPanel {
            panel.makeKeyAndOrderFront(nil)
            return
        }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 420, height: 360),
            styleMask: [.titled, .closable, .resizable],
            backing: .buffered,
            defer: false
        )
        panel.title = "便签"
        panel.level = .floating
        panel.isFloatingPanel = true
        panel.hidesOnDeactivate = false
        let scroll = NSScrollView(frame: NSRect(x: 0, y: 0, width: 420, height: 360))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds)
        text.font = .systemFont(ofSize: 13)
        text.isEditable = true
        text.autoresizingMask = [.width]
        text.delegate = self
        scroll.documentView = text
        panel.contentView?.addSubview(scroll)
        let notesURL = petDir.appendingPathComponent("notes.md")
        text.string = (try? String(contentsOf: notesURL, encoding: .utf8)) ?? ""
        panel.center()
        panel.orderFrontRegardless()
        notesPanel = panel
        notesView = text
        NotificationCenter.default.addObserver(forName: NSWindow.willCloseNotification, object: panel, queue: .main) { [weak self] _ in
            self?.saveNotes()
            self?.notesPanel = nil
            self?.notesView = nil
        }
    }

    private func saveNotes() {
        guard let text = notesView?.string else { return }
        ensurePetDir()
        try? text.write(to: petDir.appendingPathComponent("notes.md"), atomically: true, encoding: .utf8)
    }

    private func startFishGame() {
        guard fishPanel == nil else { return }
        let panel = NSPanel(
            contentRect: NSRect(x: 0, y: 0, width: 180, height: 120),
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: false
        )
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.level = NSWindow.Level(rawValue: NSWindow.Level.statusBar.rawValue + 2)
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        panel.hidesOnDeactivate = false
        let button = NSButton(title: "🐟", target: self, action: #selector(fishCaught))
        button.isBordered = false
        button.font = .systemFont(ofSize: 38)
        button.frame = NSRect(x: 60, y: 40, width: 60, height: 48)
        panel.contentView = NSView(frame: NSRect(x: 0, y: 0, width: 180, height: 120))
        panel.contentView?.addSubview(button)
        panel.contentView?.wantsLayer = true
        panel.setFrameOrigin(NSPoint(x: self.panel.frame.midX - 90, y: self.panel.frame.midY - 60))
        panel.orderFrontRegardless()
        fishPanel = panel
        fishCatches = 0
        fishTimer = Timer.scheduledTimer(withTimeInterval: 0.55, repeats: true) { [weak self] _ in
            guard let self, let panel = self.fishPanel else { return }
            let x = CGFloat.random(in: 8...(panel.frame.width - 68))
            let y = CGFloat.random(in: 8...(panel.frame.height - 56))
            self.fishPanel?.contentView?.subviews.first?.setFrameOrigin(NSPoint(x: x, y: y))
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 7) { [weak self] in self?.closeFishGame() }
    }

    @objc private func fishCaught() {
        fishCatches += 1
        if fishCatches >= 3 {
            queueCommand("bonus")
            showBubble("接住啦！零食 +2")
            closeFishGame()
        }
    }

    private func closeFishGame() {
        fishTimer?.invalidate()
        fishTimer = nil
        fishPanel?.orderOut(nil)
        fishPanel = nil
    }

    private func closeLive2D() {
        live2dWindow?.stop()
        live2dWindow?.orderOut(nil)
        live2dWindow = nil
        guard live2dActive else { return }
        live2dActive = false
        prefs.form = "png"
        savePrefs(prefs)
        panel.orderFrontRegardless()
        infoPanel.push(panelState())
    }

    private func launchLive2D() {
        if let window = live2dWindow {
            closeLive2D()
            _ = window
            return
        }
        guard let root = Bundle.main.resourceURL?.appendingPathComponent("live2d-web") else {
            showBubble("Live2D 资源没打包进来")
            return
        }
        let window = Live2DWindow(directory: root)
        window.onPat = { [weak self] in self?.interact("pat") }
        window.onMenu = { [weak self] in self?.showLive2DMenu(at: NSEvent.mouseLocation) }
        window.onError = { [weak self] message in self?.showBubble("Live2D: \(message)") }
        window.showAtDefaultPosition()
        live2dWindow = window
        live2dActive = true
        prefs.form = "live2d"
        savePrefs(prefs)
        // 两种形态互斥：Live2D 在，精灵图就让位。
        bubble.orderOut(nil)
        panel.orderOut(nil)
        infoPanel.push(panelState())
    }

    // MARK: interactions

    private func interact(_ kind: String) {
        lastAction = Date()
        if asleep {
            asleep = false
            playState("wake", transientFor: 1.4)
        }
        queueCommand(kind)
        switch kind {
        case "pat":
            affinity += 1
            playState("joy", transientFor: 2.0)
            showBubble(["咕噜咕噜～", "再摸一下嘛", "（眯起眼睛）", "今天的摸摸也很治愈"].randomElement()!)
        case "feed":
            treats = max(0, treats - 1)
            playState("eat", transientFor: 2.6)
            startFishGame()
            showBubble(treats > 0 ? ["好次！是小鱼干！", "嚼嚼嚼……", "谢谢投喂"].randomElement()! : "零食罐空了…")
        case "play":
            playState("play", transientFor: 2.4)
            showBubble(["接住小球！", "再玩一次！", "转圈圈～"].randomElement()!)
        default:
            break
        }
    }

    private func queueCommand(_ kind: String, extra: [String: Any] = [:]) {
        ensurePetDir()
        var queue: [[String: Any]] = []
        if let data = try? Data(contentsOf: commandsURL),
           let parsed = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]] {
            queue = parsed
        }
        var item = extra
        item["kind"] = kind
        item["at"] = Int(Date().timeIntervalSince1970 * 1000)
        queue.append(item)
        if let data = try? JSONSerialization.data(withJSONObject: Array(queue.suffix(20))) {
            try? data.write(to: commandsURL, options: .atomic)
        }
    }

    private func showBubble(_ text: String) {
        bubble.show(text, above: panel.frame)
    }

    // MARK: menu

    private func showMenu(at point: NSPoint) {
        let menu = NSMenu()
        let level = (liveSnapshot?["pet"] as? [String: Any])?["level"] as? [String: Any]
        let header = NSMenuItem(title: "\(petName) · Lv.\(level?["level"] as? Int ?? 1) · 好感 \(affinity) · 零食 \(treats)", action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "打开面板", action: #selector(toggleInfoPanel), keyEquivalent: "i"))
        menu.addItem(NSMenuItem(title: "切换 Live2D 形态", action: #selector(openLive2D), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "摸头", action: #selector(patFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "投喂", action: #selector(feedFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "玩耍", action: #selector(playFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        let packMenu = NSMenu()
        for candidate in packs {
            let item = NSMenuItem(title: candidate.name, action: #selector(selectPackFromMenu(_:)), keyEquivalent: "")
            item.representedObject = candidate.id
            item.state = candidate.id == pack?.id ? .on : .off
            item.target = self
            packMenu.addItem(item)
        }
        let packItem = NSMenuItem(title: "角色", action: nil, keyEquivalent: "")
        packItem.submenu = packMenu
        menu.addItem(packItem)
        let sizeMenu = NSMenu()
        for (label, value) in [("100%", 1.0), ("125%", 1.25), ("150%", 1.5)] {
            let item = NSMenuItem(title: label, action: #selector(scaleFromMenu(_:)), keyEquivalent: "")
            item.representedObject = value
            item.target = self
            sizeMenu.addItem(item)
        }
        let sizeItem = NSMenuItem(title: "大小", action: nil, keyEquivalent: "")
        sizeItem.submenu = sizeMenu
        menu.addItem(sizeItem)
        menu.addItem(NSMenuItem(title: "隐藏桌宠", action: #selector(hidePet), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "重置位置", action: #selector(resetPosition), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    private func showLive2DMenu(at point: NSPoint) {
        let menu = NSMenu()
        menu.addItem(NSMenuItem(title: "摸头", action: #selector(patFromMenu), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "打开面板", action: #selector(toggleInfoPanel), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "关闭 Live2D 形态", action: #selector(closeLive2DAction), keyEquivalent: ""))
        menu.addItem(NSMenuItem(title: "隐藏桌宠", action: #selector(hidePet), keyEquivalent: ""))
        menu.addItem(NSMenuItem.separator())
        menu.addItem(NSMenuItem(title: "退出", action: #selector(quit), keyEquivalent: "q"))
        for item in menu.items { item.target = self }
        menu.popUp(positioning: nil, at: point, in: nil)
    }

    @objc private func closeLive2DAction() { closeLive2D() }

    @objc private func openLive2D() { launchLive2D() }

    @objc private func patFromMenu() { interact("pat") }
    @objc private func feedFromMenu() { interact("feed") }
    @objc private func playFromMenu() { interact("play") }

    @objc private func scaleFromMenu(_ sender: NSMenuItem) {
        guard let scale = sender.representedObject as? Double else { return }
        prefs.scale = scale
        savePrefs(prefs)
        let old = panel.frame
        let size = NSSize(width: baseSize.width * scale, height: baseSize.height * scale)
        let frame = NSRect(x: old.midX - size.width / 2, y: old.midY - size.height / 2,
                           width: size.width, height: size.height)
        panel.setFrame(frame, display: true)
        petView.frame = NSRect(origin: .zero, size: size)
    }

    @objc private func hidePet() {
        bubble.orderOut(nil)
        infoPanel.orderOut(nil)
        panel.orderOut(nil)
        live2dWindow?.orderOut(nil)
    }

    @objc private func showPet() {
        if live2dActive {
            live2dWindow?.orderFrontRegardless()
        } else {
            panel.orderFrontRegardless()
        }
        showBubble("我回来啦")
        playState("welcome", transientFor: 1.8)
    }

    @objc private func resetPosition() {
        prefs.x = nil
        prefs.y = nil
        savePrefs(prefs)
        restorePosition()
    }

    @objc private func quit() {
        NSApp.terminate(nil)
    }
}

// MARK: - main

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.accessory)
app.run()

extension AppDelegate: NSTextViewDelegate {
    func textDidChange(_ notification: Notification) {
        saveNotes()
    }
}
