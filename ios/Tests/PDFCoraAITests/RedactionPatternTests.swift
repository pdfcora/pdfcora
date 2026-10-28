import XCTest
@testable import PDFCoraAI

final class RedactionPatternTests: XCTestCase {
    struct Case: Decodable { let text: String; let expected: [[String]] }

    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func testSharedCases() throws {
        let data = try Data(contentsOf: Self.root.appendingPathComponent("conformance/redaction/patterns.json"))
        for c in try JSONDecoder().decode([Case].self, from: data) {
            let text = NSString(string: c.text)
            let found = Patterns.find(in: c.text).map {
                [$0.category.rawValue, text.substring(with: NSRange(location: $0.range.lowerBound, length: $0.range.count))]
            }
            XCTAssertEqual(found, c.expected, c.text)
        }
    }

    func testCategoriesRestrictWhatIsLookedFor() {
        let found = Patterns.find(in: "anna@example.com 4111 1111 1111 1111", categories: [.email])
        XCTAssertEqual(found.map(\.category), [.email])
    }
}
