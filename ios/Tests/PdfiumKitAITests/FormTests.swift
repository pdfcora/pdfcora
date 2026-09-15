import XCTest
@testable import PdfiumKit
@testable import PdfiumKitAI

final class FormTests: LicensedTestCase {
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/forms")
    static let profile: [PdfProfileKey: String] = [
        .givenName: "Anna", .familyName: "Schmidt", .fullName: "Anna Schmidt", .dateOfBirth: "1985-03-14",
        .email: "anna.schmidt@example.com", .phone: "+44 20 7946 0958", .street: "221B Baker Street", .postalCode: "NW1 6XE",
        .city: "London", .country: "United Kingdom", .iban: "GB29 NWBK 6016 1331 9268 19", .company: "Example Holdings Ltd",
    ]

    private func forms() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("forms.pdf")))
    }
    private func ai(_ document: PdfDocument, _ provider: PdfAiProvider? = nil) -> PdfiumAI {
        var options = PdfiumAIOptions(provider: provider)
        options.allowsOnDevice = false
        return PdfiumAI(document: document, options: options)
    }
    private func textValue(_ document: PdfDocument, _ page: Int, _ name: String) async throws -> String? {
        for field in try await document.page(page).formFields() where field.base.name == name {
            if case .text(let t) = field { return t.value }
        }
        return nil
    }

    struct Case: Decodable { let name: String?; let alternateName: String?; let label: String?; let expected: String }

    func testSharedMatchingCases() throws {
        let cases = try JSONDecoder().decode([Case].self, from: Data(contentsOf: Self.dir.appendingPathComponent("matching.json")))
        for c in cases {
            XCTAssertEqual(Synonyms.key(name: c.name, alternateName: c.alternateName, label: c.label)?.rawValue ?? "unknown",
                           c.expected, "\(c)")
        }
    }

    func testFieldsAreDescribedWithTheirLabels() async throws {
        let described = try await FieldDescriber.describe(try await forms(), pages: nil)
        let labels = Dictionary(uniqueKeysWithValues: described.map { ($0.base.name ?? "", $0.label ?? "-") })
        XCTAssertEqual(labels, [
            "fname": "First name", "Surname_1": "Surname", "Text3": "Date of birth (MM/DD/YYYY)", "email": "Email", "Text5": "Phone",
            "Text6": "Street address", "Zip": "ZIP code", "Town": "City", "Country": "Country", "Text9": "IBAN", "Text11": "Employer",
            "Newsletter": "Send me the newsletter", "Colour": "Favourite colour", "Signature1": "Signature", "Submit": "-",
            "Vorname": "Vorname", "Feld2": "Nachname", "Geb": "Geburtsdatum (TT.MM.JJJJ)", "Feld4": "E-Mail-Adresse", "Feld5": "Telefonnummer",
            "Feld6": "Straße und Hausnummer", "Plz": "PLZ", "Wohnort": "Ort", "Land": "Land", "Feld9": "IBAN", "Zustimmung": "Ich stimme zu", "Feld11": "Firma",
        ])
    }

    struct Expected: Decodable {
        let pageIndex: Int; let fieldName: String; let key: String; let value: Value
        enum Value: Decodable, Equatable {
            case text(String), index(Int)
            init(from decoder: Decoder) throws {
                let c = try decoder.singleValueContainer()
                if let i = try? c.decode(Int.self) { self = .index(i) } else { self = .text(try c.decode(String.self)) }
            }
        }
    }

    func testTheSynonymListProposesExactlyTheExpectedValues() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Self.dir.appendingPathComponent("forms-expected.json")))
        let proposals = try await ai(try await forms()).forms.propose(profile: Self.profile)
        XCTAssertFalse(proposals.modelUsed)
        XCTAssertTrue(proposals.notice.contains("Check every value before filling in the form."))
        XCTAssertEqual(proposals.items.count, expected.count)
        for (p, e) in zip(proposals.items, expected) {
            XCTAssertEqual(p.pageIndex, e.pageIndex)
            XCTAssertEqual(p.fieldName, e.fieldName)
            XCTAssertEqual(p.key.rawValue, e.key)
            switch (p.value, e.value) {
            case (.text(let a), .text(let b)): XCTAssertEqual(a, b)
            case (.option(let a), .index(let b)): XCTAssertEqual(a, b)
            default: XCTFail("\(p.value) vs \(e.value)")
            }
            XCTAssertEqual(p.source, .rules)
            XCTAssertEqual(p.id, "\(p.pageIndex):\(p.annotationIndex):\(p.key.rawValue)")
        }
    }

    struct FieldModel: PdfAiProvider {
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            func id(_ name: String) -> String? {
                request.prompt.split(separator: "\n").first { $0.contains("name \"\(name)\"") }
                    .map { String($0.dropFirst("- id ".count)).components(separatedBy: ": name").first! }
            }
            let fields: [[String: String]] = [
                ["id": id("Colour") ?? "", "key": "company"], ["id": id("Newsletter") ?? "", "key": "bogus"], ["id": "0:0", "key": "familyName"],
            ]
            let json = String(data: try JSONSerialization.data(withJSONObject: ["fields": fields]), encoding: .utf8)!
            XCTAssertFalse(request.prompt.contains("name \"fname\""), "matched fields are not sent")
            return PdfAiResponse(text: "", structured: json)
        }
    }

    func testAModelFillsWhatSynonymsCannotButCannotOverrideOrInvent() async throws {
        let proposals = try await ai(try await forms(), FieldModel()).forms.propose(profile: Self.profile, pages: 0...0)
        XCTAssertTrue(proposals.modelUsed)
        let byName = Dictionary(uniqueKeysWithValues: proposals.items.map { ($0.fieldName ?? "", $0) })
        XCTAssertEqual(byName["Colour"]?.key, .company)
        XCTAssertEqual(byName["Colour"]?.source, .customProvider)
        XCTAssertEqual(byName["fname"]?.key, .givenName)
        XCTAssertNil(byName["Newsletter"])
    }

    func testApplyWritesOnlyAcceptedValuesAndUndoRestores() async throws {
        let document = try await forms()
        let proposals = try await ai(document).forms.propose(profile: Self.profile, pages: 0...0)
        let accept = proposals.items.filter { $0.fieldName == "fname" || $0.fieldName == "Country" }.map(\.id)
        let applied = try await proposals.apply(accepting: accept)
        let fname = try await textValue(document, 0, "fname")
        let surname = try await textValue(document, 0, "Surname_1")
        XCTAssertEqual(fname, "Anna")
        XCTAssertEqual(surname, "")
        var countrySelection: [Int] = []
        for field in try await document.page(0).formFields() {
            if case .comboBox(let c) = field, c.base.name == "Country" { countrySelection = c.selectedIndices }
        }
        XCTAssertEqual(countrySelection, [1])
        let restored = try await applied.undo()
        let back = try await textValue(restored, 0, "fname")
        XCTAssertEqual(back, "")
    }

    func testAnUnknownIdWritesNothing() async throws {
        let document = try await forms()
        let proposals = try await ai(document).forms.propose(profile: Self.profile)
        do {
            _ = try await proposals.apply(accepting: [proposals.items[0].id, "nope"])
            XCTFail("expected a throw")
        } catch PdfProposalError.unknownProposal(let id) {
            XCTAssertEqual(id, "nope")
        }
        let fname = try await textValue(document, 0, "fname")
        XCTAssertEqual(fname, "")
    }
}
