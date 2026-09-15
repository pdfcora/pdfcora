import XCTest
@testable import PdfiumKit
@testable import PdfiumKitAI

/// Mirrors `web-ai/test/forms-detect.test.ts`.
final class FormDetectTests: LicensedTestCase {
    struct Expected: Decodable {
        struct Rect: Decodable { let left, bottom, right, top: Double }
        let pageIndex: Int; let kind: String; let label: String; let rect: Rect
    }

    private func flat() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: FormTests.dir.appendingPathComponent("flat.pdf")))
    }
    private func ai(_ document: PdfDocument) -> PdfiumAI {
        var options = PdfiumAIOptions()
        options.allowsOnDevice = false
        return PdfiumAI(document: document, options: options)
    }

    func testTheRulesFindTheExpectedBlanks() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: FormTests.dir.appendingPathComponent("flat-expected.json")))
        let detected = try await ai(try await flat()).forms.detect()
        XCTAssertTrue(detected.notice.contains("Check every field before it is added."))
        XCTAssertEqual(detected.items.map { "\($0.pageIndex) \($0.kind.rawValue) \($0.label)" }, expected.map { "\($0.pageIndex) \($0.kind) \($0.label)" })
        for (n, (item, e)) in zip(detected.items, expected).enumerated() {
            XCTAssertEqual(item.id, "0:\(n)")
            for (a, b) in [(item.rect.left, e.rect.left), (item.rect.bottom, e.rect.bottom), (item.rect.right, e.rect.right), (item.rect.top, e.rect.top)] {
                XCTAssertEqual(a, b, accuracy: 1, item.label)
            }
        }
    }

    func testAcceptedFieldsAreCreatedAndFormFillingUsesThem() async throws {
        let document = try await flat()
        let detected = try await ai(document).forms.detect()
        let withFields = try await detected.apply(accepting: detected.items.map(\.id))
        let fields = try await withFields.page(0).formFields()
        XCTAssertEqual(fields.map(\.base.name), detected.items.map(\.label))
        let proposals = try await ai(withFields).forms.propose(profile: [.givenName: "Anna", .familyName: "Schmidt", .email: "anna@example.com", .city: "London"])
        XCTAssertEqual(proposals.items.map(\.fieldName), ["First name", "Last name", "Email", "City"])
        let again = try await ai(withFields).forms.detect()
        XCTAssertEqual(again.items, [])
        do { _ = try await detected.apply(accepting: ["9:9"]); XCTFail() } catch PdfProposalError.unknownProposal {}
    }
}
