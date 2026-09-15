import XCTest
@testable import PdfiumKit

final class FeatureTests: LicensedTestCase {
    private func open(_ name: String) async throws -> PdfDocument {
        let url = Repo.corpus.appendingPathComponent(name)
        return try await PdfDocument(data: try Data(contentsOf: url))
    }

    // MARK: - Rendering

    func testRenderProducesImageWithExpectedAspectRatio() async throws {
        let doc = try await open("combobox_form.pdf")
        let page = try await doc.page(0)
        let image = try await page.render(width: 300)

        XCTAssertEqual(image.size.width, 300, accuracy: 1)
        // The page is 300x600 points, so the rendered image must be twice as tall as wide.
        XCTAssertEqual(image.size.height, 600, accuracy: 1)
        await doc.close()
    }

    func testRenderAtExplicitPixelSize() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let image = try await page.render(pixelWidth: 128, pixelHeight: 64)
        XCTAssertEqual(image.size.width, 128, accuracy: 1)
        XCTAssertEqual(image.size.height, 64, accuracy: 1)
        await doc.close()
    }

    func testRenderedPixelsAreNotUniformlyBlank() async throws {
        let doc = try await open("rectangles.pdf")
        let page = try await doc.page(0)
        let image = try await page.render(width: 100)
        let cgImage = try XCTUnwrap(image.cgImage)
        let data = try XCTUnwrap(cgImage.dataProvider?.data as Data?)

        // A page with drawn rectangles must produce at least one non-white pixel.
        let hasInk = stride(from: 0, to: data.count - 4, by: 4).contains { i in
            data[i] != 0xFF || data[i + 1] != 0xFF || data[i + 2] != 0xFF
        }
        XCTAssertTrue(hasInk, "rendered page appears entirely blank")
        await doc.close()
    }

    // MARK: - Text

    func testTextExtraction() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let text = try await page.text.string()
        XCTAssertTrue(text.contains("Hello"), "expected 'Hello' in extracted text, got: \(text)")
        await doc.close()
    }

    func testCharacterCountIsPositive() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let count = try await page.text.characterCount
        XCTAssertGreaterThan(count, 0)
        await doc.close()
    }

    func testSearchFindsKnownTerm() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let matches = try await page.text.search("Hello")
        XCTAssertFalse(matches.isEmpty, "search found nothing")
        XCTAssertFalse(matches[0].rects.isEmpty, "match has no rects to highlight")
        await doc.close()
    }

    func testSearchIsCaseInsensitiveByDefault() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let lower = try await page.text.search("hello")
        let exact = try await page.text.search("hello", options: .caseSensitive)
        XCTAssertGreaterThanOrEqual(lower.count, exact.count)
        await doc.close()
    }

    func testSearchForAbsentTermReturnsNothing() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let matches = try await page.text.search("zzzznotpresentzzzz")
        XCTAssertTrue(matches.isEmpty)
        await doc.close()
    }

    // MARK: - Form fields

    func testComboBoxFieldIsDiscoveredWithOptions() async throws {
        let doc = try await open("combobox_form.pdf")
        let page = try await doc.page(0)
        let fields = try await page.formFields()
        XCTAssertFalse(fields.isEmpty, "no form fields found")

        let combos = fields.compactMap { field -> PdfFormField.Choice? in
            if case .comboBox(let c) = field { return c }
            return nil
        }
        XCTAssertFalse(combos.isEmpty, "expected at least one combo box, got \(fields.map(\.caseName))")
        XCTAssertFalse(combos[0].options.isEmpty, "combo box has no options")
        await doc.close()
    }

    func testTextFieldRoundTripsAValue() async throws {
        let doc = try await open("text_form.pdf")
        let page = try await doc.page(0)
        let before = try await page.formFields()

        let target = try XCTUnwrap(before.first { if case .text = $0 { return true }; return false })
        try await page.setText("John Doe", forFieldAt: target.base.annotationIndex)

        let after = try await page.formFields()
        let updated = try XCTUnwrap(after.first { $0.base.annotationIndex == target.base.annotationIndex })
        guard case .text(let field) = updated else { return XCTFail("field changed type") }
        XCTAssertEqual(field.value, "John Doe")
        await doc.close()
    }

    func testCheckboxTogglesState() async throws {
        let doc = try await open("click_form.pdf")
        let page = try await doc.page(0)
        let fields = try await page.formFields()

        guard let target = fields.first(where: { if case .checkBox = $0 { return true }; return false }),
              case .checkBox(let before) = target else {
            throw XCTSkip("click_form.pdf contains no checkbox")
        }
        try await page.toggleField(at: target.base.annotationIndex)

        let after = try await page.formFields()
        guard let updated = after.first(where: { $0.base.annotationIndex == target.base.annotationIndex }),
              case .checkBox(let now) = updated else { return XCTFail("field changed type") }
        XCTAssertNotEqual(before.isChecked, now.isChecked, "toggling did not change the checkbox")
        await doc.close()
    }

    // MARK: - Annotations

    func testExistingAnnotationsAreRead() async throws {
        let doc = try await open("annotation_highlight_long_content.pdf")
        let page = try await doc.page(0)
        let annotations = try await page.annotations()
        XCTAssertFalse(annotations.isEmpty, "expected annotations")
        XCTAssertTrue(annotations.contains { if case .highlight = $0 { return true }; return false },
                      "expected a highlight, got \(annotations.map(\.caseName))")
        await doc.close()
    }

    func testAddedInkIsReadBackAsOneAnnotationWithEveryStroke() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let before = try await page.annotations().count

        try await page.addInk(strokes: [[PdfPoint(x: 10, y: 10), PdfPoint(x: 50, y: 50), PdfPoint(x: 90, y: 20)],
                                        [PdfPoint(x: 20, y: 80), PdfPoint(x: 70, y: 80)]],
                              color: .black, lineWidth: 3)

        let after = try await page.annotations()
        XCTAssertEqual(after.count, before + 1)
        guard case .ink(let ink) = try XCTUnwrap(after.last) else { return XCTFail("last annotation is not ink") }
        XCTAssertEqual(ink.strokes.map(\.count), [3, 2])
        XCTAssertEqual(ink.base.rect, PdfRect(left: 10, bottom: 10, right: 90, top: 80))
        await doc.close()
    }

    func testAddedMarkupSurvivesASave() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        let quad = PdfQuad(p1: PdfPoint(x: 10, y: 60), p2: PdfPoint(x: 90, y: 60),
                           p3: PdfPoint(x: 10, y: 50), p4: PdfPoint(x: 90, y: 50))
        try await page.addHighlight(quads: [quad])
        try await page.addUnderline(quads: [quad])
        try await page.addStrikeout(quads: [quad])

        let reopened = try await PdfDocument(data: try await doc.data())
        let names = try await reopened.page(0).annotations().suffix(3).map(\.caseName)
        XCTAssertEqual(names, ["highlight", "underline", "strikeout"])
        await doc.close()
    }

    func testAddedNoteCarriesItsContents() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        try await page.addNote(rect: PdfRect(left: 10, bottom: 10, right: 40, top: 40),
                               contents: "a review comment")

        let annotations = try await page.annotations()
        let note = try XCTUnwrap(annotations.last)
        XCTAssertEqual(note.base.contents, "a review comment")
        await doc.close()
    }

    func testAnnotationCanBeRemoved() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        try await page.addNote(rect: PdfRect(left: 1, bottom: 1, right: 2, top: 2), contents: "x")
        let added = try await page.annotations().count

        try await page.removeAnnotation(at: added - 1)
        let remaining = try await page.annotations().count
        XCTAssertEqual(remaining, added - 1)
        await doc.close()
    }

    // MARK: - Save round-trip

    func testEditsSurviveSaveAndReopen() async throws {
        let doc = try await open("hello_world.pdf")
        let page = try await doc.page(0)
        try await page.addNote(rect: PdfRect(left: 10, bottom: 10, right: 40, top: 40),
                               contents: "persisted note")
        let saved = try await doc.data()
        await doc.close()

        XCTAssertGreaterThan(saved.count, 0)
        let reopened = try await PdfDocument(data: saved)
        let reopenedPage = try await reopened.page(0)
        let annotations = try await reopenedPage.annotations()

        XCTAssertTrue(annotations.contains { $0.base.contents == "persisted note" },
                      "the note did not survive the save/reopen cycle")
        await reopened.close()
    }

    func testFormValueSurvivesSaveAndReopen() async throws {
        let doc = try await open("text_form.pdf")
        let page = try await doc.page(0)
        let fields = try await page.formFields()
        let target = try XCTUnwrap(fields.first { if case .text = $0 { return true }; return false })
        try await page.setText("Persisted", forFieldAt: target.base.annotationIndex)

        let saved = try await doc.data(mode: .full)
        await doc.close()

        let reopened = try await PdfDocument(data: saved)
        let reopenedPage = try await reopened.page(0)
        let after = try await reopenedPage.formFields()
        guard let updated = after.first(where: { $0.base.annotationIndex == target.base.annotationIndex }),
              case .text(let field) = updated else { return XCTFail("field missing after reopen") }
        XCTAssertEqual(field.value, "Persisted")
        await reopened.close()
    }

    /// The web build once lost every edit here: form state outlived close() and was
    /// inherited by the next document to reuse the handle.
    func testFormValueSurvivesSaveWhenEarlierFormDocumentsWereClosed() async throws {
        for cycle in 0..<10 {
            let earlier = try await open(cycle % 2 == 0 ? "click_form.pdf" : "combobox_form.pdf")
            _ = try await earlier.page(0).formFields()
            await earlier.close()

            let doc = try await open("text_form.pdf")
            let page = try await doc.page(0)
            let fields = try await page.formFields()
            let target = try XCTUnwrap(fields.first { if case .text = $0 { return true }; return false })
            try await page.setText("value \(cycle)", forFieldAt: target.base.annotationIndex)
            let saved = try await doc.data(mode: .full)

            let reopened = try await PdfDocument(data: saved)
            let after = try await reopened.page(0).formFields()
            await reopened.close()
            await doc.close()
            guard let updated = after.first(where: { $0.base.annotationIndex == target.base.annotationIndex }),
                  case .text(let field) = updated else { return XCTFail("field missing in cycle \(cycle)") }
            XCTAssertEqual(field.value, "value \(cycle)", "cycle \(cycle)")
        }
    }

    // MARK: - Metadata, outline, links

    func testMetadataReadsWithoutThrowing() async throws {
        let doc = try await open("hello_world.pdf")
        let metadata = try await doc.metadata
        // Corpus documents may carry no metadata; the contract is that reading succeeds.
        XCTAssertNotNil(metadata)
        await doc.close()
    }

    func testEmbeddedAttachmentsAreListedAndExtracted() async throws {
        let doc = try await open("embedded_attachments.pdf")
        let list = try await doc.attachments
        XCTAssertEqual(list.map(\.name), ["1.txt", "attached.pdf"])

        let text = try await doc.attachmentData(at: 0)
        XCTAssertEqual(String(decoding: text, as: UTF8.self), "test")

        let nested = try await doc.attachmentData(at: 1)
        XCTAssertTrue((1001..<100_000).contains(nested.count), "implausible size \(nested.count)")
        XCTAssertEqual(String(decoding: nested.prefix(5), as: UTF8.self), "%PDF-")
        await doc.close()
    }

    func testOutlineIsReadable() async throws {
        let doc = try await open("annots_action_handling.pdf")
        let outline = try await doc.outline
        XCTAssertNotNil(outline)
        await doc.close()
    }

    func testLinksAreReadable() async throws {
        let doc = try await open("annots_action_handling.pdf")
        let page = try await doc.page(0)
        let links = try await page.links()
        XCTAssertNotNil(links)
        await doc.close()
    }

    // MARK: - Lifetime and errors

    func testUsingAClosedDocumentThrowsClosedNotACrash() async throws {
        let doc = try await open("hello_world.pdf")
        await doc.close()

        do {
            _ = try await doc.metadata
            XCTFail("expected PdfError.closed")
        } catch let error as PdfError {
            XCTAssertEqual(error, .closed)
        }
    }

    /// A closed document counts zero pages, so page(0) reported "out of range (document has
    /// 0)" — true, and useless. Web and Android say closed; the basic sample showed iOS did not.
    func testAClosedDocumentsPageThrowsClosedNotOutOfRange() async throws {
        let doc = try await open("hello_world.pdf")
        await doc.close()

        do {
            _ = try await doc.page(0)
            XCTFail("expected PdfError.closed")
        } catch let error as PdfError {
            XCTAssertEqual(error, .closed)
        }
    }

    func testPageOutOfRangeReportsTheBounds() async throws {
        let doc = try await open("hello_world.pdf")
        do {
            _ = try await doc.page(99)
            XCTFail("expected pageOutOfRange")
        } catch let error as PdfError {
            XCTAssertEqual(error, .pageOutOfRange(99, count: 1))
        }
        await doc.close()
    }

    func testWrongPasswordIsDistinguishedFromMissingPassword() async throws {
        let url = Repo.corpus.appendingPathComponent("encrypted_hello_world_r2.pdf")
        let data = try Data(contentsOf: url)

        do {
            _ = try await PdfDocument(data: data)
            XCTFail("expected passwordRequired")
        } catch let error as PdfError {
            XCTAssertEqual(error, .passwordRequired)
        }

        do {
            _ = try await PdfDocument(data: data, password: "definitely-not-it")
            XCTFail("expected wrongPassword")
        } catch let error as PdfError {
            XCTAssertEqual(error, .wrongPassword)
        }
    }

    // MARK: - Concurrency

    /// The core safety claim: hammering one document from many tasks must not corrupt
    /// memory. Before the actor, this pattern was a native crash.
    func testConcurrentAccessToOneDocumentIsSafe() async throws {
        let doc = try await open("many_rectangles.pdf")

        try await withThrowingTaskGroup(of: Int.self) { group in
            for _ in 0..<32 {
                group.addTask {
                    let page = try await doc.page(0)
                    let image = try await page.render(width: 64)
                    let text = try await page.text.string()
                    return Int(image.size.width) + text.count
                }
            }
            var completed = 0
            for try await _ in group { completed += 1 }
            XCTAssertEqual(completed, 32)
        }
        await doc.close()
    }

    func testSeparateDocumentsRenderConcurrently() async throws {
        try await withThrowingTaskGroup(of: Void.self) { group in
            for name in ["hello_world.pdf", "rectangles.pdf", "many_rectangles.pdf", "text_font.pdf"] {
                group.addTask {
                    let doc = try await self.open(name)
                    let page = try await doc.page(0)
                    _ = try await page.render(width: 120)
                    await doc.close()
                }
            }
            try await group.waitForAll()
        }
    }
}

/// Short case names, so a failure message names the shape that was actually found.
extension PdfAnnotation {
    var caseName: String {
        switch self {
        case .highlight: "highlight"; case .underline: "underline"
        case .strikeout: "strikeout"; case .squiggly: "squiggly"
        case .ink: "ink"; case .freeText: "freeText"
        case .square: "square"; case .circle: "circle"
        case .line: "line"; case .text: "text"
        case .link: "link"; case .stamp: "stamp"
        case .fileAttachment: "fileAttachment"; case .widget: "widget"
        case .unknown: "unknown"
        }
    }
}

extension PdfFormField {
    var caseName: String {
        switch self {
        case .text: "text"; case .checkBox: "checkBox"
        case .radioButton: "radioButton"; case .comboBox: "comboBox"
        case .listBox: "listBox"; case .pushButton: "pushButton"
        case .signature: "signature"; case .unknown: "unknown"
        }
    }
}

/// Documents which render flag actually paints a form field's value.
///
/// It matters for anything building an inline form editor: with `.forms` the engine
/// paints the value, so a native control on top would double-draw. Without it the
/// widget's static appearance is drawn but the value is not, leaving the field free
/// for a live control.
final class FormRenderFlagTests: LicensedTestCase {
    private func ink(_ image: UIImage, inside rect: PdfRect, page: PdfSize) -> Int {
        guard let cg = image.cgImage,
              let data = cg.dataProvider?.data as Data? else { return -1 }
        let scale = Double(cg.width) / page.width
        let x0 = Int(rect.left * scale), x1 = Int(rect.right * scale)
        let y0 = Int((page.height - rect.top) * scale), y1 = Int((page.height - rect.bottom) * scale)

        var count = 0
        for y in max(0, y0)..<min(cg.height, y1) {
            for x in max(0, x0)..<min(cg.width, x1) {
                let i = (y * cg.bytesPerRow) + x * 4
                guard i + 2 < data.count else { continue }
                if data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200 { count += 1 }
            }
        }
        return count
    }

    func testFormsFlagPaintsTheFieldValueAndAnnotationsAloneDoesNot() async throws {
        let url = Repo.corpus.appendingPathComponent("text_form.pdf")
        let doc = try await PdfDocument(data: try Data(contentsOf: url))
        let page = try await doc.page(0)
        let size = try await page.size

        let allFields = try await page.formFields()
        let field = try XCTUnwrap(allFields.first { if case .text = $0 { return true }; return false })
        try await page.setText("WIDGETVALUE", forFieldAt: field.base.annotationIndex)

        let withForms = try await page.render(width: 600, options: [.annotations, .forms])
        let withoutForms = try await page.render(width: 600, options: [.annotations])

        let painted = ink(withForms, inside: field.base.rect, page: size)
        let bare = ink(withoutForms, inside: field.base.rect, page: size)

        XCTAssertGreaterThan(painted, 0, "the .forms flag should paint the field value")
        XCTAssertEqual(bare, 0, "without .forms the value must not be painted, leaving room for a live control")
        await doc.close()
    }
}
