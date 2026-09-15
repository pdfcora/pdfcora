import XCTest
@testable import PdfiumKit

final class SnapshotAndMarksTests: LicensedTestCase {
    private func read(_ name: String) throws -> Data { try Data(contentsOf: Repo.corpus.appendingPathComponent(name)) }
    private func rect(_ l: Double, _ b: Double, _ r: Double, _ t: Double) -> PdfRect { PdfRect(left: l, bottom: b, right: r, top: t) }

    func testASnapshotReopensTheDocumentAsItWas() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        try await document.page(0).addNote(rect: rect(10, 10, 30, 30), contents: "kept")
        let snapshot = try await document.snapshot()
        _ = try await document.redact([.textMatches("Hello")])

        let copy = try await snapshot.open()
        let text = try await copy.page(0).text.string()
        XCTAssertTrue(text.contains("Hello"))
        let annotations = try await copy.page(0).annotations()
        XCTAssertEqual(annotations.count, 1)
    }

    func testASnapshotOfAWatermarkedDocumentReopensWatermarked() async throws {
        PdfLicense.configureForTesting(key: .some(nil))
        defer { LicensedTestCase.installFullTestLicense() }
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let copy = try await document.snapshot().open()
        let needs = await copy.needsWatermark
        XCTAssertTrue(needs)
        let saved = try await PdfDocument(data: try await copy.data())
        let text = try await saved.page(0).text.string()
        XCTAssertEqual(text.components(separatedBy: "PdfiumKit trial").count - 1, 1)
    }

    private func viewer() async throws -> PdfViewer {
        try await PdfViewer(document: try await PdfDocument(data: try read("hello_world.pdf")), viewport: CGSize(width: 400, height: 600))
    }

    func testMarksAreHitTestedTopmostFirstAndTapsCycle() async throws {
        let v = try await viewer()
        await v.setMarks([PdfMark(id: "a", pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: .pending),
                          PdfMark(id: "b", pageIndex: 0, rects: [rect(50, 20, 80, 30)], state: .pending)])
        let top = await v.markAt(page: 0, point: PdfPoint(x: 60, y: 25))
        XCTAssertEqual(top, "b")
        let other = await v.markAt(page: 1, point: PdfPoint(x: 20, y: 15))
        XCTAssertNil(other)
        var states: [PdfMarkState] = []
        for _ in 0..<3 {
            await v.tapMark(page: 0, point: PdfPoint(x: 20, y: 15))
            states.append(await v.marks[0].state)
        }
        XCTAssertEqual(states, [.accepted, .rejected, .pending])
        await v.setAllMarks(.accepted)
        let all = await v.marks.map(\.state)
        XCTAssertEqual(all, [.accepted, .accepted])
    }

    func testMarksNeverReachTheEventStream() async throws {
        let v = try await viewer()
        let events = LockedCount()
        _ = await v.onEvent { _ in events.increment() }
        await v.setMarks([PdfMark(id: "a", pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: .pending)])
        await v.tapMark(page: 0, point: PdfPoint(x: 20, y: 20))
        await v.setAllMarks(.rejected)
        await v.flush()
        XCTAssertEqual(events.value, 0)
    }
}

final class LockedCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
