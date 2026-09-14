import XCTest
@testable import PdfiumKit

/// Mirrors `web/test/{viewer-editing,viewer-delegation,viewer-sync-edits,viewer-presenter}.test.ts`.
final class ViewerEditingTests: XCTestCase {

    private let phone = CGSize(width: 390, height: 700)
    private let rect = PdfRect(left: 10, bottom: 10, right: 30, top: 30)

    private func data(_ name: String = "hello_world.pdf") throws -> Data {
        try Data(contentsOf: Repo.corpus.appendingPathComponent(name))
    }

    /// Blanks the trailer's `/ID`, which PDFium regenerates on every save on Apple
    /// platforms — the web build does not. Everything else must still match byte for
    /// byte, so the gate keeps its strength; without this it would fail even when
    /// comparing a document with itself.
    private func withoutDocumentId(_ data: Data) -> String {
        let text = String(String.UnicodeScalarView(data.map { UnicodeScalar($0) }))
        return text.replacingOccurrences(
            of: "/ID\\[<[0-9A-Fa-f]*><[0-9A-Fa-f]*>\\]",
            with: "/ID[<><>]",
            options: .regularExpression)
    }

    private func viewer(_ name: String = "hello_world.pdf",
                        role: PdfViewerRole = .presenter,
                        presenterId: String? = nil) async throws -> (PdfViewer, PdfDocument) {
        let document = try await PdfDocument(data: try data(name))
        let v = try await PdfViewer(document: document, viewport: phone,
                                    options: .init(coalesceInterval: 0, role: role,
                                                   presenterId: presenterId))
        return (v, document)
    }

    // MARK: - Editing

    func testAnEditReachesTheDocumentAndEmitsOnce() async throws {
        let (v, document) = try await viewer()
        let box = EditBox()
        await v.onEvent { box.append($0) }

        try await v.addNote(rect: rect, contents: "hello")

        let annotations = try await document.page(0).annotations().count
        XCTAssertEqual(box.events.count, 1)
        XCTAssertEqual(annotations, 1)
        guard case .edit(let edit) = box.events[0].change else { return XCTFail("not an edit") }
        guard case .noteAdded(_, _, let contents, _) = edit else { return XCTFail("wrong kind") }
        XCTAssertEqual(contents, "hello")
    }

    func testAnEditIsNotCoalescedAway() async throws {
        // A one-second viewport window makes the distinction unambiguous: viewport
        // changes may be dropped in favour of a later one, edits never.
        let document = try await PdfDocument(data: try data())
        let v = try await PdfViewer(document: document, viewport: phone,
                                    options: .init(coalesceInterval: 1))
        let box = EditBox()
        await v.onEvent { box.append($0) }

        try await v.addNote(rect: rect, contents: "one")
        try await v.addNote(rect: PdfRect(left: 40, bottom: 10, right: 60, top: 30), contents: "two")

        XCTAssertEqual(box.events.count, 2, "both edits, despite the throttle")
    }

    func testRedactionThroughTheViewerRemovesContentFromTheBytes() async throws {
        let (v, document) = try await viewer()
        let objects = try await document.pageObjects(at: 0)
        let target = try XCTUnwrap(objects.first { $0.text?.contains("Goodbye") == true })

        _ = try await v.redact([.region(target.bounds, pageIndex: 0)])

        let saved = try await document.data(mode: .full)
        let latin1 = String(String.UnicodeScalarView(saved.map { UnicodeScalar($0) }))
        XCTAssertFalse(latin1.contains("Goodbye"), "still in the file bytes")
    }

    // MARK: - Delegation

    func testTheViewerDelegatesRatherThanReimplementing() async throws {
        // Two code paths producing annotations would drift, and the bug would appear
        // through only one of them. Byte identity is the only check strong enough.
        let viaPage = try await PdfDocument(data: try data())
        _ = try await viaPage.page(0).addNote(rect: rect, contents: "hello", color: .yellow)

        let (v, viaViewer) = try await viewer()
        try await v.addNote(rect: rect, contents: "hello", color: .yellow)

        let fromPage = try await viaPage.data(mode: .full)
        let fromViewer = try await viaViewer.data(mode: .full)
        XCTAssertEqual(withoutDocumentId(fromPage), withoutDocumentId(fromViewer),
                       "the viewer has diverged from the page API")
    }

    func testInkAndHighlightAlsoDelegate() async throws {
        let strokes = [[PdfPoint(x: 10, y: 10), PdfPoint(x: 50, y: 50)],
                       [PdfPoint(x: 20, y: 80), PdfPoint(x: 70, y: 80)]]
        let viaPage = try await PdfDocument(data: try data())
        _ = try await viaPage.page(0).addInk(strokes: strokes, color: .black, lineWidth: 3)

        let (v, viaViewer) = try await viewer()
        try await v.addInk(strokes: strokes, color: .black, lineWidth: 3)

        let fromPage = try await viaPage.data(mode: .full)
        let fromViewer = try await viaViewer.data(mode: .full)
        XCTAssertEqual(withoutDocumentId(fromPage), withoutDocumentId(fromViewer))
    }

    /// The reason the comparison is normalised at all, pinned so the next person does
    /// not spend an afternoon on it as I did.
    func testSavingTheSameDocumentTwiceDiffersOnlyInTheDocumentId() async throws {
        let data = try data()
        let document = try await PdfDocument(data: data)
        _ = try await document.page(0).addNote(rect: rect, contents: "hello", color: .yellow)

        let first = try await document.data(mode: .full)
        let second = try await document.data(mode: .full)

        XCTAssertNotEqual(first, second, "PDFium regenerates the trailer /ID on each save here")
        XCTAssertEqual(withoutDocumentId(first), withoutDocumentId(second),
                       "and nothing else should change")
    }

    // MARK: - Fingerprint and replay

    func testTheSameBytesShareAFingerprint() async throws {
        let a = try await PdfDocument(data: try data())
        let b = try await PdfDocument(data: try data())
        let other = try await PdfDocument(data: try data("text_form.pdf"))

        let fa = await a.fingerprint, fb = await b.fingerprint, fo = await other.fingerprint
        XCTAssertEqual(fa, fb)
        XCTAssertNotEqual(fa, fo)
    }

    func testAnAppliedEditReproducesTheChangeAndDoesNotEcho() async throws {
        let (source, _) = try await viewer()
        let (peer, peerDocument) = try await viewer()
        let sent = EditBox(), echoed = EditBox()
        await source.onEvent { sent.append($0) }
        await peer.onEvent { echoed.append($0) }

        try await source.addNote(rect: rect, contents: "hello")
        try await peer.applyEditEvent(sent.events[0])

        let onPeer = try await peerDocument.page(0).annotations().count
        XCTAssertEqual(echoed.events.count, 0, "applying must not echo")
        XCTAssertEqual(onPeer, 1)
    }

    func testAnEditForADifferentDocumentIsRefused() async throws {
        let (mine, _) = try await viewer()
        let event = PdfViewEvent(sequence: 1, sessionId: "them", origin: .remote,
                                 change: .edit(.annotationRemoved(page: 0, index: 0)),
                                 documentFingerprint: "not-mine")
        do {
            try await mine.applyEditEvent(event)
            XCTFail("expected a refusal")
        } catch let error as PdfError {
            guard case .documentMismatch = error else { return XCTFail("\(error)") }
        }
    }

    // MARK: - Presenter rule

    func testAFollowerCannotEditButMayStillLookAround() async throws {
        let (follower, _) = try await viewer(role: .follower)
        do {
            try await follower.addNote(rect: rect, contents: "nope")
            XCTFail("expected a refusal")
        } catch let error as PdfError {
            XCTAssertEqual(error, .readOnlyFollower)
        }
        // Following is not being frozen.
        await follower.zoomIn()
        let scale = await follower.state.zoom.scale
        XCTAssertGreaterThan(scale, 0)
    }

    func testAnEditFromSomeoneWhoIsNotThePresenterIsIgnored() async throws {
        let (follower, document) = try await viewer(role: .follower, presenterId: "boss")
        let fingerprint = await document.fingerprint

        try await follower.applyEditEvent(PdfViewEvent(
            sequence: 1, sessionId: "someone-else", origin: .remote,
            change: .edit(.noteAdded(page: 0, rect: rect, contents: "sneaky", color: .yellow)),
            documentFingerprint: fingerprint))
        let afterStray = try await document.page(0).annotations().count
        XCTAssertEqual(afterStray, 0, "nothing was added")

        try await follower.applyEditEvent(PdfViewEvent(
            sequence: 2, sessionId: "boss", origin: .remote,
            change: .edit(.noteAdded(page: 0, rect: rect, contents: "allowed", color: .yellow)),
            documentFingerprint: fingerprint))
        let afterPresenter = try await document.page(0).annotations().count
        XCTAssertEqual(afterPresenter, 1)
    }

    // MARK: - Codec

    func testEveryEditKindSurvivesARoundTrip() throws {
        let edits: [PdfEdit] = [
            .noteAdded(page: 0, rect: rect, contents: "n", color: .yellow),
            .inkAdded(page: 1, strokes: [[PdfPoint(x: 1, y: 2)], [PdfPoint(x: 3, y: 4), PdfPoint(x: 5, y: 6)]], color: .black, lineWidth: 3),
            .highlightAdded(page: 2, quads: [PdfQuad(p1: PdfPoint(x: 1, y: 2), p2: PdfPoint(x: 3, y: 2),
                                                     p3: PdfPoint(x: 1, y: 1), p4: PdfPoint(x: 3, y: 1))],
                            color: .yellow),
            .annotationRemoved(page: 3, index: 4),
            .fieldTextSet(page: 0, annotationIndex: 1, value: "typed"),
            .fieldCheckedSet(page: 0, annotationIndex: 2, checked: true),
            .fieldOptionSet(page: 0, annotationIndex: 3, option: 4, selected: true),
            .redacted(targets: [.region(rect, pageIndex: 0), .textMatches("secret")]),
        ]
        for edit in edits {
            let event = PdfViewEvent(sequence: 1, sessionId: "a", origin: .local,
                                     change: .edit(edit), documentFingerprint: "abc-123")
            XCTAssertEqual(try PdfViewCodec.decode(try PdfViewCodec.encode(event)), event,
                           "\(edit) did not survive")
        }
    }
}

private final class EditBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [PdfViewEvent] = []
    func append(_ event: PdfViewEvent) { lock.lock(); storage.append(event); lock.unlock() }
    var events: [PdfViewEvent] { lock.lock(); defer { lock.unlock() }; return storage }
}
