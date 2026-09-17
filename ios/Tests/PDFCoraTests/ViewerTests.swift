import XCTest
@testable import PDFCora

/// Mirrors `web/test/{zoom,scroll-roundtrip,view-state,viewer,view-codec}.test.ts`.
///
/// If a test here needs different assertions than its TypeScript twin, the two
/// implementations have diverged and one of them is wrong.
final class ViewerTests: LicensedTestCase {

    private let letter = PdfSize(width: 612, height: 792)
    // The corpus pages are 200x200 — smaller than any plausible viewport — so viewports
    // must be small and zoom high enough that the content actually overflows. Otherwise
    // the page fits entirely, nothing scrolls, and every scroll assertion is vacuous.
    private let phone = CGSize(width: 390, height: 700)
    private let wide = CGSize(width: 600, height: 500)
    private let scrollable = PdfZoom(scale: 4, mode: .free)

    private func document() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(
            contentsOf: Repo.corpus.appendingPathComponent("hello_world.pdf")))
    }

    // MARK: - Zoom

    func testFitWidthDerivesTheScaleThatFillsTheWidth() {
        let zoom = PdfZoom.fitting(width: 390, page: letter)
        XCTAssertEqual(zoom.mode, .fitWidth)
        XCTAssertEqual(zoom.scale, 390.0 / 612.0, accuracy: 1e-9)
    }

    func testTheTwoPercentageHelpersAnswerDifferentQuestions() {
        let phoneFit = PdfZoom.fitting(width: 390, page: letter)
        XCTAssertEqual(phoneFit.percentage, 64)
        XCTAssertEqual(phoneFit.percentage(ofFit: phoneFit.scale), 100)

        let wideFit = PdfZoom.fitting(width: 1200, page: letter)
        XCTAssertEqual(wideFit.percentage, 196)
        XCTAssertEqual(wideFit.percentage(ofFit: wideFit.scale), 100)
    }

    func testADegeneratePageCannotProduceAnInfiniteScale() {
        XCTAssertEqual(PdfZoom.fitting(width: 390, page: PdfSize(width: 0, height: 792)).scale, 1)
    }

    func testSteppingMovesThroughTheLadderAndClamps() {
        XCTAssertEqual(PdfZoom(scale: 1, mode: .free).stepped(1).scale, 1.25)
        XCTAssertEqual(PdfZoom(scale: 1, mode: .free).stepped(-1).scale, 0.75)
        XCTAssertEqual(PdfZoom(scale: 4, mode: .free).stepped(1).scale, 4)
        XCTAssertEqual(PdfZoom(scale: 0.25, mode: .free).stepped(-1).scale, 0.25)
        // A fit scale is almost never exactly on a rung.
        XCTAssertEqual(PdfZoom(scale: 0.64, mode: .fitWidth).stepped(1).scale, 0.75)
        XCTAssertEqual(PdfZoom.fitting(width: 390, page: letter).stepped(1).mode, .free)
    }

    // MARK: - Scroll

    func testOffsetToCentreToOffsetLandsWhereItStarted() {
        for page in [letter, PdfSize(width: 200, height: 1000)] {
            for scale in [0.25, 0.64, 1, 1.96, 4] as [Double] {
                for viewport in [phone, CGSize(width: 1200, height: 800)] {
                    let t = PdfViewTransform(page: page, scale: scale)
                    let content = t.viewSize
                    let maxX = max(0, content.width - viewport.width)
                    let maxY = max(0, content.height - viewport.height)

                    for offset in [CGPoint.zero, CGPoint(x: maxX, y: maxY),
                                   CGPoint(x: maxX / 2, y: maxY / 2)] {
                        let centre = t.center(forScrollOffset: offset, in: viewport)
                        let back = t.scrollOffset(centering: centre, in: viewport)
                        XCTAssertEqual(back.x, offset.x, accuracy: 0.5)
                        XCTAssertEqual(back.y, offset.y, accuracy: 0.5)
                    }
                }
            }
        }
    }

    func testAKnownOffsetMapsToAHandComputedCentreAndBack() {
        // Round trips alone cannot catch a symmetric error: both directions sharing the
        // same mistake still invert each other. Mutation-testing the web suite proved it.
        //
        //   page 612x792 at scale 1, viewport 400x600, offset (100, 50)
        //   view centre = (300, 350); toPdf = (300, 792 - 350) = (300, 442)
        let t = PdfViewTransform(page: letter, scale: 1)
        let viewport = CGSize(width: 400, height: 600)

        let centre = t.center(forScrollOffset: CGPoint(x: 100, y: 50), in: viewport)
        XCTAssertEqual(centre.x, 300, accuracy: 1e-9)
        XCTAssertEqual(centre.y, 442, accuracy: 1e-9)

        let offset = t.scrollOffset(centering: PdfPoint(x: 300, y: 442), in: viewport)
        XCTAssertEqual(offset.x, 100, accuracy: 1e-9)
        XCTAssertEqual(offset.y, 50, accuracy: 1e-9)
    }

    func testAPageThatFitsEntirelyIsCentred() {
        // Not a defect: with nothing to scroll, the middle of the window is the middle
        // of the page. A peer showing the whole page cannot reproduce an off-centre view.
        let t = PdfViewTransform(page: letter, scale: 1.96)
        let viewport = CGSize(width: 1200, height: 2000)
        let offset = t.scrollOffset(centering: PdfPoint(x: 100, y: 400), in: viewport)
        XCTAssertEqual(offset.x, 0)

        let centre = t.center(forScrollOffset: offset, in: viewport)
        XCTAssertEqual(centre.x, letter.width / 2, accuracy: 1)
    }

    // MARK: - Current page

    func testTheCurrentPageIsTheOneContainingTheCentre() {
        let heights = Array(repeating: 100.0, count: 50)
        XCTAssertEqual(pdfCurrentPage(heights: heights, centerY: 2250, gap: 10), 20)
        XCTAssertEqual(pdfCurrentPage(heights: heights, centerY: 2250, gap: 0), 22)
        XCTAssertEqual(pdfCurrentPage(heights: heights, centerY: 99999, gap: 0), 49)
        XCTAssertEqual(pdfCurrentPage(heights: [], centerY: 50, gap: 0), 0)
    }

    // MARK: - The viewer

    /// Found by the basic sample: the page was rendered one pixel per point and shown on a
    /// 3x screen, so its text was visibly soft.
    func testRenderingAtAScreenScaleGivesPixelsForTheSameDisplayedSize() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        let one = try await viewer.render()
        let three = try await viewer.render(scale: 3)
        XCTAssertEqual(one.size.width, 390, accuracy: 1)
        XCTAssertEqual(three.size.width, one.size.width, accuracy: 0.5, "displayed size stays in points")
        XCTAssertEqual(try XCTUnwrap(three.cgImage).width, 1170)
    }

    func testAScaleBeyondTheBitmapCapKeepsTheDisplayedSize() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        await viewer.zoom(to: scrollable)
        let image = try await viewer.render(scale: 6)
        XCTAssertEqual(try XCTUnwrap(image.cgImage).width, 4000, "800pt at 6x is capped")
        XCTAssertEqual(image.size.width, 800, accuracy: 0.5)
    }

    func testEveryChangeEmitsExactlyOneEvent() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        let box = EventBox()
        await viewer.onEvent { event in box.append(event) }

        await viewer.zoomIn()
        await viewer.flush()

        XCTAssertEqual(box.events.count, 1)
        XCTAssertEqual(box.events.first?.origin, .local)
    }

    func testApplyingARemoteEventEmitsNothing() async throws {
        // Without this, two synced viewers echo each other forever.
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        let box = EventBox()
        await viewer.onEvent { event in box.append(event) }

        let incoming = PdfViewState(pageIndex: 0, center: PdfPoint(x: 100, y: 100),
                                    zoom: PdfZoom(scale: 2, mode: .free),
                                    rotation: .none, layout: .single)
        await viewer.apply(PdfViewEvent(sequence: 1, sessionId: "them",
                                        origin: .remote, change: .viewport(incoming)))
        await viewer.flush()

        XCTAssertEqual(box.events.count, 0)
        let scale = await viewer.state.zoom.scale
        XCTAssertEqual(scale, 2)
    }

    func testAnOutOfOrderEventDoesNotRewindTheView() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        func remote(_ sequence: Int, _ scale: Double) -> PdfViewEvent {
            PdfViewEvent(sequence: sequence, sessionId: "them", origin: .remote,
                         change: .viewport(PdfViewState(
                            pageIndex: 0, center: PdfPoint(x: 100, y: 100),
                            zoom: PdfZoom(scale: scale, mode: .free),
                            rotation: .none, layout: .single)))
        }
        await viewer.apply(remote(5, 2))
        await viewer.apply(remote(3, 4))
        let scale = await viewer.state.zoom.scale
        XCTAssertEqual(scale, 2, "sequence 3 arrived late and must be ignored")
    }

    func testAPeerOnAnotherScreenLandsOnTheSameContent() async throws {
        let doc = try await document()
        let a = try await PdfViewer(document: doc, viewport: phone, options: .init(coalesceInterval: 0))
        let b = try await PdfViewer(document: doc, viewport: wide, options: .init(coalesceInterval: 0))

        await a.zoom(to: scrollable)
        await a.scroll(to: PdfPoint(x: 120, y: 90))
        let state = await a.state
        await b.apply(PdfViewEvent(sequence: 1, sessionId: "a", origin: .remote,
                                   change: .viewport(state)))

        let centre = await b.transform().center(forScrollOffset: b.scrollOffset(), in: wide)
        XCTAssertEqual(centre.x, 120, accuracy: 1)
        XCTAssertEqual(centre.y, 90, accuracy: 1)
    }

    func testAFitIsReDerivedByTheReceiverButAFreeZoomIsNot() async throws {
        let doc = try await document()
        let narrow = try await PdfViewer(document: doc, viewport: CGSize(width: 300, height: 700),
                                         options: .init(coalesceInterval: 0))
        let broad = try await PdfViewer(document: doc, viewport: CGSize(width: 900, height: 700),
                                        options: .init(coalesceInterval: 0))

        await narrow.fitWidth()
        let fitState = await narrow.state
        await broad.apply(PdfViewEvent(sequence: 1, sessionId: "n", origin: .remote,
                                       change: .viewport(fitState)))
        let broadZoom = await broad.state.zoom
        XCTAssertEqual(broadZoom.mode, .fitWidth)
        XCTAssertGreaterThan(broadZoom.scale, fitState.zoom.scale)

        await broad.apply(PdfViewEvent(sequence: 2, sessionId: "n", origin: .remote,
                                       change: .viewport(PdfViewState(
                                          pageIndex: 0, center: PdfPoint(x: 100, y: 100),
                                          zoom: PdfZoom(scale: 2.4, mode: .free),
                                          rotation: .none, layout: .single))))
        let adopted = await broad.state.zoom.scale
        XCTAssertEqual(adopted, 2.4, "a deliberate zoom is adopted verbatim")
    }

    func testResizingReDerivesAFitButLeavesADeliberateZoomAlone() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        await viewer.fitWidth()
        let fitted = await viewer.state.zoom.scale
        await viewer.setViewport(CGSize(width: 780, height: 700))
        let widened = await viewer.state.zoom.scale
        XCTAssertGreaterThan(widened, fitted)

        await viewer.zoom(to: PdfZoom(scale: 1.5, mode: .free))
        await viewer.setViewport(phone)
        let survived = await viewer.state.zoom.scale
        XCTAssertEqual(survived, 1.5, "a deliberate zoom survives a resize")
    }

    func testScrollingPastThePageClampsRatherThanRunningAway() async throws {
        let viewer = try await PdfViewer(document: try await document(), viewport: phone,
                                         options: .init(coalesceInterval: 0))
        await viewer.zoom(to: scrollable)
        for _ in 0..<50 { await viewer.scrollBy(CGSize(width: 500, height: 500)) }

        let offset = await viewer.scrollOffset()
        let content = await viewer.transform().viewSize
        XCTAssertGreaterThan(content.width, phone.width)
        XCTAssertLessThanOrEqual(offset.x, content.width - phone.width + 0.5)
        XCTAssertLessThanOrEqual(offset.y, content.height - phone.height + 0.5)
    }

    // MARK: - Codec

    func testAnUnknownVersionIsRefusedRatherThanMisread() {
        let wire = Data(#"{"v":999,"sequence":1}"#.utf8)
        XCTAssertThrowsError(try PdfViewCodec.decode(wire))
    }

    func testRotationTravelsAsDegreesNotAsAQuarterTurnIndex() throws {
        // iOS holds rotation as PDFium's index 0...3; the wire carries degrees. A
        // platform writing the index would send 1 where a peer expects 90.
        XCTAssertEqual(PdfViewCodec.degrees(.degrees90), 90)
        XCTAssertEqual(PdfViewCodec.rotation(fromDegrees: 90), .degrees90)
        XCTAssertEqual(PdfViewCodec.rotation(fromDegrees: 270), .degrees270)

        let event = PdfViewEvent(sequence: 1, sessionId: "a", origin: .local,
                                 change: .viewport(PdfViewState(
                                    pageIndex: 0, center: PdfPoint(x: 1, y: 2),
                                    zoom: PdfZoom(scale: 1, mode: .free),
                                    rotation: .degrees90, layout: .continuous)))
        let json = try XCTUnwrap(JSONSerialization.jsonObject(
            with: try PdfViewCodec.encode(event)) as? [String: Any])
        let change = try XCTUnwrap(json["change"] as? [String: Any])
        let state = try XCTUnwrap(change["state"] as? [String: Any])
        XCTAssertEqual(state["rotation"] as? Int, 90, "degrees on the wire, not the index")
    }

    func testAnEventSurvivesARoundTrip() throws {
        let event = PdfViewEvent(sequence: 7, sessionId: "abc", origin: .local,
                                 change: .viewport(PdfViewState(
                                    pageIndex: 3, center: PdfPoint(x: 306, y: 400),
                                    zoom: PdfZoom(scale: 1.5, mode: .free),
                                    rotation: .degrees180, layout: .continuous)))
        XCTAssertEqual(try PdfViewCodec.decode(try PdfViewCodec.encode(event)), event)
    }

    func testASelectionSurvivesARoundTrip() throws {
        for selection in [PdfSelection.region(page: 1, rect: PdfRect(left: 1, bottom: 2, right: 3, top: 4)),
                          PdfSelection.annotation(page: 2, index: 5)] {
            let event = PdfViewEvent(sequence: 1, sessionId: "a", origin: .local,
                                     change: .selection(selection))
            XCTAssertEqual(try PdfViewCodec.decode(try PdfViewCodec.encode(event)), event)
        }
    }
}

/// Collects events across concurrency domains without an actor hop in the assertions.
private final class EventBox: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [PdfViewEvent] = []

    func append(_ event: PdfViewEvent) {
        lock.lock(); defer { lock.unlock() }
        storage.append(event)
    }

    var events: [PdfViewEvent] {
        lock.lock(); defer { lock.unlock() }
        return storage
    }
}

/// The cross-platform contract: `conformance/view-state.json` is decoded here and its
/// expected scroll offsets derived, exactly as the web and Android suites do.
///
/// The fixture's expected values were computed by independent arithmetic rather than by
/// running any of the three SDKs, so agreement is evidence rather than three copies of
/// one mistake.
final class ViewStateConformanceTests: LicensedTestCase {

    /// The edit half of the contract: the same file the web and Android suites read.
    func testEveryFixtureEditCaseDecodesToTheExpectedArguments() throws {
        let url = Repo.root.appendingPathComponent("conformance/view-state.json")
        let fixture = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(fixture["editCases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 5)

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let wire = try XCTUnwrap(testCase["wire"] as? [String: Any])
            let event = try PdfViewCodec.decode(try JSONSerialization.data(withJSONObject: wire))
            guard case .edit(let edit) = event.change else { return XCTFail("\(name): not an edit") }

            XCTAssertEqual(event.documentFingerprint, wire["documentFingerprint"] as? String,
                           "\(name): the fingerprint must survive decoding")

            let expect = try XCTUnwrap(testCase["expect"] as? [String: Any])
            switch (expect["kind"] as? String, edit) {
            case ("noteAdded", .noteAdded(let page, let rect, let contents, _)):
                XCTAssertEqual(page, expect["page"] as? Int, name)
                XCTAssertEqual(contents, expect["contents"] as? String, name)
                let expectedRect = try XCTUnwrap(expect["rect"] as? [String: Any])
                XCTAssertEqual(rect.left, expectedRect["left"] as? Double, name)
                XCTAssertEqual(rect.top, expectedRect["top"] as? Double, name)
            case ("inkAdded", .inkAdded(let page, let strokes, _, let lineWidth)):
                XCTAssertEqual(page, expect["page"] as? Int, name)
                XCTAssertEqual(strokes.map(\.count), expect["strokePointCounts"] as? [Int], name)
                XCTAssertEqual(lineWidth, expect["lineWidth"] as? Double, name)
            case ("annotationRemoved", .annotationRemoved(let page, let index)):
                XCTAssertEqual(page, expect["page"] as? Int, name)
                XCTAssertEqual(index, expect["index"] as? Int, name)
            case ("fieldTextSet", .fieldTextSet(let page, let annotationIndex, let value)):
                XCTAssertEqual(page, expect["page"] as? Int, name)
                XCTAssertEqual(annotationIndex, expect["annotationIndex"] as? Int, name)
                XCTAssertEqual(value, expect["value"] as? String, name)
            case ("redacted", .redacted(let targets)):
                XCTAssertEqual(targets.count, expect["targetCount"] as? Int, name)
                guard case .region = targets.first else { return XCTFail("\(name): first target") }
                guard case .textMatches(let query, _) = targets[1] else {
                    return XCTFail("\(name): second target")
                }
                XCTAssertEqual(query, expect["secondQuery"] as? String, name)
            default:
                XCTFail("\(name): decoded \(edit) does not match expected kind")
            }
        }
    }

    func testEveryFixtureCaseDerivesTheOffsetsItClaims() throws {
        let url = Repo.root.appendingPathComponent("conformance/view-state.json")
        let fixture = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: try Data(contentsOf: url)) as? [String: Any])
        let cases = try XCTUnwrap(fixture["cases"] as? [[String: Any]])
        XCTAssertGreaterThanOrEqual(cases.count, 5)

        for testCase in cases {
            let name = testCase["name"] as? String ?? "?"
            let pageRaw = try XCTUnwrap(testCase["page"] as? [String: Any])
            let page = PdfSize(width: try XCTUnwrap(pageRaw["width"] as? Double),
                               height: try XCTUnwrap(pageRaw["height"] as? Double))

            let wire = try JSONSerialization.data(withJSONObject: try XCTUnwrap(testCase["wire"]))
            let event = try PdfViewCodec.decode(wire)
            guard case .viewport(let state) = event.change else {
                return XCTFail("\(name): not a viewport event")
            }

            if let expected = testCase["expectRotationDegrees"] as? Int {
                XCTAssertEqual(PdfViewCodec.degrees(state.rotation), expected,
                               "\(name): rotation must cross the wire as degrees")
            }

            for receiver in try XCTUnwrap(testCase["receivers"] as? [[String: Any]]) {
                let v = try XCTUnwrap(receiver["viewport"] as? [String: Any])
                let viewport = CGSize(width: try XCTUnwrap(v["width"] as? Double),
                                      height: try XCTUnwrap(v["height"] as? Double))

                // A fit is re-derived for this receiver's window; a free zoom is adopted.
                let zoom: PdfZoom
                switch state.zoom.mode {
                case .free: zoom = state.zoom
                case .fitWidth: zoom = PdfZoom.fitting(width: viewport.width, page: page)
                case .fitPage: zoom = PdfZoom.fitting(size: viewport, page: page)
                }

                let expectedScale = try XCTUnwrap(receiver["expectScale"] as? Double)
                // Single precision: Android holds scale as Float.
                XCTAssertEqual(zoom.scale, expectedScale, accuracy: 1e-4, "\(name): scale")

                let offset = PdfViewTransform(page: page, scale: zoom.scale)
                    .scrollOffset(centering: state.center, in: viewport)
                let expected = try XCTUnwrap(receiver["expectScrollOffset"] as? [String: Any])
                XCTAssertEqual(Double(offset.x), try XCTUnwrap(expected["x"] as? Double),
                               accuracy: 0.5, "\(name) @\(Int(viewport.width)): x")
                XCTAssertEqual(Double(offset.y), try XCTUnwrap(expected["y"] as? Double),
                               accuracy: 0.5, "\(name) @\(Int(viewport.width)): y")
            }
        }
    }
}
