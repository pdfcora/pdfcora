import XCTest
@testable import PdfiumKit

/// Locates the repository from this file's compile-time path, so the shared corpus and
/// expectations are found without bundling them as test resources.
enum Repo {
    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // PdfiumKitTests
        .deletingLastPathComponent()   // Tests
        .deletingLastPathComponent()   // ios
        .deletingLastPathComponent()   // repo root

    static var corpus: URL { root.appendingPathComponent("conformance/corpus") }
    static var expectationsURL: URL { root.appendingPathComponent("conformance/expectations.json") }
}

struct Expectations: Decodable {
    struct Page: Decodable {
        let width: Double
        let height: Double
    }
    struct Document: Decodable {
        let category: String
        let opens: Bool
        let openError: String?
        let pageCount: Int?
        let pages: [Page]?
        let metadata: [String: String]?
    }
    let engine: String
    let documents: [String: Document]
}

final class ConformanceTests: XCTestCase {
    private static var expectations: Expectations = {
        let data = try! Data(contentsOf: Repo.expectationsURL)
        return try! JSONDecoder().decode(Expectations.self, from: data)
    }()

    func testExpectationsFileIsPresentAndNonEmpty() {
        XCTAssertFalse(Self.expectations.documents.isEmpty,
                       "conformance/expectations.json is empty — run node conformance/generate.mjs")
    }

    func testEngineRevisionMatchesExpectations() {
        XCTAssertEqual(PdfDocument.engineVersion, Self.expectations.engine)
    }

    /// The core conformance run: every corpus document, checked against the shared contract.
    func testAllCorpusDocumentsMatchExpectations() async throws {
        var checked = 0
        for (name, expected) in Self.expectations.documents {
            let url = Repo.corpus.appendingPathComponent(name)
            let data = try Data(contentsOf: url)

            if !expected.opens {
                do {
                    _ = try await PdfDocument(data: data)
                    XCTFail("\(name): expected open to fail with \(expected.openError ?? "?")")
                } catch let error as PdfError {
                    assertOpenError(error, matches: expected.openError, for: name)
                }
                checked += 1
                continue
            }

            let doc = try await PdfDocument(data: data)
            let count = await doc.pageCount
            XCTAssertEqual(count, expected.pageCount ?? -1, "\(name): page count")

            if let pages = expected.pages {
                for (i, expectedPage) in pages.enumerated() {
                    let page = try await doc.page(i)
                    let size = try await page.size
                    XCTAssertEqual(size.width, expectedPage.width, accuracy: 0.01, "\(name) page \(i) width")
                    XCTAssertEqual(size.height, expectedPage.height, accuracy: 0.01, "\(name) page \(i) height")
                }
            }
            await doc.close()
            checked += 1
        }
        XCTAssertEqual(checked, Self.expectations.documents.count)
    }

    private func assertOpenError(_ error: PdfError, matches expected: String?, for name: String) {
        switch (error, expected) {
        case (.passwordRequired, "password"), (.wrongPassword, "password"): break
        case (.corrupt, "format"), (.corrupt, "file"): break
        case (.unsupportedSecurity, "security"): break
        default:
            XCTFail("\(name): error \(error) does not match expected \(expected ?? "nil")")
        }
    }
}
