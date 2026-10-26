import XCTest

final class StandaloneTests: XCTestCase {
    private let origin = URL(string: "http://127.0.0.1:28193")!
    private var csrf = ""
    private let session = URLSession(configuration: .ephemeral)

    private func request(_ path: String, body: [String: Any]? = nil) async throws -> Data {
        var request = URLRequest(url: URL(string: path, relativeTo: origin)!)
        request.timeoutInterval = 90
        request.setValue("Basic " + Data(("neconyan:" + String(repeating: "a", count: 64)).utf8).base64EncodedString(), forHTTPHeaderField: "Authorization")
        if let body {
            request.httpMethod = "POST"
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.setValue(csrf, forHTTPHeaderField: "X-CSRF-Token")
            request.httpBody = try JSONSerialization.data(withJSONObject: body)
        }
        let (data, response) = try await session.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, String(data: data, encoding: .utf8) ?? path)
        return data
    }

    private func authorise() async throws {
        let data = try await request("/csrf-token")
        csrf = try XCTUnwrap((JSONSerialization.jsonObject(with: data) as? [String: Any])?["token"] as? String)
    }

    @MainActor
    func testBundledServerLoadsAndRelaunches() async throws {
        let app = XCUIApplication()
        app.launchEnvironment["NECONYAN_TEST_PORT"] = "28193"
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 240), "The bundled Neconyan server must open without a remote server.")
        XCTAssertTrue(app.webViews.buttons.firstMatch.waitForExistence(timeout: 120), "The actual web interface must finish loading.")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "standalone-first-launch"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        try await authorise()
        let expected = [9906, 505, 264, 44488, 4275, 444, 8503, 13]
        for model in ["llama3", "openai"] {
            let data = try await request("/api/tokenizers/\(model)/encode?model=gpt-4", body: ["text": "Hello from a standalone Neconyan."])
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertEqual(result["ids"] as? [Int], expected, model)
        }
        for model in ["llama", "gpt2", "claude"] {
            let data = try await request("/api/tokenizers/\(model)/encode", body: ["text": "Hello from a standalone Neconyan."])
            let result = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
            XCTAssertFalse((result["ids"] as? [Int] ?? []).isEmpty, "\(model) must count real tokens, not silently estimate.")
        }
        let name = "iOS persistence \(UUID().uuidString)"
        let created = try await request("/api/characters/create", body: ["ch_name": name, "description": "Stored on the iPhone.", "first_mes": "Local data survived."])
        let avatar = try XCTUnwrap(String(data: created, encoding: .utf8))
        XCTAssertTrue(avatar.hasSuffix(".png"), avatar)
        let png = try await request("/api/characters/export", body: ["avatar_url": avatar, "format": "png"])
        XCTAssertEqual(Array(png.prefix(8)), [137, 80, 78, 71, 13, 10, 26, 10])
        XCUIDevice.shared.press(.home)
        app.activate()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 30))
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 120))
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        try await authorise()
        let exported = try await request("/api/characters/export", body: ["avatar_url": avatar, "format": "json"])
        let card = try XCTUnwrap(JSONSerialization.jsonObject(with: exported) as? [String: Any])
        XCTAssertEqual((card["data"] as? [String: Any])?["name"] as? String, name)
        XCTAssertEqual((card["data"] as? [String: Any])?["description"] as? String, "Stored on the iPhone.")
    }
}
