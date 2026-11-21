import XCTest

final class StandaloneTests: XCTestCase {
    private let origin = URL(string: "http://127.0.0.1:28193")!
    private var csrf = ""
    private let session = URLSession(configuration: .ephemeral)

    override func setUp() {
        super.setUp()
        continueAfterFailure = false
    }

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

    /// iPhones show the share sheet with a Close button; iPads show it as a popover closed by tapping outside.
    @MainActor
    private func dismissShareSheet(in app: XCUIApplication, timeout: TimeInterval) -> Bool {
        let sheet = app.navigationBars["UIActivityContentView"].firstMatch
        let close = app.buttons["header.closeButton"].firstMatch
        let legacyClose = app.buttons.matching(NSPredicate(format: "label ==[c] %@", "Close")).firstMatch
        let outside = app.otherElements.matching(identifier: "PopoverDismissRegion")
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if let target = [close, legacyClose].first(where: { $0.exists && $0.isHittable }) {
                target.tap()
                return sheet.waitForNonExistence(timeout: 5) && close.waitForNonExistence(timeout: 5)
            }
            if sheet.exists, let region = outside.allElementsBoundByIndex.first(where: { $0.isHittable }) {
                region.tap()
                return sheet.waitForNonExistence(timeout: 5)
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        }
        return false
    }

    @MainActor
    func testStartupRecoveryWaitsForExplicitRetry() throws {
        for failure in ["setup", "termination", "navigation"] {
            let app = XCUIApplication()
            app.launchEnvironment["NECONYAN_TEST_PORT"] = "28193"
            app.launchEnvironment["NECONYAN_TEST_STARTUP_FAILURE"] = failure
            app.launch()
            let status = app.staticTexts["startup-status"]
            // The label changes through each startup stage, so wait for the recovery button instead.
            let recovered = NSPredicate(format: "exists == true AND hittable == true")
            expectation(for: recovered, evaluatedWith: app.buttons["Try again"])
            waitForExpectations(timeout: 240)
            let message = status.label
            XCTAssertTrue(app.buttons["Try again"].isHittable)
            XCTAssertTrue(app.buttons["Share startup log"].isHittable)
            XCUIDevice.shared.press(.home)
            app.activate()
            XCTAssertEqual(status.label, message, "Returning to the app must not restart a failed page.")
            app.buttons["Share startup log"].tap()
            XCTAssertTrue(dismissShareSheet(in: app, timeout: 10))
            XCTAssertEqual(status.label, message)
            let screenshot = XCTAttachment(screenshot: app.screenshot())
            screenshot.name = "startup-recovery-\(failure)"
            screenshot.lifetime = .keepAlways
            add(screenshot)
            app.buttons["Try again"].tap()
            XCTAssertTrue(app.webViews["workspace-ready"].waitForExistence(timeout: 120))
            XCTAssertFalse(status.exists)
            app.terminate()
        }
    }

    @MainActor
    func testWebProcessLossAfterReadyReloadsOnce() throws {
        let app = XCUIApplication()
        app.launchEnvironment["NECONYAN_TEST_PORT"] = "28193"
        app.launchEnvironment["NECONYAN_TEST_STARTUP_FAILURE"] = "reload-after-ready"
        app.launch()
        XCTAssertTrue(app.webViews["workspace-ready-after-reload"].waitForExistence(timeout: 240), "A page lost after it was ready must reload by itself.")
        XCTAssertFalse(app.buttons["Try again"].exists)
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        app.terminate()
    }

    @MainActor
    func testPageFeaturesWorkInsideTheApp() throws {
        let app = XCUIApplication()
        app.launchEnvironment["NECONYAN_TEST_PORT"] = "28193"
        app.launchEnvironment["NECONYAN_TEST_PAGE_SCRIPT"] = #"""
        (() => {
            const box = document.createElement('div');
            box.style.cssText = 'position:fixed;left:16px;right:16px;top:120px;z-index:2147483647;background:#fff;color:#000;padding:12px;display:grid;gap:12px';
            const button = (label, action) => {
                const item = document.createElement('button');
                item.textContent = label;
                item.style.cssText = 'min-height:44px;font-size:18px';
                item.addEventListener('click', action);
                box.append(item);
            };
            button('Test alert', () => alert('Native dialog works'));
            button('Test download', () => {
                const link = document.createElement('a');
                link.href = URL.createObjectURL(new Blob(['Downloaded inside the app'], { type: 'text/plain' }));
                link.download = 'neconyan-test.txt';
                document.body.append(link);
                link.click();
                link.remove();
            });
            button('Test popup', () => {
                const view = window.open('', '_blank');
                view.document.write('<!doctype html><title>Print view</title><h1>Popup print view</h1>');
                view.document.close();
            });
            const frame = document.createElement('iframe');
            frame.setAttribute('sandbox', 'allow-scripts');
            frame.srcdoc = '<p>Sandboxed frame loaded</p>';
            frame.style.cssText = 'height:60px;border:0';
            box.append(frame);
            document.body.append(box);
        })();
        """#
        app.launch()
        XCTAssertTrue(app.webViews["workspace-ready"].waitForExistence(timeout: 240))
        XCTAssertTrue(app.staticTexts["Sandboxed frame loaded"].waitForExistence(timeout: 30), "Sandboxed srcdoc frames must load.")

        // A fresh profile opens the interactive tour over Home. Its focus guard
        // deliberately swallows taps outside the tour, even on the fixture buttons.
        let skipTour = app.webViews["workspace-ready"].buttons["Skip"].firstMatch
        if skipTour.exists && skipTour.isHittable {
            skipTour.tap()
            XCTAssertTrue(skipTour.waitForNonExistence(timeout: 10))
        }
        app.buttons["Test alert"].tap()
        let alert = app.alerts["Neconyan"]
        XCTAssertTrue(alert.waitForExistence(timeout: 10), "alert() must show a native dialog.")
        XCTAssertTrue(alert.staticTexts["Native dialog works"].exists)
        alert.buttons["OK"].tap()

        app.buttons["Test download"].tap()
        XCTAssertTrue(dismissShareSheet(in: app, timeout: 20), "A blob download must open the share sheet.")

        app.buttons["Test popup"].tap()
        let done = app.navigationBars.buttons["Done"]
        XCTAssertTrue(done.waitForExistence(timeout: 20), "window.open must show a closable page.")
        XCTAssertTrue(app.staticTexts["Popup print view"].waitForExistence(timeout: 10))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "popup-print-view"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        done.tap()
        XCTAssertTrue(app.buttons["Test popup"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Try again"].exists)
        app.terminate()
    }

    @MainActor
    func testBundledServerLoadsAndRelaunches() async throws {
        let app = XCUIApplication()
        app.launchEnvironment["NECONYAN_TEST_PORT"] = "28193"
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 240), "The bundled Neconyan server must open without a remote server.")
        XCTAssertTrue(app.webViews["workspace-ready"].waitForExistence(timeout: 120), "The actual workspace must load, not the startup error page.")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "standalone-first-launch"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        try await authorise()
        for streaming in [false, true] {
            let reply = try await request("/api/backends/chat-completions/generate", body: [
                "chat_completion_source": "custom", "custom_url": "http://127.0.0.1:28194/v1",
                "model": "ios-test", "stream": streaming, "max_tokens": 32,
                "messages": [["role": "user", "content": "Test the standalone reply."]],
            ])
            let text = String(data: reply, encoding: .utf8) ?? ""
            if streaming {
                XCTAssertTrue(text.contains("Standalone ") && text.contains("reply received.") && text.contains("[DONE]"), text)
            } else {
                XCTAssertTrue(text.contains("Standalone reply received."), text)
            }
        }
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
        XCTAssertTrue(app.webViews["workspace-ready"].waitForExistence(timeout: 120))
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        try await authorise()
        let exported = try await request("/api/characters/export", body: ["avatar_url": avatar, "format": "json"])
        let card = try XCTUnwrap(JSONSerialization.jsonObject(with: exported) as? [String: Any])
        XCTAssertEqual((card["data"] as? [String: Any])?["name"] as? String, name)
        XCTAssertEqual((card["data"] as? [String: Any])?["description"] as? String, "Stored on the iPhone.")
    }
}
