import Foundation

let fm = FileManager.default
let scratch = fm.temporaryDirectory.appendingPathComponent("neconyan-storage-\(UUID().uuidString)", isDirectory: true)
try fm.createDirectory(at: scratch, withIntermediateDirectories: true)
defer { try? fm.removeItem(at: scratch) }
let bundled = scratch.appendingPathComponent("bundle", isDirectory: true)
for path in RuntimeInstaller.requiredFiles {
    let file = bundled.appendingPathComponent(path)
    try fm.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
    try Data("bundled \(path)".utf8).write(to: file)
}
let state = scratch.appendingPathComponent("Application Support/Neconyan", isDirectory: true)
let data = state.appendingPathComponent("data/saved-chat.json")
try fm.createDirectory(at: data.deletingLastPathComponent(), withIntermediateDirectories: true)
try Data("keep my chat".utf8).write(to: data)
let alias = scratch.appendingPathComponent("container-alias", isDirectory: true)
try fm.createSymbolicLink(at: alias, withDestinationURL: state)
let directory = alias.appendingPathComponent("runtimes", isDirectory: true)
let version = String(repeating: "a", count: 40)
let oldVersion = String(repeating: "b", count: 40)

// These two URLs designate the same file but the old cleanup predicate treats
// the enumerated canonical form as an obsolete version and removes it.
let aliasRuntime = directory.appendingPathComponent(version, isDirectory: true)
let runtime = try RuntimeInstaller.install(bundled: bundled, in: directory, version: version)
precondition(aliasRuntime != runtime, "The regression fixture must exercise distinct URL spellings.")
precondition(aliasRuntime.resolvingSymlinksInPath().standardizedFileURL == runtime)
try RuntimeInstaller.validate(aliasRuntime, against: bundled)
print("PASS: alias and canonical paths retain the active server after cleanup")

let obsolete = directory.appendingPathComponent(oldVersion, isDirectory: true)
try fm.createDirectory(at: obsolete, withIntermediateDirectories: true)
let retained = directory.appendingPathComponent("unrelated-file")
try Data("keep".utf8).write(to: retained)
_ = try RuntimeInstaller.install(bundled: bundled, in: directory, version: version)
precondition(!fm.fileExists(atPath: obsolete.path))
precondition(fm.fileExists(atPath: retained.path))
try RuntimeInstaller.validate(runtime, against: bundled)
print("PASS: relaunch removes only obsolete versioned code")

try fm.removeItem(at: runtime.appendingPathComponent("server-bootstrap.mjs"))
_ = try RuntimeInstaller.install(bundled: bundled, in: directory, version: version)
try RuntimeInstaller.validate(runtime, against: bundled)
try Data("damaged".utf8).write(to: runtime.appendingPathComponent("server-bootstrap.mjs"))
_ = try RuntimeInstaller.install(bundled: bundled, in: directory, version: version)
try RuntimeInstaller.validate(runtime, against: bundled)
let savedAfterRepair = try String(contentsOf: data, encoding: .utf8)
precondition(savedAfterRepair == "keep my chat")
print("PASS: missing or damaged startup files are repaired without changing saved data")

// Extensions installed for all users live in the versioned code and must survive an update.
let thirdParty = RuntimeInstaller.extensionsPath
func writeExtension(_ base: URL, _ name: String, _ text: String) throws {
    let folder = base.appendingPathComponent("\(thirdParty)/\(name)", isDirectory: true)
    try fm.createDirectory(at: folder, withIntermediateDirectories: true)
    try Data(text.utf8).write(to: folder.appendingPathComponent("index.js"))
}
try Data(#"["Shipped","Clash"]"#.utf8).write(to: bundled.appendingPathComponent("bundled-extensions.json"))
try writeExtension(bundled, "Shipped", "new shipped")
try writeExtension(bundled, "Clash", "new bundled clash")
try Data(#"["Shipped","Retired"]"#.utf8).write(to: runtime.appendingPathComponent("bundled-extensions.json"))
try writeExtension(runtime, "Shipped", "old shipped")
try writeExtension(runtime, "Retired", "no longer shipped")
try writeExtension(runtime, "Mine", "my extension")
try writeExtension(runtime, "Clash", "my clash")
let nextVersion = String(repeating: "c", count: 40)
let updated = try RuntimeInstaller.install(bundled: bundled, in: directory, version: nextVersion)
func extensionText(_ base: URL, _ name: String) -> String? {
    try? String(contentsOf: base.appendingPathComponent("\(thirdParty)/\(name)/index.js"), encoding: .utf8)
}
precondition(extensionText(updated, "Mine") == "my extension")
precondition(extensionText(updated, "Shipped") == "new shipped")
precondition(extensionText(updated, "Clash") == "new bundled clash")
precondition(extensionText(updated, "Retired") == nil)
let backups = state.resolvingSymlinksInPath().appendingPathComponent("data/default-user/files/iPhone extension backups")
let backedUp = try fm.contentsOfDirectory(at: backups, includingPropertiesForKeys: nil)
precondition(backedUp.count == 1)
let clashCopy = try String(contentsOf: backedUp[0].appendingPathComponent("Clash/index.js"), encoding: .utf8)
precondition(clashCopy == "my clash")
precondition(!fm.fileExists(atPath: runtime.path))
try fm.removeItem(at: backups)
_ = try RuntimeInstaller.install(bundled: bundled, in: directory, version: version)
precondition(extensionText(runtime, "Mine") == "my extension")
precondition(!fm.fileExists(atPath: updated.path))
print("PASS: updates keep extensions installed for all users and back up clashing ones")

try fm.removeItem(at: bundled.appendingPathComponent("server-bootstrap.mjs"))
do {
    _ = try RuntimeInstaller.install(bundled: bundled, in: directory, version: oldVersion)
    fatalError("An incomplete bundled payload must be rejected.")
} catch RuntimeInstallError.missingFile { }
precondition(fm.fileExists(atPath: runtime.appendingPathComponent("server-bootstrap.mjs").path))
precondition(!fm.fileExists(atPath: directory.appendingPathComponent(oldVersion).path))
let savedAfterFailure = try String(contentsOf: data, encoding: .utf8)
precondition(savedAfterFailure == "keep my chat")
print("PASS: failed installation keeps the previous server and all saved data")
