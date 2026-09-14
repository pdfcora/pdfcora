# PdfiumKit — Viewer and Cross-Platform Sync Design

Date: 2026-09-14
Status: Draft 0.2, pending review
Extends: `2026-09-12-pdfiumkit-sdk-design.md`

## 1. Purpose

A `PdfViewer` that owns view state and editing operations, emits an event for everything
that changes it, and can apply a peer's events — so two viewers on different platforms
stay in step.

Success criteria:

- A scroll position taken from a viewer on one platform, applied to a viewer on another
  with a different screen size, shows the same content in the middle of the window.
- Every operation that changes the viewer emits exactly one event; applying a received
  event emits none.
- The three demo editors get **much shorter** by adopting it. They are 475, 481 and
  ~200 lines today; if they do not collapse to a fraction of that, the component is not
  pulling its weight.

## 2. What exists today

There is no viewer in the SDK. What there is:

- `PdfViewTransform` — a value type holding page size and scale, converting PDF ↔ view
  coordinates. It has no viewport, no scroll offset and no state.
- Three separate editors in demo code (`EditorScreen.swift`, `EditorScreen.kt`,
  `renderEditor()`), each holding scroll, zoom and tool state in its own UI idiom, each
  with its own copy of the zoom ladder.

So there is nothing to take values *from*, and nothing to apply them *to*. That is the
gap this fills.

## 3. Non-goals

- **No UI *in the core*.** The headless `PdfViewer` ships no view type. A separate UI
  layer (§10) sits on top of it and does ship view types — the two are layered, not
  alternatives, and an app can use either.
- **No networking.** The viewer emits serialisable events; moving them is the app's
  business, as with `CmsSigner` and the AI provider.
- **No concurrent editing.** See §8: v1 is presenter-only.
- **No text reflow, no continuous multi-page rendering engine.** Layout mode is recorded
  in the state so peers agree, but each app lays out its own pages.

## 4. The model

### 4.1 Zoom

```swift
public struct PdfZoom: Equatable, Sendable {
    public enum Mode: Equatable, Sendable { case fitWidth, fitPage, free }

    /// View points per PDF point. 1.0 is 100%.
    public let scale: Double
    /// How this zoom was arrived at, which is what a peer reproduces.
    public let mode: Mode

    public static let steps: [Double] = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

    /// 1:1 based — 100% is one PDF point per view point, as Acrobat and Preview mean it.
    public var percentage: Int { Int((scale * 100).rounded()) }
    /// Fit based — 100% is whatever fills the window, as most mobile viewers mean it.
    public func percentage(ofFit fitScale: Double) -> Int

    public static func fitting(width: Double, page: PdfSize) -> PdfZoom
    public static func fitting(size: CGSize, page: PdfSize) -> PdfZoom
}
```

**What "100%" means is the app's choice, not the SDK's**, so both helpers exist. The
percentage is a label printed in a toolbar; nothing in rendering or sync reads it — those
use `scale` and `mode`. On US Letter (612 × 792) the two conventions diverge sharply:
fit-to-width reads 64% on a ~390pt phone and 196% on a ~1200px desktop under 1:1, and
100% on both under fit-based.

1:1 makes the number mean physical size but shows "64%" for a phone's normal view;
fit-based always reads a clean 100% but makes "200%" a different magnification on every
device. **The demos will use the fit-based helper**, since a viewer's default view reading
100% is what users expect.

Three consumers need three different things from zoom, which is why it is a type rather
than a `Double`:

| Consumer | Needs | Why not the others |
| --- | --- | --- |
| Rendering | `scale` | The page is rasterised at an absolute size |
| Sync | `mode` | A peer on a phone receiving `.fitWidth` fits *their* width; receiving `.free` adopts the number literally. Without the mode you cannot tell "zoomed to 240%" from "has a wide window" |
| UI | `percentage` | Derived, never stored — a stored percentage goes stale the moment the window resizes |

### 4.2 View state

```swift
public struct PdfViewState: Equatable, Sendable, Codable {
    public let pageIndex: Int
    /// In PDF coordinates on `pageIndex`. The point at the centre of the viewport.
    public let center: PdfPoint
    public let zoom: PdfZoom
    public let rotation: PdfPageRotation
    public let layout: PdfPageLayout      // .single | .continuous
}
```

`PdfPageLayout` and `PdfTool` are **new types this design introduces**; everything else
above already exists in the SDK. `PdfTool` is the tool enum currently duplicated in all
three demos (`select, ink, note, highlight, redact`), moved into the SDK so peers can
agree on it.

**Centre, not top-left, and document space, not view space.** A scroll offset is in the
sending viewer's pixels, relative to its own content size, and means nothing elsewhere.
The centre point is screen-independent, stays put when zoom changes (zooming about the
centre keeps the same content in view; top-left drifts), and degrades sanely across
aspect ratios — a tall phone and a wide desktop cannot show the same rectangle, but they
can agree on what is in the middle.

In `.continuous` layout the viewport can straddle two pages. **The current page is
defined as the one containing the centre point**, so the definition never depends on how
much of a neighbour happens to be visible.

### 4.3 Selection

```swift
public enum PdfSelection: Equatable, Sendable, Codable {
    /// A dragged rectangle, in PDF coordinates on that page.
    case region(page: Int, rect: PdfRect)
    case annotation(page: Int, index: Int)
}
```

**Areas, not text.** A selection is a rectangle the user dragged — the same gesture the
highlight and redact tools already use — and it syncs as one, which is what makes "the
presenter is pointing at this" work.

Text selection is deliberately *not* here. It would need a character-range model the SDK
does not have, and a region is what a viewer's user actually drags. Should text selection
be wanted later it is additive: another case, no change to anything above.

### 4.4 Events

```swift
public struct PdfViewEvent: Equatable, Sendable, Codable {
    public enum Origin: Sendable, Codable { case local, remote }

    public let sequence: UInt64
    public let sessionId: String
    public let origin: Origin
    public let change: Change

    public enum Change: Equatable, Sendable, Codable {
        case viewport(PdfViewState)
        case selection(PdfSelection?)
        case tool(PdfTool)
        case edit(PdfEdit)
    }
}
```

Each of the three envelope fields exists for a specific failure:

- **`origin`** — applying a received event must not re-emit it. Without this two synced
  viewers loop forever, each echoing the other.
- **`sequence`** — out-of-order delivery would otherwise rewind a follower's view. A
  peer ignores any event whose sequence is below the highest it has seen from that
  session.
- **`sessionId`** — needed the moment there are more than two participants, and to
  discard one's own events reflected back by a broadcast transport.

### 4.5 Edit events must carry their arguments

```swift
public enum PdfEdit: Equatable, Sendable, Codable {
    case noteAdded(page: Int, rect: PdfRect, contents: String)
    case inkAdded(page: Int, strokes: [[PdfPoint]], color: PdfColor)
    case highlightAdded(page: Int, quads: [PdfQuad], color: PdfColor)
    case annotationRemoved(page: Int, index: Int)
    case fieldTextSet(page: Int, annotationIndex: Int, value: String)
    case fieldCheckedSet(page: Int, annotationIndex: Int, checked: Bool)
    case fieldOptionSet(page: Int, annotationIndex: Int, option: Int, selected: Bool)
    case redacted(targets: [PdfRedactionTarget])
}
```

An event saying only "annotation 3 was added" cannot be reproduced by a peer — it does
not say what to add. So each edit carries the same arguments the API call took, and
`apply` replays the call.

**Precondition, stated because violating it corrupts silently:** both peers must have
opened the *same bytes*. Annotation and field indices are positions in a specific
document; replaying `annotationRemoved(index: 3)` against a different document removes
the wrong thing. The viewer exposes a `documentFingerprint` (a hash of the opened bytes)
and `apply` refuses events whose fingerprint does not match.

## 5. The viewer

```swift
public actor PdfViewer {
    public init(document: PdfDocument, viewport: CGSize, sessionId: String = UUID().uuidString)

    public private(set) var state: PdfViewState
    public private(set) var selection: PdfSelection?
    public private(set) var tool: PdfTool
    public nonisolated var events: AsyncStream<PdfViewEvent> { get }

    public func setViewport(_ size: CGSize)          // resize; re-derives fit zooms

    // Navigation
    public func scroll(to center: PdfPoint, page: Int)
    public func scrollBy(_ delta: CGSize)            // in view points, from a gesture
    public func goToPage(_ index: Int)
    public func zoom(to zoom: PdfZoom)
    public func zoomIn(); public func zoomOut()      // steps through PdfZoom.steps
    public func fitWidth(); public func fitPage()
    public func setRotation(_ rotation: PdfPageRotation)
    public func setLayout(_ layout: PdfPageLayout)

    // What to draw. Returns the platform's own image type, as PdfPage.render already
    // does — UIImage on Apple, Bitmap on Android, ImageData on the web. There is no
    // cross-platform image type and this does not introduce one.
    public func render(options: PdfRenderOptions = .default,
                       background: PdfColor = .white) async throws -> UIImage
    public func transform() -> PdfViewTransform      // for the app's own hit-testing
    public func scrollOffset() -> CGPoint            // where the app should scroll to

    // Selection and tools
    public func selectRegion(page: Int, rect: PdfRect)
    public func selectAnnotation(page: Int, index: Int)
    public func clearSelection()
    public func setTool(_ tool: PdfTool)

    // Editing — delegates to PdfDocument/PdfPage, never reimplements
    public func addNote(rect: PdfRect, contents: String) async throws
    public func addInk(_ strokes: [[PdfPoint]], color: PdfColor) async throws
    public func addHighlight(_ quads: [PdfQuad], color: PdfColor) async throws
    public func removeAnnotation(at index: Int) async throws
    public func setFieldText(_ value: String, at annotationIndex: Int) async throws
    public func setFieldChecked(_ checked: Bool, at annotationIndex: Int) async throws
    public func setFieldOption(_ option: Int, selected: Bool, at annotationIndex: Int) async throws
    public func redact(_ targets: [PdfRedactionTarget]) async throws -> PdfRedactionReport

    // Sync
    public var documentFingerprint: String { get }
    public func apply(_ event: PdfViewEvent) async throws
}
```

**The viewer delegates; it does not reimplement.** `addInk` calls `PdfPage.addInk` and
then emits. Two code paths producing annotations would drift, and the bug would only
appear through one of them — §9 gates this with a test asserting both routes produce
identical saved bytes.

### 5.1 Scroll, both directions

The two functions that make "take values from one viewer, apply to another" work are
additions to `PdfViewTransform`, which today has no viewport concept:

```swift
extension PdfViewTransform {
    public func center(forScrollOffset offset: CGPoint, in viewport: CGSize) -> PdfPoint
    public func scrollOffset(centering center: PdfPoint, in viewport: CGSize) -> CGPoint
}
```

Exact inverses, and tested as such (§9). `scrollOffset` clamps to the scrollable range,
so a centre near a page edge does not produce an offset outside the content on a
differently shaped screen — the peer lands as close as its window allows rather than
somewhere invalid.

## 6. Coalescing

**Viewport events coalesce; edit events must not.** A drag emits viewport changes at
gesture rate, and only the latest matters — flooding a transport with sixty per second is
pointless. But an annotation added is not superseded by the next one; dropping it loses
data.

The viewer therefore emits viewport changes through a throttle (default 50 ms, the
interval configurable, coalescing to the most recent) and edits immediately and in order.
These are separate paths because they need opposite behaviour.

## 7. Encoding

One JSON encoding, identical on all three platforms, versioned with a `v` field so an
older peer can refuse rather than misread. Field names are the Swift property names, so
there is a single naming convention to keep aligned.

## 8. Concurrent edits — presenter only in v1

One participant is the presenter and may edit; followers view. `apply` accepts edit
events only from the session the app has designated presenter, and a follower's own edit
calls throw `PdfError.readOnlyFollower`.

Two people editing the same annotation is a distributed-systems problem, not a detail:
last-writer-wins silently discards work, and doing it properly means a CRDT over the
annotation set. Out of scope, and named here so it is a decision rather than an
oversight. Co-editing would be its own spec.

## 9. Testing

| Claim | Gate |
| --- | --- |
| Scroll survives a round trip | Property test: offset → centre → offset, same viewport, lands on the same pixel within half a point, over a sweep of page sizes, zooms and viewports |
| Scroll survives a *platform* round trip | Encode state on one platform's fixtures, decode on the others, assert identical derived scroll offsets — the conformance contract, as for redaction and signatures |
| Applying a remote event does not echo | Apply an event, assert zero events emitted |
| Out-of-order events do not rewind | Apply sequence 5 then 3; assert the state is still 5's |
| The viewer and the document agree | The same edit through `PdfViewer` and through `PdfPage` produces byte-identical saved documents |
| A mismatched document is refused | Apply an event carrying another document's fingerprint; assert it throws rather than corrupting |
| Viewport events coalesce, edits do not | Emit 100 scrolls and 3 annotations in a burst; assert ≤ a few viewport events and exactly 3 edit events |
| The abstraction earns its place | The three demo editors are shorter after adopting it |

## 10. The UI layer

A real, drop-in viewer per platform, built **on** the headless viewer rather than
instead of it:

```
PdfViewerView (SwiftUI) · PdfViewer@Composable · <pdf-viewer>   ← owns scroll, gestures, toolbar
        drives
PdfViewer (headless, §5)                                        ← state, events, sync
        delegates to
PdfDocument / PdfPage                                           ← unchanged
```

The headless layer stays public: sync (§4.4, §8) lives there, two UI viewers sync by
their cores exchanging events, and an app wanting full control can skip the UI entirely.

### 10.1 Toolbar

```swift
public struct PdfToolbarItem: Sendable {
    // Built-in, and identical on all three platforms.
    public static func tool(_ tool: PdfTool) -> PdfToolbarItem
    public static let undo: PdfToolbarItem
    public static let deleteSelection: PdfToolbarItem
    public static let zoomOut: PdfToolbarItem
    public static let zoomIn: PdfToolbarItem
    public static let fitWidth: PdfToolbarItem
    public static let pageBack: PdfToolbarItem
    public static let pageForward: PdfToolbarItem
    public static let save: PdfToolbarItem
    public static let spacer: PdfToolbarItem
    public static let divider: PdfToolbarItem

    /// App-defined. Content is **platform-native on purpose** — see below.
    public static func custom(id: String, label: String,
                              systemImage: String,
                              action: @Sendable @escaping () -> Void) -> PdfToolbarItem
}

public struct PdfToolbarConfiguration: Sendable {
    public var items: [PdfToolbarItem]
    public static let `default`: PdfToolbarConfiguration
}
```

**Custom items are declared per platform, deliberately.** An icon is an SF Symbol name, a
vector drawable resource and an SVG on the three platforms. A cross-platform icon type
would be a lowest common denominator that satisfies none of them and leaks on first
contact, so built-ins stay portable and custom items are typed natively.

### 10.2 The toolbar must not silently clip

**Hard requirement, from a bug this project already shipped.** The demo editor's toolbar
was a single fixed-width row; adding a fifth tool pushed the zoom and save buttons off
the edge, and SwiftUI clipped them without a word. It surfaced as two unrelated-looking
UI test failures — "zoom in did not enlarge the page", and a form screen reporting zero
fields — because the buttons existed and the taps went nowhere.

A configurable toolbar makes this *more* likely, not less: apps will add items. So:

- The toolbar overflows into a scroll or an overflow menu. It never clips.
- Every item remains reachable at the narrowest supported width with the largest
  supported dynamic type.
- The UI tests assert **hittability**, not existence. An element that exists but cannot
  be tapped is the failure mode this is guarding against.

### 10.3 Appearance

```swift
public struct PdfViewerTheme: Sendable, Equatable {
    public var accent: PdfColor
    public var background: PdfColor
    public var pageBackground: PdfColor
    public var pageShadow: PdfColor
    public var toolbarBackground: PdfColor
    public var toolbarForeground: PdfColor
    public var selectionStroke: PdfColor
    public var redactionFill: PdfColor
    public var cornerRadius: Double
    public var iconSize: Double
    public var toolbarHeight: Double

    public static let light: PdfViewerTheme
    public static let dark: PdfViewerTheme
}
```

Tokens are the tested path and mean the same thing everywhere. Each platform also accepts
its own styling — a `ViewModifier`, a `Modifier`, CSS custom properties — and **the escape
hatch is explicitly outside the conformance contract**: once it is used, cross-platform
parity is the app's to maintain. Said plainly here so it is a known trade rather than a
surprise.

### 10.4 What the UI layer does not do

- No document picker, no thumbnail sidebar, no search bar. Those are app screens; the
  component is the page and its toolbar.
- No layout opinions beyond the page area and one toolbar — no split views, no panels.

## 11. Risks

| Risk | Mitigation |
| --- | --- |
| The viewer becomes a second, divergent API surface | It delegates to `PdfDocument`/`PdfPage`, gated by the byte-identity test |
| Aspect-ratio differences make "the same view" impossible | Explicitly only the centre point and zoom mode are synced; documented as a limit, not a bug |
| Edit replay corrupts a peer that opened different bytes | `documentFingerprint` checked on every applied event |
| An actor-per-viewer plus an actor-per-document deadlocks | The viewer never holds its own executor while awaiting the document's; verified by a concurrency test hammering both |
| The UI layer's toolbar clips items as apps add them | §10.2: overflow into a scroll or menu, and UI tests assert hittability rather than existence. This already happened once in the demos |
| The per-platform styling escape hatch quietly breaks parity | §10.3: it is outside the conformance contract and documented as the app's responsibility |
| Three UI implementations drift in behaviour | The component is thin — it drives the headless viewer and owns no state of its own, so behaviour lives in one tested place |
| The UI layer ages badly as platform conventions shift | It stays optional. The headless viewer is the stable contract; the component can be rewritten without touching it |

## 12. Resolved

1. **The percentage label is the app's choice** (§4.1). The SDK offers both helpers and
   depends on neither; the demos use the fit-based one. This was raised as a decision to
   be made and turned out not to be one — sync reads `scale` and `mode`, never the label.
2. **Selection is areas, not text** (§4.3): a dragged rectangle, the same gesture the
   highlight and redact tools use. Text selection would need a character-range model the
   SDK does not have, and is additive if wanted later.

## 13. Phasing

1. **State and transform.** `PdfZoom`, `PdfViewState`, the two `PdfViewTransform`
   functions, the round-trip property test. No viewer yet — this alone makes
   take-from-one/apply-to-another possible by hand.
2. **The viewer, viewing only.** Scroll, zoom, page, rotation, layout, render, events,
   coalescing.
3. **Selection, tools and editing.** Region and annotation selection, the delegating
   edit methods, and their events.
4. **Sync.** Encoding, `apply`, fingerprint, ordering, presenter rule, the cross-platform
   conformance contract.
5. **The UI layer.** One component per platform, the toolbar configuration and the
   theme, overflow handling, and hittability tests.
6. **Demos.** All three adopt the UI component; the diff should be sharply negative, and
   that is how the component justifies itself.
