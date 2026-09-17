import XCTest
@testable import PDFCora

struct LicenseFixture: Decodable {
    struct Expected: Decodable { let kind: String; let reason: String?; let modules: [String]? }
    struct Case: Decodable { let name: String; let key: String?; let expected: [String: Expected] }
    let publicKey: String
    let releaseDate: String
    let revoked: [String]
    let app: String
    let fullKey: String
    let cases: [Case]

    static func load() throws -> LicenseFixture {
        let url = Repo.root.appendingPathComponent("conformance/license/cases.json")
        return try JSONDecoder().decode(LicenseFixture.self, from: Data(contentsOf: url))
    }
}

final class LicenseTests: LicensedTestCase {
    override func tearDown() {
        LicensedTestCase.installFullTestLicense()
        super.tearDown()
    }

    func testSharedCases() throws {
        let fixture = try LicenseFixture.load()
        for c in fixture.cases {
            let status = PdfLicense.configureForTesting(
                publicKey: fixture.publicKey, revoked: Set(fixture.revoked),
                releaseDate: fixture.releaseDate, appIdentifier: fixture.app, key: .some(c.key))
            let expected = try XCTUnwrap(c.expected["ios"], c.name)
            switch status {
            case .licensed(_, let modules):
                XCTAssertEqual(expected.kind, "licensed", "\(c.name): \(status)")
                XCTAssertEqual(modules.map(\.rawValue).sorted(), expected.modules, c.name)
            case .trial(let reason, let message):
                XCTAssertEqual(expected.kind, "trial", "\(c.name): \(message)")
                XCTAssertEqual(reason.rawValue, expected.reason, "\(c.name): \(message)")
            }
        }
    }

    private let mark = "PDFCora trial"

    private func read(_ name: String) throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    private func use(_ key: String?) throws {
        PdfLicense.configureForTesting(key: .some(key))
    }

    private func keyWith(_ modules: [String]) throws -> String {
        let url = Repo.root.appendingPathComponent("conformance/license/partial-keys.json")
        let keys = try XCTUnwrap(JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: String])
        return try XCTUnwrap(keys[modules.joined(separator: ",")], "missing key for \(modules)")
    }

    private func texts(_ data: Data) async throws -> [String] {
        let document = try await PdfDocument(data: data)
        var result: [String] = []
        for index in 0..<(await document.pageCount) {
            result.append(try await document.page(index).text.string())
        }
        return result
    }

    private func greyPixels(_ image: UIImage) -> Int {
        guard let cg = image.cgImage, let data = cg.dataProvider?.data, let bytes = CFDataGetBytePtr(data) else { return 0 }
        var count = 0
        for i in stride(from: 0, to: cg.width * cg.height * 4, by: 4) {
            let (b, g, r) = (Int(bytes[i]), Int(bytes[i + 1]), Int(bytes[i + 2]))
            if r < 250, r > 150, abs(r - g) < 8, abs(g - b) < 8 { count += 1 }
        }
        return count
    }

    func testTrialRenderIsWatermarked() async throws {
        let licensed = try await PdfDocument(data: try read("hello_world.pdf")).page(0).render(width: 400)
        try use(nil)
        let trial = try await PdfDocument(data: try read("hello_world.pdf")).page(0).render(width: 400)
        XCTAssertGreaterThan(greyPixels(trial), greyPixels(licensed) + 500)
    }

    func testTrialSaveIsWatermarkedOnEveryPage() async throws {
        try use(nil)
        let trial = try await PdfDocument(data: try read("hello_world_2_pages_split_streams.pdf")).data()
        for text in try await texts(trial) { XCTAssertTrue(text.contains(mark)) }
        LicensedTestCase.installFullTestLicense()
        let licensed = try await PdfDocument(data: try read("hello_world_2_pages_split_streams.pdf")).data()
        for text in try await texts(licensed) { XCTAssertFalse(text.contains(mark)) }
    }

    func testSavingTwiceStampsOnce() async throws {
        try use(nil)
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        _ = try await document.data()
        let text = try await texts(try await document.data())[0]
        XCTAssertEqual(text.components(separatedBy: mark).count - 1, 1)
    }

    func testIncrementalSaveOfMarkedDocumentIsFullAndWatermarked() async throws {
        try use(nil)
        let original = try read("hello_world.pdf")
        let saved = try await PdfDocument(data: original).data(mode: .incremental)
        XCTAssertNotEqual(saved.prefix(original.count), original)
        let text = try await texts(saved)[0]
        XCTAssertTrue(text.contains(mark))
    }

    func testUnlicensedModuleMarksTheDocument() async throws {
        try use(try keyWith(["forms"]))
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let before = await document.needsWatermark
        XCTAssertFalse(before)
        try await document.page(0).addNote(rect: PdfRect(left: 10, bottom: 10, right: 30, top: 30), contents: "x")
        let after = await document.needsWatermark
        XCTAssertTrue(after)
    }

    func testUnlicensedRedactionStillRemovesText() async throws {
        try use(try keyWith([]))
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        _ = try await document.redact([.textMatches("Hello")])
        let text = try await texts(try await document.data())[0]
        XCTAssertFalse(text.contains("Hello"))
        XCTAssertTrue(text.contains(mark))
    }

    /// pdfsig runs on the host over this file; see scripts/test-ios.sh.
    func testWritesAnUnlicensedSignedDocumentForTheHost() async throws {
        try use(try keyWith([]))
        let p12 = try Data(contentsOf: Repo.root.appendingPathComponent("conformance/fixtures/test-signer.p12"))
        let signed = try await PdfDocument(data: try read("hello_world.pdf"))
            .sign(PdfSignOptions(signer: try Pkcs12Signer(pkcs12: p12, password: "pdfcora")))
        let text = try await texts(signed)[0]
        XCTAssertTrue(text.contains(mark))
        try signed.write(to: URL(fileURLWithPath: "/tmp/pdfcora-ios-trial-signed.pdf"))
    }
}
