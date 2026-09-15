import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/form-fields.test.ts`.
final class FormFieldCreationTests: LicensedTestCase {
    private let fields = [
        PdfNewFormField(pageIndex: 0, kind: .text, rect: PdfRect(left: 179.5, bottom: 621.5, right: 500.5, top: 642.5), name: "Email", tooltip: "Email"),
        PdfNewFormField(pageIndex: 0, kind: .checkBox, rect: PdfRect(left: 71.5, bottom: 517.5, right: 84.5, top: 530.5), name: "I agree to the terms"),
    ]

    private func open(_ path: String) async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Repo.root.appendingPathComponent("conformance/\(path)")))
    }

    func testCreatedFieldsFillAndKeepTheirValues() async throws {
        let document = try await open("forms/flat.pdf")
        let withFields = try await document.addFormFields(fields)
        let original = try await document.page(0).formFields()
        XCTAssertEqual(original.count, 0)

        let page = try await withFields.page(0)
        let created = try await page.formFields()
        XCTAssertEqual(created.map(\.base.name), ["Email", "I agree to the terms"])
        XCTAssertEqual(created.map(\.base.alternateName), ["Email", nil])
        XCTAssertEqual(created[0].base.rect, fields[0].rect)

        try await page.setText("anna@example.com", forFieldAt: created[0].base.annotationIndex)
        try await page.setChecked(true, forFieldAt: created[1].base.annotationIndex)
        let reopened = try await PdfDocument(data: try await withFields.data())
        let after = try await reopened.page(0).formFields()
        guard case .text(let text) = after[0], case .checkBox(let box) = after[1] else { return XCTFail("kinds changed") }
        XCTAssertEqual(text.value, "anna@example.com")
        XCTAssertTrue(box.isChecked)
    }

    func testExistingFieldsAreKeptAndNamesMustBeNew() async throws {
        let document = try await open("corpus/text_form.pdf")
        let existing = try await document.page(0).formFields()
        let moved = PdfNewFormField(pageIndex: 0, kind: .text, rect: PdfRect(left: 300, bottom: 50, right: 500, top: 70), name: "Email")
        let withFields = try await document.addFormFields([moved])
        let names = try await withFields.page(0).formFields().map(\.base.name)
        XCTAssertEqual(names, [existing[0].base.name, "Email"])

        for bad in [[PdfNewFormField(pageIndex: 0, kind: .text, rect: moved.rect, name: existing[0].base.name!)], [moved, moved],
                    [PdfNewFormField(pageIndex: 0, kind: .text, rect: moved.rect, name: " ")]] {
            do { _ = try await document.addFormFields(bad); XCTFail("expected invalidOperation") } catch PdfError.invalidOperation {}
        }
    }
}
