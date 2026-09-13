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

        for screen in ["Editor", "Viewer", "Search", "Outline", "Thumbnails", "Annotations",
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

    /// The editor is the one screen with real interaction, so it gets exercised rather
    /// than merely opened: switch tools, draw a stroke, and check the page still renders.
    func testEditorToolbarRespondsToInput() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        app.descendants(matching: .any).matching(identifier: "demo-Editor").firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 10))

        for tool in ["select", "ink", "note", "highlight"] {
            let button = app.descendants(matching: .any).matching(identifier: "tool-\(tool)").firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5), "missing tool \(tool)")
        }
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "editor-save").firstMatch.exists)

        // Draw with the ink tool and confirm the app survives the round trip.
        app.descendants(matching: .any).matching(identifier: "tool-ink").firstMatch.tap()
        let canvas = app.images.firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 5), "page did not render")
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.4))
            .press(forDuration: 0.1,
                   thenDragTo: canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.7, dy: 0.6)))

        Thread.sleep(forTimeInterval: 1.5)
        save(app, named: "editor-after-ink")
        XCTAssertTrue(app.navigationBars["Editor"].exists, "editor died after drawing")
        XCTAssertTrue(app.descendants(matching: .any).matching(identifier: "editor-undo").firstMatch.isEnabled,
                      "undo should be enabled after creating an annotation")
    }

    /// The headline use case: open a document that has a form, tap a field on the page,
    /// type into it, and see the value land in the PDF.
    func testTappingAFormFieldOnThePageEditsIt() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        app.descendants(matching: .any).matching(identifier: "sample-Text Form").firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Text Form'")).firstMatch.waitForExistence(timeout: 5))

        app.descendants(matching: .any).matching(identifier: "demo-Editor").firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 10))

        // The footer reports what the SDK found on the page.
        let footer = app.staticTexts.containing(NSPredicate(format: "label CONTAINS 'field'")).firstMatch
        XCTAssertTrue(footer.waitForExistence(timeout: 5), "footer never reported field count")
        XCTAssertFalse(footer.label.contains("0 fields"), "expected a form field, got: \(footer.label)")

        // Tap the field where it sits on the rendered page.
        let canvas = app.images.firstMatch
        XCTAssertTrue(canvas.waitForExistence(timeout: 5))
        canvas.coordinate(withNormalizedOffset: CGVector(dx: 0.50, dy: 0.62)).tap()

        let textField = app.textFields.firstMatch
        guard textField.waitForExistence(timeout: 5) else {
            save(app, named: "form-tap-missed")
            return XCTFail("tapping the field did not open an editor; footer was: \(footer.label)")
        }
        textField.tap()
        textField.typeText("Filled by tap")
        app.buttons["Done"].tap()

        Thread.sleep(forTimeInterval: 1.5)
        save(app, named: "editor-form-filled")
        XCTAssertTrue(app.navigationBars["Editor"].exists)
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
