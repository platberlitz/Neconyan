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
    private var started = false
    var logURL: URL { state.appendingPathComponent("server.log") }

    init() throws {
        let fm = FileManager.default
        state = try fm.url(for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true).appendingPathComponent("Neconyan", isDirectory: true)
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
        } else if let data = try? Data(contentsOf: credentialsURL), let saved = try? JSONDecoder().decode(Credentials.self, from: data), saved.password.range(of: "^[a-f0-9]{64}$", options: .regularExpression) != nil, (20000...60000).contains(saved.port) {
            password = saved.password
            origin = URL(string: "http://127.0.0.1:\(saved.port)")!
        } else {
            var bytes = [UInt8](repeating: 0, count: 32)
            guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw LocalServerError.message("Could not create private app credentials.") }
            let credentials = Credentials(password: bytes.map { String(format: "%02x", $0) }.joined(), port: Int.random(in: 20000...60000))
            password = credentials.password
            origin = URL(string: "http://127.0.0.1:\(credentials.port)")!
            try JSONEncoder().encode(credentials).write(to: credentialsURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
        }
        let configuration = URLSessionConfiguration.ephemeral
        configuration.timeoutIntervalForRequest = 15
        configuration.httpCookieAcceptPolicy = .always
        session = URLSession(configuration: configuration)
    }

    private struct Credentials: Codable { let password: String; let port: Int }

    func start() throws {
        guard !started else { return }
        let fm = FileManager.default
        guard let bundled = Bundle.main.url(forResource: "server", withExtension: nil),
              let versionURL = Bundle.main.url(forResource: "payload-version", withExtension: "txt") else {
            throw LocalServerError.message("The bundled server is missing.")
        }
        let version = try String(contentsOf: versionURL, encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines)
        guard version.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else { throw LocalServerError.message("The server version is invalid.") }
        let runtimeRoot = state.appendingPathComponent("runtimes", isDirectory: true)
        try fm.createDirectory(at: runtimeRoot, withIntermediateDirectories: true)
        let runtime = runtimeRoot.appendingPathComponent(version, isDirectory: true)
        if !fm.fileExists(atPath: runtime.path) {
            let installing = runtimeRoot.appendingPathComponent("installing", isDirectory: true)
            if fm.fileExists(atPath: installing.path) { try fm.removeItem(at: installing) }
            try fm.copyItem(at: bundled, to: installing)
            try fm.moveItem(at: installing, to: runtime)
        }
        // Only disposable application code is replaced. The sibling data directory is retained.
        for old in try fm.contentsOfDirectory(at: runtimeRoot, includingPropertiesForKeys: nil) where old != runtime {
            try? fm.removeItem(at: old)
        }
        var excluded = runtimeRoot
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try excluded.setResourceValues(values)
        try? fm.removeItem(at: state.appendingPathComponent("ios-ready.json"))
        if let size = try? fm.attributesOfItem(atPath: logURL.path)[.size] as? NSNumber, size.intValue > 4 * 1024 * 1024 { try? fm.removeItem(at: logURL) }
        NodeRunner.start(withArguments: ["node", runtime.appendingPathComponent("server-bootstrap.mjs").path, state.path, String(origin.port!), password], logPath: logURL.path)
        started = true
    }

    func signIn() async throws -> [HTTPCookie] {
        let deadline = Date().addingTimeInterval(180)
        while !FileManager.default.fileExists(atPath: state.appendingPathComponent("ios-ready.json").path) {
            guard Date() < deadline else { throw LocalServerError.message("The local server has not started. Your saved data has been kept. Close and reopen Neconyan, or share the startup log.") }
            try await Task.sleep(nanoseconds: 250_000_000)
        }
        let (csrfData, csrfResponse) = try await session.data(from: origin.appendingPathComponent("csrf-token"))
        guard (csrfResponse as? HTTPURLResponse)?.statusCode == 200,
              let json = try JSONSerialization.jsonObject(with: csrfData) as? [String: Any], let token = json["token"] as? String else { throw LocalServerError.message("Could not open the private sign-in session.") }
        var request = URLRequest(url: origin.appendingPathComponent("api/auth/browser/login"))
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.setValue(token, forHTTPHeaderField: "X-CSRF-Token")
        request.setValue(origin.absoluteString, forHTTPHeaderField: "Origin")
        request.httpBody = try JSONSerialization.data(withJSONObject: ["username": "neconyan", "password": password, "remember": true])
        let (_, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200 else { throw LocalServerError.message("Could not sign in to the private server.") }
        return session.configuration.httpCookieStorage?.cookies(for: origin) ?? []
    }
}
