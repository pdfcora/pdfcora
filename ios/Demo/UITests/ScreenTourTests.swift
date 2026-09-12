import XCTest

/// Walks every demo screen and saves a screenshot, so the demo is verified end to end
/// rather than only compiled.
final class ScreenTourTests: XCTestCase {
    private let outputDirectory = ProcessInfo.processInfo.environment["SCREENSHOT_DIR"]

    func testEveryScreenOpensAndRenders() {
        let app = XCUIApplication()
        app.launch()

        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10),
                      "sample document did not load")
        save(app, named: "00-root")

        for screen in ["Viewer", "Search", "Outline", "Thumbnails", "Annotations",
                       "Forms", "Text", "Document Info", "Page Operations", "Export"] {
            let link = app.descendants(matching: .any).matching(identifier: "demo-\(screen)").firstMatch
            if !link.waitForExistence(timeout: 5) {
                app.swipeUp()
                _ = link.waitForExistence(timeout: 5)
            }
            guard link.exists else {
                XCTFail("could not reach \(screen)")
                continue
            }
            link.tap()
            XCTAssertTrue(app.navigationBars[screen].waitForExistence(timeout: 10),
                          "\(screen) did not open")
            Thread.sleep(forTimeInterval: 1.2)   // let async rendering land
            save(app, named: screen.replacingOccurrences(of: " ", with: "-"))
            app.navigationBars[screen].buttons.firstMatch.tap()
            _ = app.navigationBars["PdfiumKit"].waitForExistence(timeout: 5)
        }
    }

    private func save(_ app: XCUIApplication, named name: String) {
        let screenshot = XCUIScreen.main.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)

        guard let outputDirectory else { return }
        let url = URL(fileURLWithPath: outputDirectory).appendingPathComponent("\(name).png")
        try? screenshot.pngRepresentation.write(to: url)
    }
}
