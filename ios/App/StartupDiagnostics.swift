import Foundation

/// Independent of Node and WebKit, so early failures and the previous run remain shareable.
final class StartupDiagnostics: @unchecked Sendable {
    static let shared = StartupDiagnostics(directory: (try? FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true))?.appendingPathComponent("Neconyan", isDirectory: true))
    private let lock = NSLock()
    private let directory: URL?
    private let limit: Int
    private let run = UUID().uuidString
    private let started = ProcessInfo.processInfo.systemUptime
    private var retained: [String] = []
    private var storageFailure: String?
    private var attempt = 0
    private var phase = "launch"

    init(directory: URL?, limit: Int = 256 * 1024) {
        self.directory = directory
        self.limit = limit
        if let directory {
            do { try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true) }
            catch { storageFailure = Self.errorDetails(error) }
        } else { storageFailure = "Application Support directory is unavailable." }
    }

    func beginAttempt() {
        lock.lock()
        attempt += 1
        phase = "connecting"
        lock.unlock()
        record("connection-attempt")
    }

    func stage(_ value: String, detail: String = "") {
        lock.lock()
        phase = value
        lock.unlock()
        record("stage", detail: detail)
    }

    func record(_ event: String, detail: String = "") {
        lock.lock()
        defer { lock.unlock() }
        let entry: [String: Any] = [
            "at": ISO8601DateFormatter().string(from: Date()), "run": run,
            "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - started) * 1000),
            "attempt": attempt, "phase": phase, "event": Self.redact(event, limit: 80),
            "detail": Self.redact(detail),
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: entry, options: [.sortedKeys]), let line = String(data: data, encoding: .utf8) else { return }
        retained.append(line)
        while retained.count > 1 && retained.reduce(0, { $0 + $1.utf8.count + 1 }) > limit { retained.removeFirst() }
        guard let directory else { return }
        do {
            let file = directory.appendingPathComponent("startup-diagnostics.jsonl")
            let fm = FileManager.default
            let size = (try? fm.attributesOfItem(atPath: file.path)[.size] as? NSNumber)?.intValue ?? 0
            if size + data.count + 1 > limit {
                let previous = directory.appendingPathComponent("startup-diagnostics.previous.jsonl")
                if fm.fileExists(atPath: previous.path) { try fm.removeItem(at: previous) }
                if fm.fileExists(atPath: file.path) { try fm.moveItem(at: file, to: previous) }
            }
            if !fm.fileExists(atPath: file.path) { try Data().write(to: file) }
            let handle = try FileHandle(forWritingTo: file)
            defer { try? handle.close() }
            try handle.seekToEnd()
            try handle.write(contentsOf: data + Data([10]))
            // Write each small record directly; a dead web process cannot flush a queue.
        } catch { storageFailure = Self.errorDetails(error) }
    }

    func export(serverLog: URL?, to destination: URL) throws -> URL {
        record("share-requested")
        lock.lock()
        defer { lock.unlock() }
        var sections = [
            "Neconyan iPhone startup report",
            "Run: \(run)\nAttempt: \(attempt)\nLast stage: \(phase)",
            "WebKit does not expose why its page process was terminated. Memory warnings and recent activity are observations, not proof of the cause. Earlier runs may have ended normally or been closed by iOS.",
        ]
        if let storageFailure { sections.append("Diagnostic storage warning: \(storageFailure)\nThe current run is retained in memory only where disk writes failed.") }
        if let directory {
            for name in ["startup-diagnostics.previous.jsonl", "startup-diagnostics.jsonl"] {
                let text = Self.tail(directory.appendingPathComponent(name), bytes: limit)
                if !text.isEmpty { sections.append("\(name):\n\(text)") }
            }
        }
        sections.append("Current run (memory copy):\n" + retained.joined(separator: "\n"))
        let server = serverLog ?? directory?.appendingPathComponent("server.log")
        sections.append("Server log (last 2 MiB; may include earlier runs):\n" + (server.map { Self.tail($0, bytes: 2 * 1024 * 1024) } ?? "Unavailable"))
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let file = destination.appendingPathComponent("neconyan-startup.txt")
        try Self.redact(sections.joined(separator: "\n\n"), limit: 4 * 1024 * 1024).write(to: file, atomically: true, encoding: .utf8)
        return file
    }

    private static func tail(_ url: URL, bytes: Int) -> String {
        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }
            let size = try handle.seekToEnd()
            try handle.seek(toOffset: size > UInt64(bytes) ? size - UInt64(bytes) : 0)
            return String(decoding: try handle.read(upToCount: bytes) ?? Data(), as: UTF8.self)
        } catch { return "Unavailable (\((error as NSError).domain) \((error as NSError).code))" }
    }

    static func errorDetails(_ error: Error, depth: Int = 0) -> String {
        let native = error as NSError
        var text = "\(native.domain) code=\(native.code): \(native.localizedDescription)"
        if let url = native.userInfo[NSURLErrorFailingURLErrorKey] as? URL { text += " url=\(url.absoluteString)" }
        if depth < 3, let cause = native.userInfo[NSUnderlyingErrorKey] as? NSError { text += "\nCaused by: " + errorDetails(cause, depth: depth + 1) }
        return redact(text)
    }

    static func redact(_ input: String, limit: Int = 12000) -> String {
        var text = String(input.prefix(limit))
        for (pattern, replacement) in [
            (#"(?i)\b(Bearer|Basic)\s+[^\s,;\"']+"#, "$1 [redacted]"),
            (#"(?i)((?:api[_-]?key|access[_-]?token|refresh[_-]?token|token|authorization|password|passwd|secret|cookie)\s*[\"']?\s*[:=]\s*)(?:\"[^\"]*(?:\"|$)|'[^']*(?:'|$)|[^\s,;}]+)"#, "$1[redacted]"),
            (#"\b(?:sk|sess)-[a-zA-Z0-9_-]{12,}"#, "[redacted]"),
            (#"(?i)(https?://)[^\s/@]+:[^\s/@]+@"#, "$1[redacted]@"),
            (#"(?i)((?:https?|file)://[^\s?#)\"']+)[?#][^\s)\"']*"#, "$1?[redacted]"),
            (#"(/[\w/.-]+)[?#][^\s)\"']*"#, "$1?[redacted]"),
        ] {
            text = text.replacingOccurrences(of: pattern, with: replacement, options: .regularExpression)
        }
        return text
    }
}
