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
                       "Forms", "Text", "Signatures", "Document Info", "Page Operations", "Export"] {
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

        for tool in ["select", "ink", "note", "highlight", "redact"] {
            let button = app.descendants(matching: .any).matching(identifier: "tool-\(tool)").firstMatch
            XCTAssertTrue(button.waitForExistence(timeout: 5), "missing tool \(tool)")
            XCTAssertTrue(button.isHittable, "tool \(tool) is off screen — the toolbar overflowed")
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

    /// The coverage banner is the point of this screen: a signature can be intact and
    /// still protect only part of the file.
    func testSignaturesScreenReportsCoverage() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        app.descendants(matching: .any).matching(identifier: "sample-Signed").firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Signed'")).firstMatch.waitForExistence(timeout: 5))

        // Signatures sits below the fold on a phone.
        let link = app.descendants(matching: .any).matching(identifier: "demo-Signatures").firstMatch
        if !link.waitForExistence(timeout: 5) {
            app.swipeUp()
            _ = link.waitForExistence(timeout: 5)
        }
        XCTAssertTrue(link.exists, "could not reach the Signatures screen")
        link.tap()
        XCTAssertTrue(app.navigationBars["Signatures"].waitForExistence(timeout: 10))

        let whole = app.descendants(matching: .any).matching(identifier: "coverage-whole").firstMatch
        XCTAssertTrue(whole.waitForExistence(timeout: 5), "signed sample should report full coverage")

        XCTAssertTrue(app.staticTexts["adbe.pkcs7.detached"].waitForExistence(timeout: 5),
                      "the sub-filter should be shown")
        save(app, named: "signatures")
    }

    /// Zoom re-renders the page at the new size, so the bitmap itself grows — the
    /// controls layered on it stay aligned only if both move together.
    func testEditorZoomChangesThePageSize() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        app.descendants(matching: .any).matching(identifier: "demo-Editor").firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 10))

        let page = app.images.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 5), "page did not render")
        let fitted = page.frame.width

        for control in ["zoom-out", "zoom-fit", "zoom-in", "editor-save"] {
            let button = app.descendants(matching: .any).matching(identifier: control).firstMatch
            XCTAssertTrue(button.exists && button.isHittable,
                          "\(control) is not reachable — the toolbar overflowed")
        }

        app.descendants(matching: .any).matching(identifier: "zoom-in").firstMatch.tap()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertGreaterThan(page.frame.width, fitted, "zoom in did not enlarge the page")

        app.descendants(matching: .any).matching(identifier: "zoom-fit").firstMatch.tap()
        Thread.sleep(forTimeInterval: 1.5)
        XCTAssertEqual(page.frame.width, fitted, accuracy: 2, "fit did not restore the page width")

        app.descendants(matching: .any).matching(identifier: "zoom-out").firstMatch.tap()
        Thread.sleep(forTimeInterval: 1.5)
        save(app, named: "editor-zoomed-out")
        XCTAssertLessThan(page.frame.width, fitted, "zoom out did not shrink the page")
    }

    /// Signing end to end through the UI: an unsigned document gains a signature, and
    /// the screen reports it as covering the whole file.
    func testSigningFromTheDemoProducesASignature() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        let link = app.descendants(matching: .any).matching(identifier: "demo-Signatures").firstMatch
        if !link.waitForExistence(timeout: 5) { app.swipeUp() }
        XCTAssertTrue(link.waitForExistence(timeout: 5))
        link.tap()
        XCTAssertTrue(app.navigationBars["Signatures"].waitForExistence(timeout: 10))

        // Hello World carries no signature to begin with.
        XCTAssertTrue(app.staticTexts["This document carries no signatures."]
            .waitForExistence(timeout: 5))

        app.descendants(matching: .any).matching(identifier: "sign-now").firstMatch.tap()

        let coverage = app.descendants(matching: .any).matching(identifier: "coverage-whole").firstMatch
        XCTAssertTrue(coverage.waitForExistence(timeout: 20), "signing should produce a signature")
        XCTAssertTrue(app.staticTexts["adbe.pkcs7.detached"].exists
                      || app.staticTexts["ETSI.CAdES.detached"].exists,
                      "the sub-filter should be shown")
        save(app, named: "signed-from-demo")
    }

    /// The headline use case: a document with a form is edited on the page itself —
    /// the field is a live control at its own position, not a dialog.
    func testFormFieldsAreEditedInlineOnThePage() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        app.descendants(matching: .any).matching(identifier: "sample-Text Form").firstMatch.tap()
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS 'Text Form'")).firstMatch.waitForExistence(timeout: 5))

        app.descendants(matching: .any).matching(identifier: "demo-Editor").firstMatch.tap()
        XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 10))

        // The field control exists on the page without any dialog being opened.
        let field = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'field-'")).firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5), "no inline field control on the page")
        XCTAssertEqual(app.sheets.count, 0, "editing should not open a sheet")

        // It must sit inside the rendered page, not in a bar.
        let page = app.images.firstMatch
        XCTAssertTrue(page.waitForExistence(timeout: 5))
        XCTAssertTrue(page.frame.contains(field.frame.origin),
                      "field control is not positioned over the page")

        field.tap()
        field.typeText("Typed inline")
        app.typeText("\n")          // submit commits and re-renders

        Thread.sleep(forTimeInterval: 1.5)
        save(app, named: "editor-inline-form")
        XCTAssertTrue(app.navigationBars["Editor"].exists)
    }

    /// Checkboxes and dropdowns get their own in-place controls, one per field.
    func testCheckboxesAndDropdownsAreInlineToo() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))

        func openEditor(on sample: String) -> Int {
            app.descendants(matching: .any).matching(identifier: "sample-\(sample)").firstMatch.tap()
            _ = app.staticTexts.containing(NSPredicate(format: "label CONTAINS %@", sample))
                .firstMatch.waitForExistence(timeout: 5)
            app.descendants(matching: .any).matching(identifier: "demo-Editor").firstMatch.tap()
            XCTAssertTrue(app.navigationBars["Editor"].waitForExistence(timeout: 10))
            Thread.sleep(forTimeInterval: 1.2)
            return app.descendants(matching: .any)
                .matching(NSPredicate(format: "identifier BEGINSWITH 'field-'")).count
        }

        // click_form.pdf: 2 checkboxes + 6 radio buttons.
        let toggles = openEditor(on: "Checkboxes")
        XCTAssertGreaterThanOrEqual(toggles, 8, "expected a control per toggle, got \(toggles)")
        let firstToggle = app.descendants(matching: .any)
            .matching(NSPredicate(format: "identifier BEGINSWITH 'field-'")).firstMatch
        firstToggle.tap()
        Thread.sleep(forTimeInterval: 1.2)
        save(app, named: "editor-inline-checkboxes")
        XCTAssertTrue(app.navigationBars["Editor"].exists, "toggling a checkbox broke the editor")

        app.navigationBars["Editor"].buttons.firstMatch.tap()
        _ = app.navigationBars["PdfiumKit"].waitForExistence(timeout: 5)

        // combobox_form.pdf: 3 dropdowns.
        let dropdowns = openEditor(on: "Dropdowns")
        XCTAssertGreaterThanOrEqual(dropdowns, 3, "expected a control per dropdown, got \(dropdowns)")
        save(app, named: "editor-inline-dropdowns")
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
