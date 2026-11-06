import Foundation

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("neconyan-diagnostics-\(UUID().uuidString)", isDirectory: true)
try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let state = scratch.appendingPathComponent("state", isDirectory: true)
let recorder = StartupDiagnostics(directory: state, limit: 16384)
recorder.beginAttempt()
recorder.stage("wait-server-ready")
let underlying = NSError(domain: NSPOSIXErrorDomain, code: 61, userInfo: [NSLocalizedDescriptionKey: "Connection refused"])
let error = NSError(domain: NSURLErrorDomain, code: -1004, userInfo: [
    NSLocalizedDescriptionKey: "Could not connect",
    NSURLErrorFailingURLErrorKey: URL(string: "https://person:privatepass@example.com/login?private-query#private-fragment")!,
    NSUnderlyingErrorKey: underlying,
])
recorder.record("connection-failed", detail: StartupDiagnostics.errorDetails(error))
recorder.record("private-fixture", detail: "password=private-password Authorization: Bearer private-bearer sk-abcdefghijklmnop /asset.png?private-value https://host/path#private-anchor")
let serverLog = state.appendingPathComponent("server.log")
try Data("server fixture\nsecret=server-secret".utf8).write(to: serverLog)
let relaunched = StartupDiagnostics(directory: state, limit: 16384)
relaunched.beginAttempt()
relaunched.stage("install-payload")
let report = try relaunched.export(serverLog: serverLog, to: scratch.appendingPathComponent("report"))
let text = try String(contentsOf: report, encoding: .utf8)
for expected in ["wait-server-ready", "install-payload", "NSURLErrorDomain", "NSPOSIXErrorDomain", "code=-1004", "code=61", "server fixture", "does not expose why"] { precondition(text.contains(expected), expected) }
for secret in ["privatepass", "private-query", "private-fragment", "private-password", "private-bearer", "sk-abcdefghijklmnop", "private-value", "private-anchor", "server-secret"] { precondition(!text.contains(secret), secret) }
let lines = try String(contentsOf: state.appendingPathComponent("startup-diagnostics.jsonl"), encoding: .utf8).split(separator: "\n")
let entries = try lines.map { try JSONSerialization.jsonObject(with: Data($0.utf8)) as! [String: Any] }
precondition(Set(entries.compactMap { $0["run"] as? String }).count == 2, "Runs must be distinguishable after relaunch.")
precondition(entries.allSatisfy { ($0["elapsedMs"] as? Int ?? -1) >= 0 && $0["at"] != nil })
print("PASS: stages, elapsed time, native cause chains and previous runs survive; credentials are removed")

DispatchQueue.concurrentPerform(iterations: 80) { index in
    relaunched.record("flood", detail: "entry=\(index) " + String(repeating: "x", count: 500))
}
for name in ["startup-diagnostics.jsonl", "startup-diagnostics.previous.jsonl"] {
    let file = state.appendingPathComponent(name)
    let data = try Data(contentsOf: file)
    precondition(data.count <= 16384, "Retained logs must stay bounded.")
    for line in String(decoding: data, as: UTF8.self).split(separator: "\n") { _ = try JSONSerialization.jsonObject(with: Data(line.utf8)) }
}
print("PASS: concurrent writes remain complete and rotate within the retention budget")

// A failure before LocalServer exists must still produce a useful shareable report.
let blocked = scratch.appendingPathComponent("not-a-directory")
try Data("file".utf8).write(to: blocked)
let fallback = StartupDiagnostics(directory: blocked)
fallback.record("early-failure", detail: "payload unavailable")
let fallbackURL = try fallback.export(serverLog: nil, to: scratch.appendingPathComponent("fallback"))
let fallbackText = try String(contentsOf: fallbackURL, encoding: .utf8)
precondition(fallbackText.contains("Diagnostic storage warning"))
precondition(fallbackText.contains("early-failure") && fallbackText.contains("payload unavailable"))
print("PASS: failed diagnostic storage and absent server still allow an in-memory report")

let largeLog = scratch.appendingPathComponent("large.log")
try (Data("old-prefix".utf8) + Data(repeating: 120, count: 3 * 1024 * 1024) + Data("recent-suffix".utf8)).write(to: largeLog)
let boundedURL = try fallback.export(serverLog: largeLog, to: scratch.appendingPathComponent("bounded"))
let boundedText = try String(contentsOf: boundedURL, encoding: .utf8)
precondition(!boundedText.contains("old-prefix") && boundedText.contains("recent-suffix"))
precondition(boundedText.utf8.count < 3 * 1024 * 1024)
print("PASS: sharing reads only the bounded tail of the server log")
