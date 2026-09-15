import XCTest
@testable import PdfiumKit

/// Every suite runs licensed for every module. License tests change this locally and
/// restore it themselves.
class LicensedTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        installFullTestLicense()
    }

    static func installFullTestLicense() {
        guard let fixture = try? LicenseFixture.load() else { return XCTFail("conformance/license/cases.json is missing") }
        PdfLicense.configureForTesting(publicKey: fixture.publicKey, revoked: Set(fixture.revoked),
                                       releaseDate: fixture.releaseDate, appIdentifier: fixture.app,
                                       key: .some(fixture.fullKey))
    }
}
