// Voice — edge-tts when available, macOS `say` as the offline fallback.
import AppKit
import AVFoundation

final class Voice {
    var enabled = true
    private var player: AVAudioPlayer?
    private var lastSpoken = Date.distantPast
    private var lastFile: String?

    /// Speak one short line; skips empty/very long text and rate-limits itself.
    func speak(_ text: String, force: Bool = false) {
        guard enabled else { return }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, clean.count <= 90 else { return }
        if !force, Date().timeIntervalSince(lastSpoken) < 3 { return }
        lastSpoken = Date()
        DispatchQueue.global(qos: .utility).async {
            if let binary = Self.edgeTTSBinary() {
                let output = NSTemporaryDirectory() + "pet-one-voice-\(UUID().uuidString).mp3"
                let process = Process()
                process.executableURL = URL(fileURLWithPath: binary)
                process.arguments = ["--voice", "zh-CN-XiaoxiaoNeural", "--text", clean, "--write-media", output]
                do {
                    try process.run()
                    process.waitUntilExit()
                    if process.terminationStatus == 0 {
                        DispatchQueue.main.async { self.play(output) }
                        return
                    }
                } catch { /* fall through to say */ }
            }
            DispatchQueue.main.async { self.say(clean) }
        }
    }

    private func play(_ path: String) {
        guard let player = try? AVAudioPlayer(contentsOf: URL(fileURLWithPath: path)) else {
            say(path)
            return
        }
        self.player = player
        player.play()
        let old = lastFile
        lastFile = path
        if let old, old != path { try? FileManager.default.removeItem(atPath: old) }
    }

    private func say(_ text: String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/say")
        process.arguments = ["-r", "190", text]
        try? process.run()
    }

    /// Known install locations for the edge-tts CLI.
    static func edgeTTSBinary() -> String? {
        let home = NSHomeDirectory()
        var candidates = [
            "\(home)/Library/Python/3.9/bin/edge-tts",
            "\(home)/Library/Python/3.13/bin/edge-tts",
            "/opt/homebrew/bin/edge-tts",
            "/usr/local/bin/edge-tts",
        ]
        if let libs = try? FileManager.default.contentsOfDirectory(atPath: "\(home)/Library/Python") {
            for lib in libs {
                candidates.append("\(home)/Library/Python/\(lib)/bin/edge-tts")
            }
        }
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}
