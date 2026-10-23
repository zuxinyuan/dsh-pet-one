// Character packs — one desktop pet artwork format, two loaders:
//   • state pack : manifest.json + horizontal strips (vlln/whale-girl layout)
//   • atlas pack : pet.json + one spritesheet (zhu1090093659/dsh-pet layout)
// Pack directories live in the app bundle (`Resources/packs`) or under
// `~/.dsh/pet-one/packs` for user imports.
import AppKit

struct AnimClip {
    let frames: [NSImage]
    let fps: Double
    /// `loop`, `pingpong`, `once` or `blink`.
    let playback: String
}

struct CharacterPack {
    let id: String
    let name: String
    let clips: [String: AnimClip]
    let baseSize: NSSize

    func clip(_ key: String) -> AnimClip? {
        clips[key] ?? clips["idle"] ?? clips.values.first
    }

    static let atlasKeys: [String: String] = [
        "idle": "idle",
        "wait": "waiting",
        "think": "review",
        "working": "running",
        "celebrate": "jumping",
        "error": "failed",
        "disappointed": "failed",
        "joy": "waving",
        "eat": "jumping",
        "play": "jumping",
        "drag": "running",
        "walk": "running-left",
        "sleep": "idle",
        "wake": "waving",
        "welcome": "waving",
    ]

    static func load(id: String, directory: URL) -> CharacterPack? {
        if let pack = loadStatePack(id: id, directory: directory) { return pack }
        return loadAtlasPack(id: id, directory: directory)
    }

    // MARK: state pack

    private static func loadStatePack(id: String, directory: URL) -> CharacterPack? {
        let manifestURL = directory.appendingPathComponent("manifest.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let characters = root["characters"] as? [String: Any],
              let entry = (characters["whale-girl"] ?? characters.values.first) as? [String: Any],
              let states = entry["states"] as? [String: [String: Any]] else {
            return nil
        }
        var clips: [String: AnimClip] = [:]
        for (name, info) in states {
            guard let sheetName = info["sheet"] as? String,
                  let frameCount = info["frames"] as? Int, frameCount > 0,
                  let sheet = NSImage(contentsOf: directory.appendingPathComponent(sheetName)) else {
                continue
            }
            let cellWidth = sheet.size.width / CGFloat(frameCount)
            var frames: [NSImage] = []
            for index in 0..<frameCount {
                let rect = NSRect(x: CGFloat(index) * cellWidth, y: 0, width: cellWidth, height: sheet.size.height)
                frames.append(crop(sheet, rect))
            }
            let fps = (info["fps"] as? Double) ?? Double(info["fps"] as? Int ?? 4)
            clips[name] = AnimClip(frames: frames, fps: fps, playback: (info["playback"] as? String) ?? "loop")
        }
        guard !clips.isEmpty else { return nil }
        let name = (entry["name"] as? String) ?? id
        return CharacterPack(id: id, name: name, clips: clips, baseSize: NSSize(width: 240, height: 240))
    }

    // MARK: atlas pack

    private static func loadAtlasPack(id: String, directory: URL) -> CharacterPack? {
        let manifestURL = directory.appendingPathComponent("pet.json")
        guard let data = try? Data(contentsOf: manifestURL),
              let manifest = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let sprite = manifest["sprite2d"] as? [String: Any],
              let cellInfo = sprite["cell"] as? [String: Any],
              let cellW = cellInfo["width"] as? Int,
              let cellH = cellInfo["height"] as? Int,
              let columns = sprite["columns"] as? Int,
              let frameCounts = sprite["frames"] as? [Int],
              let sheet = NSImage(contentsOf: directory.appendingPathComponent((sprite["spritesheetPath"] as? String) ?? "spritesheet.webp")) else {
            return nil
        }
        let tracks = sprite["tracks"] as? [String: Any] ?? [:]
        let order = ["idle", "running-right", "running-left", "waving", "jumping", "failed", "waiting", "running", "review"]
        var rows: [String: AnimClip] = [:]
        for (row, count) in frameCounts.enumerated() {
            guard row < order.count, count > 0 else { continue }
            var frames: [NSImage] = []
            for column in 0..<min(count, columns) {
                let rect = NSRect(
                    x: CGFloat(column * cellW),
                    y: sheet.size.height - CGFloat((row + 1) * cellH),
                    width: CGFloat(cellW),
                    height: CGFloat(cellH)
                )
                frames.append(crop(sheet, rect))
            }
            var fps = 4.0
            if let track = tracks[order[row]] as? [String: Any],
               let durations = track["durations"] as? [Double], !durations.isEmpty {
                let average = durations.reduce(0, +) / Double(durations.count)
                if average > 0 { fps = max(1, 1000 / average) }
            }
            rows[order[row]] = AnimClip(frames: frames, fps: fps, playback: "loop")
        }
        guard !rows.isEmpty else { return nil }
        var clips: [String: AnimClip] = [:]
        for (key, rowKey) in atlasKeys {
            if let clip = rows[rowKey] { clips[key] = clip }
        }
        clips["idle"] = rows["idle"]
        let height: CGFloat = 240
        let width = height * CGFloat(cellW) / CGFloat(cellH)
        let name = (manifest["displayName"] as? String) ?? id
        return CharacterPack(id: id, name: name, clips: clips, baseSize: NSSize(width: width, height: height))
    }

    private static func crop(_ image: NSImage, _ rect: NSRect) -> NSImage {
        let frame = NSImage(size: rect.size)
        frame.lockFocus()
        image.draw(in: NSRect(origin: .zero, size: rect.size), from: rect, operation: .copy, fraction: 1)
        frame.unlockFocus()
        return frame
    }
}

enum PackStore {
    /// All pack directories, bundle first then user imports.
    static func directories() -> [(id: String, url: URL)] {
        var seen = Set<String>()
        var result: [(String, URL)] = []
        let roots: [URL] = [
            Bundle.main.resourceURL?.appendingPathComponent("packs"),
            URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(".dsh/pet-one/packs"),
        ].compactMap { $0 }

        for root in roots {
            guard let entries = try? FileManager.default.contentsOfDirectory(at: root, includingPropertiesForKeys: [.isDirectoryKey]) else { continue }
            for entry in entries.sorted(by: { $0.lastPathComponent < $1.lastPathComponent }) {
                let id = entry.lastPathComponent
                guard !seen.contains(id) else { continue }
                let hasManifest = FileManager.default.fileExists(atPath: entry.appendingPathComponent("manifest.json").path)
                let hasAtlas = FileManager.default.fileExists(atPath: entry.appendingPathComponent("pet.json").path)
                guard hasManifest || hasAtlas else { continue }
                seen.insert(id)
                result.append((id, entry))
            }
        }
        return result
    }

    static func discover() -> [CharacterPack] {
        directories().compactMap { CharacterPack.load(id: $0.id, directory: $0.url) }
    }
}
