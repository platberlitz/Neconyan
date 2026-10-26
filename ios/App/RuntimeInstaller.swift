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

    static func install(bundled: URL, in directory: URL, version: String) throws -> URL {
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
