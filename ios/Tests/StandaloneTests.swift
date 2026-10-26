import XCTest

final class StandaloneTests: XCTestCase {
    func testBundledServerLoadsAndRelaunches() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 240), "The bundled Neconyan server must open without a remote server.")
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "standalone-first-launch"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
        app.terminate()
        app.launch()
        XCTAssertTrue(app.webViews.firstMatch.waitForExistence(timeout: 120))
        XCTAssertFalse(app.staticTexts["startup-status"].exists)
    }
}
