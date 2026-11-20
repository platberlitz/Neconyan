import Foundation

enum RuntimeInstallError: LocalizedError {
    case invalidVersion
    case missingFile(String)
    case mismatchedPayload

    var errorDescription: String? {
        switch self {
        case .invalidVersion: return "The bundled server version is invalid."
        case .missingFile(let path): return "The local server installation is incomplete: \(path). Your saved data has been kept."
        case .mismatchedPayload: return "The local server installation does not match this app. Your saved data has been kept."
        }
    }
}

enum RuntimeInstaller {
    static let requiredFiles = [
        "server-bootstrap.mjs", "server.js", "package.json", "src/server-main.js",
        "node_modules/yaml/package.json", "dist/frontend/asset-manifest.json", "release-provenance.json",
    ]

    static func validate(_ runtime: URL, against bundled: URL) throws {
        let fm = FileManager.default
        for path in requiredFiles {
            let file = runtime.appendingPathComponent(path)
            let values = try? file.resourceValues(forKeys: [.isRegularFileKey, .fileSizeKey])
            guard values?.isRegularFile == true, (values?.fileSize ?? 0) > 0,
                  fm.isReadableFile(atPath: file.path) else { throw RuntimeInstallError.missingFile(path) }
        }
        for path in ["server-bootstrap.mjs", "release-provenance.json"] {
            guard try Data(contentsOf: runtime.appendingPathComponent(path)) == Data(contentsOf: bundled.appendingPathComponent(path)) else {
                throw RuntimeInstallError.mismatchedPayload
            }
        }
    }

    static let extensionsPath = "public/scripts/extensions/third-party"

    /// True when the given version is already installed, so starting needs no copy.
    static func isInstalled(bundled: URL, in directory: URL, version: String) -> Bool {
        let runtime = directory.resolvingSymlinksInPath().standardizedFileURL.appendingPathComponent(version, isDirectory: true)
        return (try? validate(runtime, against: bundled)) != nil
    }

    /// Extensions installed 'for all users' live inside the versioned code, so an
    /// update would delete them. Carry over every folder the new payload does not ship.
    static func preserveExtensions(into installing: URL, from root: URL, report: (String) -> Void) {
        let fm = FileManager.default
        let target = installing.appendingPathComponent(extensionsPath, isDirectory: true)
        // A same-named folder the update now ships wins; the user's copy goes beside their files.
        let backups = root.deletingLastPathComponent().appendingPathComponent("data/default-user/files/iPhone extension backups", isDirectory: true)
        let previous = ((try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: [.contentModificationDateKey])) ?? [])
            .filter { $0.lastPathComponent.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil }
            .sorted {
                let left = (try? $0.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                let right = (try? $1.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate) ?? .distantPast
                return left > right
            }
        var carried = Set<String>()
        for runtime in previous {
            // Without its inventory a runtime's own bundled folders cannot be told apart from the user's.
            guard let data = try? Data(contentsOf: runtime.appendingPathComponent("bundled-extensions.json")),
                  let names = try? JSONSerialization.jsonObject(with: data) as? [String],
                  let folders = try? fm.contentsOfDirectory(at: runtime.appendingPathComponent(extensionsPath, isDirectory: true), includingPropertiesForKeys: [.isDirectoryKey, .isSymbolicLinkKey]) else { continue }
            let shipped = Set(names)
            for folder in folders {
                let name = folder.lastPathComponent
                let values = try? folder.resourceValues(forKeys: [.isDirectoryKey, .isSymbolicLinkKey])
                guard !name.hasPrefix("."), !shipped.contains(name), !carried.contains(name),
                      values?.isDirectory == true, values?.isSymbolicLink != true else { continue }
                carried.insert(name)
                var destination = target.appendingPathComponent(name, isDirectory: true)
                if fm.fileExists(atPath: destination.path) {
                    destination = backups.appendingPathComponent("before-update-\(UUID().uuidString)/\(name)", isDirectory: true)
                }
                do {
                    try fm.createDirectory(at: destination.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try fm.copyItem(at: folder, to: destination)
                } catch {
                    report("\(name): \(error.localizedDescription)")
                }
            }
        }
    }

    static func install(bundled: URL, in directory: URL, version: String, report: (String) -> Void = { _ in }) throws -> URL {
        guard version.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil else { throw RuntimeInstallError.invalidVersion }
        let fm = FileManager.default
        try fm.createDirectory(at: directory, withIntermediateDirectories: true)
        // iPhones expose the same container through /var and /private/var. URL
        // equality is not file identity; enumeration can return another spelling.
        let root = directory.resolvingSymlinksInPath().standardizedFileURL
        let runtime = root.appendingPathComponent(version, isDirectory: true)
        if (try? validate(runtime, against: bundled)) == nil {
            try validate(bundled, against: bundled)
            let installing = root.appendingPathComponent("installing", isDirectory: true)
            if fm.fileExists(atPath: installing.path) { try fm.removeItem(at: installing) }
            try fm.copyItem(at: bundled, to: installing)
            try validate(installing, against: bundled)
            preserveExtensions(into: installing, from: root, report: report)
            if fm.fileExists(atPath: runtime.path) { try fm.removeItem(at: runtime) }
            try fm.moveItem(at: installing, to: runtime)
        }
        // Compare child names, never URL representations. Only versioned app
        // code is disposable; saved data is outside this directory.
        for old in try fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil) {
            let name = old.lastPathComponent
            if name != version && (name == "installing" || name.range(of: "^[a-f0-9]{40}$", options: .regularExpression) != nil) {
                try? fm.removeItem(at: old)
            }
        }
        // Check after cleanup too, before handing an entry point to Node.
        try validate(runtime, against: bundled)
        return runtime
    }
}
