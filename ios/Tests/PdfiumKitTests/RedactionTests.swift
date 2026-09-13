import XCTest
@testable import PdfiumKit

/**
 Mirrors `web/test/{page-objects,redact-region,redact-split,redact-search,redact-scrub}.test.ts`.

 The gate throughout is a raw-byte scan of the saved file, not text extraction. A black
 box drawn over text looks right and leaves every word in the document, which is the
 classic redaction failure and the reason this feature exists.
 */
final class RedactionTests: XCTestCase {
    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    private func latin1(_ data: Data) -> String {
        String(String.UnicodeScalarView(data.map { UnicodeScalar($0) }))
    }

    // MARK: - Page objects

    func testListsTheObjectsOnAPageWithTheirBounds() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let objects = try await document.pageObjects(at: 0)

        XCTAssertEqual(objects.count, 2)
        XCTAssertTrue(objects.allSatisfy { $0.kind == .text })
        XCTAssertEqual(objects[0].bounds.left, 20.2, accuracy: 0.5)
        XCTAssertEqual(objects[0].text, "Hello, world!")
        XCTAssertEqual(objects[1].text, "Goodbye, world!")
        XCTAssertEqual(objects[1].fontSize ?? 0, 16, accuracy: 0.01)
    }

    func testPathsAreReportedAsPathsWithNoText() async throws {
        let document = try await PdfDocument(data: try read("rectangles.pdf"))
        let objects = try await document.pageObjects(at: 0)
        XCTAssertEqual(objects.count, 8)
        XCTAssertTrue(objects.allSatisfy { $0.kind == .path && $0.text == nil })
    }

    func testBoundsAreNormalised() async throws {
        for file in ["hello_world.pdf", "rectangles.pdf", "annotation_stamp_with_ap.pdf"] {
            let document = try await PdfDocument(data: try read(file))
            for object in try await document.pageObjects(at: 0) {
                XCTAssertLessThanOrEqual(object.bounds.left, object.bounds.right, file)
                XCTAssertLessThanOrEqual(object.bounds.bottom, object.bounds.top, file)
            }
        }
    }

    // MARK: - Region redaction

    /// The only assertion that matters.
    func testRedactedTextIsGoneFromTheTextAndTheBytes() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let objects = try await document.pageObjects(at: 0)
        let goodbye = try XCTUnwrap(objects.first { $0.text?.contains("Goodbye") == true })

        _ = try await document.redact([.region(goodbye.bounds, pageIndex: 0)])
        let saved = try await document.data(mode: .full)

        let reopened = try await PdfDocument(data: saved)
        let text = try await reopened.page(0).text.string()
        XCTAssertFalse(text.contains("Goodbye"), "still extractable: \(text)")
        XCTAssertFalse(latin1(saved).contains("Goodbye"), "still in the file bytes")
        XCTAssertTrue(text.contains("Hello"), "unrelated content was lost: \(text)")
    }

    func testAnObjectOutsideTheRegionIsUntouched() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let report = try await document.redact([
            .region(PdfRect(left: 0, bottom: 0, right: 5, top: 5), pageIndex: 0),
        ])
        XCTAssertEqual(report.textObjects, 0)

        let saved = try await document.data(mode: .full)
        let text = try await PdfDocument(data: saved).page(0).text.string()
        XCTAssertTrue(text.contains("Hello") && text.contains("Goodbye"))
    }

    /**
     GenerateContent rewrites the whole content stream, so anything PDFium does not model
     as a page object is lost in the rewrite. This is the control for that.
     */
    func testANoOpRedactionPreservesEveryPageOfText() async throws {
        let files = ["hello_world.pdf", "text_form.pdf", "rectangles.pdf", "text_font.pdf",
                     "hebrew_mirrored.pdf", "tagged_actual_text.pdf",
                     "annotation_highlight_long_content.pdf", "find_text_consecutive.pdf"]

        for file in files {
            let base = try read(file)
            let before = try await PdfDocument(data: base).page(0).text.string()

            let document = try await PdfDocument(data: base)
            _ = try await document.redact([
                .region(PdfRect(left: -9999, bottom: -9999, right: -9998, top: -9998), pageIndex: 0),
            ])
            let after = try await PdfDocument(data: try await document.data(mode: .full))
                .page(0).text.string()

            XCTAssertEqual(after, before, "\(file): the content stream rewrite lost text")
        }
    }

    func testAPageThatDoesNotExistIsRefused() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        do {
            _ = try await document.redact([
                .region(PdfRect(left: 0, bottom: 0, right: 1, top: 1), pageIndex: 9),
            ])
            XCTFail("expected a refusal")
        } catch let error as PdfError {
            XCTAssertTrue("\(error)".lowercased().contains("page"), "\(error)")
        }
    }

    // MARK: - Splitting

    func testARegionOverPartOfARunRemovesOnlyThoseCharacters() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let objects = try await document.pageObjects(at: 0)
        let run = try XCTUnwrap(objects.first { $0.text == "Goodbye, world!" })

        let region = PdfRect(left: run.bounds.left, bottom: run.bounds.bottom,
                             right: run.bounds.left + 62, top: run.bounds.top)
        let report = try await document.redact([.region(region, pageIndex: 0)])

        let saved = try await document.data(mode: .full)
        let text = try await PdfDocument(data: saved).page(0).text.string()

        XCTAssertFalse(text.contains("Goodbye"), "covered word survived: \(text)")
        XCTAssertTrue(text.contains("world"), "uncovered text was lost: \(text)")
        XCTAssertFalse(latin1(saved).contains("Goodbye"))
        XCTAssertEqual(report.textObjectsSplit, 1)
        XCTAssertEqual(report.textObjects, 0, "the run was split, not removed outright")
    }

    /// A character half inside the region is still legible, so it goes.
    func testCharactersAreDroppedOnIntersectionNotContainment() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let objects = try await document.pageObjects(at: 0)
        let run = try XCTUnwrap(objects.first { $0.text == "Goodbye, world!" })

        let region = PdfRect(left: run.bounds.left, bottom: run.bounds.bottom,
                             right: run.bounds.left + 4, top: run.bounds.top)
        _ = try await document.redact([.region(region, pageIndex: 0)])

        let text = try await PdfDocument(data: try await document.data(mode: .full))
            .page(0).text.string()
        XCTAssertFalse(text.contains("Goodbye"))
        XCTAssertTrue(text.contains("oodbye"), "the rest of the word should remain: \(text)")
    }

    func testTheSurvivingTextKeepsItsFontSize() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let objects = try await document.pageObjects(at: 0)
        let run = try XCTUnwrap(objects.first { $0.text == "Goodbye, world!" })

        _ = try await document.redact([
            .region(PdfRect(left: run.bounds.left, bottom: run.bounds.bottom,
                            right: run.bounds.left + 62, top: run.bounds.top), pageIndex: 0),
        ])
        let reopened = try await PdfDocument(data: try await document.data(mode: .full))
        let after = try await reopened.pageObjects(at: 0)
        let survivor = try XCTUnwrap(after.first {
            $0.text?.contains("world") == true && $0.text?.contains("Hello") == false
        })
        XCTAssertEqual(survivor.fontSize ?? 0, 16, accuracy: 0.01,
                       "a split that loses the size reflows the page")
    }

    // MARK: - Search

    func testRedactingBySearchRemovesEveryOccurrence() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        _ = try await document.redact([.textMatches("world")])

        let saved = try await document.data(mode: .full)
        let text = try await PdfDocument(data: saved).page(0).text.string()
        XCTAssertFalse(text.contains("world"), "still present: \(text)")
        XCTAssertFalse(latin1(saved).contains("world"), "still in the file bytes")
    }

    func testAQueryThatMatchesNothingChangesNothing() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let report = try await document.redact([.textMatches("zzzzz")])
        XCTAssertEqual(report.textObjects + report.textObjectsSplit, 0)
    }

    // MARK: - Scrub

    func testAnAnnotationOverTheRegionIsRemoved() async throws {
        let document = try await PdfDocument(data: try read("annotation_highlight_long_content.pdf"))
        let annotations = try await document.page(0).annotations()
        XCTAssertFalse(annotations.isEmpty)

        let report = try await document.redact([.region(annotations[0].base.rect, pageIndex: 0)])
        XCTAssertGreaterThan(report.annotations, 0, "the report must say the annotation went")

        let after = try await PdfDocument(data: try await document.data(mode: .full))
            .page(0).annotations()
        XCTAssertLessThan(after.count, annotations.count)
    }

    /// A filled field carries its value outside the content stream, in the AcroForm.
    func testAFormFieldValueInTheRegionIsRemoved() async throws {
        let document = try await PdfDocument(data: try read("text_form.pdf"))
        let page = try await document.page(0)
        let fields = try await page.formFields()
        let field = try XCTUnwrap(fields.first)
        try await page.setText("SECRETVALUE", forFieldAt: field.base.annotationIndex)

        let report = try await document.redact([.region(field.base.rect, pageIndex: 0)])
        XCTAssertGreaterThan(report.annotations, 0, "the widget is an annotation and must go")

        let saved = try await document.data(mode: .full)
        XCTAssertFalse(latin1(saved).contains("SECRETVALUE"),
                       "a filled field carries the text out of the document")
    }
}
