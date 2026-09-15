import XCTest
@testable import PdfiumKit

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
}
