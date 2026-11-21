import Foundation
import Security

enum LocalServerError: LocalizedError {
    case message(String)
    var errorDescription: String? { if case .message(let message) = self { return message }; return nil }
}

final class LocalServer {
    let state: URL
    let origin: URL
    let password: String
    let session: URLSession
    private(set) var started = false
    /// What went wrong the last time the app ran, read once at start so it can be shown before the workspace.
    private(set) var previousRunProblem: String?
    var logURL: URL { state.appendingPathComponent("server.log") }
    var importInbox: URL { state.appendingPathComponent("import-inbox", isDirectory: true) }
    private var readyURL: URL { state.appendingPathComponent("ios-ready.json") }
    private var launchingURL: URL { state.appendingPathComponent("ios-launching") }
    private var exitURL: URL { state.appendingPathComponent("ios-exit.json") }

    init() throws {
        let fm = FileManager.default
        state = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Neconyan", isDirectory: true).resolvingSymlinksInPath().standardizedFileURL
        try fm.createDirectory(at: state, withIntermediateDirectories: true, attributes: [.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication])
        let credentialsURL = state.appendingPathComponent("native-credentials.json")
        #if DEBUG
        let testPort = ProcessInfo.processInfo.environment["NECONYAN_TEST_PORT"].flatMap(Int.init)
        #else
        let testPort: Int? = nil
        #endif
        if let testPort, (20000...60000).contains(testPort) {
            password = String(repeating: "a", count: 64)
            origin = URL(string: "http://127.0.0.1:\(testPort)")!
        } else {
            let saved = (try? Data(contentsOf: credentialsURL)).flatMap { try? JSONDecoder().decode(Credentials.self, from: $0) }
            let savedPassword = saved.map(\.password).flatMap { $0.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil ? $0 : nil }
            var port = saved.map(\.port).flatMap { (20000...60000).contains($0) ? $0 : nil }
            // The page's saved settings belong to its port, so keep it unless something else now holds it.
            if let current = port, !Self.portIsFree(current) {
                StartupDiagnostics.shared.record("port-conflict", detail: "port=\(current)")
                port = nil
            }
            let resolvedPassword: String
            if let savedPassword { resolvedPassword = savedPassword } else {
                var bytes = [UInt8](repeating: 0, count: 32)
                guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LocalServerError.message("Could not create private app credentials.") }
                resolvedPassword = bytes.map { String(format: "%02x", $0) }.joined()
            }
            let resolvedPort = port ?? Self.freePort()
            password = resolvedPassword
            origin = URL(string: "http://127.0.0.1:\(resolvedPort)")!
            if saved?.password != resolvedPassword || saved?.port != resolvedPort {
                try JSONEncoder().encode(Credentials(password: resolvedPassword, port: resolvedPort)).write(to: credentialsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
            }
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: configuration)
    }

    private struct Credentials: Codable { let password: String; let port: Int }

    /// Ports above 49151 are the system's ephemeral range, where outgoing connections can take them.
    private static func freePort() -> Int {
        for _ in 0..<32 {
            let candidate = Int.random(in: 20000...49151)
            if portIsFree(candidate) { return candidate }
        }
        return Int.random(in: 20000...49151)
    }

    /// Node listens with SO_REUSEADDR, so only a live listener on the port blocks it.
    static func portIsFree(_ port: Int) -> Bool {
        let descriptor = socket(AF_INET, SOCK_STREAM, 0)
        guard descriptor >= 0 else { return true }
        defer { close(descriptor) }
        var reuse: Int32 = 1
        setsockopt(descriptor, SOL_SOCKET, SO_REUSEADDR, &reuse, socklen_t(MemoryLayout<Int32>.size))
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = in_port_t(UInt16(port).bigEndian)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { bind(descriptor, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
        }
        return result == 0 || errno != EADDRINUSE
    }

    /// True when this launch has to copy the app's server files first, which takes a while after an update.
    var needsInstall: Bool {
        guard !started, let bundled = Bundle.main.url(forResource: "server", withExtension: nil),
              let versionURL = Bundle.main.url(forResource: "payload-version", withExtension: "txt"),
              let version = try? String(contentsOf: versionURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        return !RuntimeInstaller.isInstalled(bundled: bundled, in: state.appendingPathComponent("runtimes", isDirectory: true), version: version)
    }

    func start() throws {
        guard !started else { StartupDiagnostics.shared.record("server-already-started"); return }
        StartupDiagnostics.shared.stage("locate-payload")
        let fm = FileManager.default
        guard let bundled = Bundle.main.url(forResource: "server", withExtension: nil),
              let versionURL = Bundle.main.url(forResource: "payload-version", withExtension: "txt") else {
            throw LocalServerError.message("The bundled server is missing.")
        }
        previousRunProblem = readPreviousRunProblem()
        if let previousRunProblem { StartupDiagnostics.shared.record("previous-run-problem", detail: previousRunProblem) }
        try? fm.removeItem(at: exitURL)
        let version = try String(contentsOf: versionURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        StartupDiagnostics.shared.stage("install-payload", detail: "commit=\(version)")
        let runtimeRoot = state.appendingPathComponent("runtimes", isDirectory: true)
        let runtime = try RuntimeInstaller.install(bundled: bundled, in: runtimeRoot, version: version) { problem in
            StartupDiagnostics.shared.record("extension-preserve-failed", detail: problem)
        }
        var excluded = runtimeRoot
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? excluded.setResourceValues(values)
        try? fm.removeItem(at: readyURL)
        // A busy marker left by a run that was killed mid-reply would keep the silence playing forever.
        try? fm.removeItem(at: state.appendingPathComponent("ios-busy"))
        // Picked ZIPs belong to the run that picked them; an abandoned one would hold gigabytes forever.
        try? fm.removeItem(at: importInbox)
        if let size = try? fm.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber, size.intValue > 4 * 1024 * 1024 { try? fm.removeItem(at: logURL) }
        try? Data().write(to: launchingURL, options: .atomic)
        StartupDiagnostics.shared.stage("start-node")
        NodeRunner.start(withArguments: ["node", "--max-old-space-size=\(Self.heapMegabytes)", runtime.appendingPathComponent("server-bootstrap.mjs").path, state.path, String(origin.port!), password], logPath: logURL.path)
        started = true
    }

    // Large chats need more than V8's default heap; leave most of the memory to iOS and the page,
    // matching the Android launcher.
    static var heapMegabytes: Int {
        let quarter = Int(ProcessInfo.processInfo.physicalMemory / (4 * 1024 * 1024))
        return max(512, min(2048, quarter))
    }

    /// The previous run either never finished starting (the sentinel is still there) or Node wrote why it quit.
    private func readPreviousRunProblem() -> String? {
        let fm = FileManager.default
        if let data = try? Data(contentsOf: exitURL),
           let exit = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            let code = (exit["code"] as? NSNumber)?.intValue ?? 0
            let reason = (exit["message"] as? String).map { String($0.prefix(400)) } ?? ""
            if code != 0 || !reason.isEmpty {
                return "The local server stopped last time (code \(code))\(reason.isEmpty ? "" : ": \(reason)")."
            }
        }
        if fm.fileExists(atPath: launchingURL.path) {
            return "Neconyan closed while it was starting last time."
        }
        return nil
    }

    var nodeExitMessage: String? {
        guard NodeRunner.hasExited else { return nil }
        return "The local server stopped (code \(NodeRunner.exitCode)). Your saved data has been kept. Close Neconyan from the app switcher and open it again, or share the startup log."
    }

    func signIn() async throws -> [HTTPCookie] {
        StartupDiagnostics.shared.stage("wait-server-ready")
        let deadline = Date().addingTimeInterval(180)
        while !FileManager.default.fileExists(atPath: readyURL.path) {
            if let nodeExitMessage { throw LocalServerError.message(nodeExitMessage) }
            guard Date() < deadline else { throw LocalServerError.message("The local server has not started. Your saved data has been kept. Close and reopen Neconyan, or share the startup log.") }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        try? FileManager.default.removeItem(at: launchingURL)
        StartupDiagnostics.shared.stage("request-sign-in-session")
        let (csrfData, csrfResponse) = try await session.data(from: origin.appendingPathComponent("csrf-token"))
        StartupDiagnostics.shared.record("sign-in-session-response", detail: "status=\((csrfResponse as? HTTPURLResponse)?.statusCode ?? 0)")
        guard (csrfResponse as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: csrfData) as? [String: Any], let token = json["token"] as? String else { throw LocalServerError.message("Could not open the private sign-in session.") }
        var request = URLRequest(url: origin.appendingPathComponent("api/auth/browser/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-CSRF-Token")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["username": "neconyan", "password": password, "remember": true])
        StartupDiagnostics.shared.stage("sign-in")
        let (_, response) = try await session.data(for: request)
        StartupDiagnostics.shared.record("sign-in-response", detail: "status=\((response as? HTTPURLResponse)?.statusCode ?? 0)")
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw LocalServerError.message("Could not sign in to the private server.") }
        return session.configuration.httpCookieStorage?.cookies(for: origin) ?? []
    }
}
