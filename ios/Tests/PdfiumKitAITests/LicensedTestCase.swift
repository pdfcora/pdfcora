import XCTest
@testable import PdfiumKit

class LicensedTestCase: XCTestCase {
    override class func setUp() {
        super.setUp()
        let url = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("conformance/license/cases.json")
        guard let data = try? Data(contentsOf: url),
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let publicKey = json["publicKey"] as? String, let fullKey = json["fullKey"] as? String,
              let releaseDate = json["releaseDate"] as? String, let app = json["app"] as? String
        else { return XCTFail("conformance/license/cases.json is missing") }
        PdfLicense.configureForTesting(publicKey: publicKey, revoked: [], releaseDate: releaseDate,
                                           appIdentifier: app, key: .some(fullKey))
    }
}
