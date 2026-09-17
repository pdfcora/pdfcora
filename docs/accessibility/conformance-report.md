# PDFCora — Accessibility Conformance Report (draft)

Date: 2026-09-16 · Product: PDFCora 0.1.0 viewer components (web `PdfViewerElement`, iOS
`PdfViewerView`, Android `PdfViewerView`) · Standards: WCAG 2.1 Level A and AA; EN 301 549 v3.2.1
chapters 9 (web), 11 (software) and 5 (generic).

> **This is a self-assessment, not an Accessibility Conformance Report anyone may rely on.**
> A11Y-4 requires a report based on an **independent audit**; none has been commissioned. Everything
> below is what the vendor's own automated and scripted testing shows on 2026-09-16, and several
> criteria are marked *Not evaluated* because nobody has tested them with a real screen reader,
> switch control or magnifier. Do not publish this as a VPAT®; use it as the input an auditor works
> from, and as the list of what to fix first.

## What was tested, and how

| Platform | Test | Where |
| --- | --- | --- |
| Web | axe-core 4.13, WCAG 2.1 A/AA + 2.2 AA rules, over the mounted component in three states (plain, reviewing, tagged document) | `web/test-browser/viewer-element.js`, run by `scripts/test-web-browser.sh` |
| Web | Keyboard: toolbar and review marks reachable and operable, visible focus ring, `+`/`-`/Page Up/Page Down on the page | same file |
| Web | Text scaling: root font size 32 px — controls grow, nothing clips, review buttons wrap | same file |
| iOS | `XCUIApplication.performAccessibilityAudit()` (contrast, element description, hit region, clipped text, traits) on three screens, each opened on its own | `ios/Demo/UITests/ScreenTourTests.swift` |
| iOS | Dynamic Type at `AccessibilityXXXL`: toolbar grows, review buttons stay on screen | same file |
| Android | Accessibility Test Framework checks (preset LATEST) over the platform's accessibility tree for the component, reviewing and showing a tagged document | `android/pdfcora-ui/src/androidTest/.../PdfViewerViewTest.kt` |
| All | The page's content is exposed as structure (headings, lists, figures with alternate text, tables, form fields) and asserted per platform | `web/test/accessible.test.ts`, `AccessibleContentTests.swift`, `AccessibleContentTest.kt`, and the UI tests |

Nobody has yet driven the components with VoiceOver, TalkBack, NVDA, JAWS or VoiceOver for macOS
by hand, and no user testing has been done. That is the gap the independent audit must close.

## Known limits of the automated passes

- axe-core checks roughly a third of WCAG's success criteria; it cannot judge reading order,
  meaningful labels or focus order beyond the mechanical.
- The Android checks run over the accessibility tree the platform hands a screen reader (taken
  from `UiAutomation`), not over the view tree: a Compose UI is a single view whose content is
  virtual nodes, and a view-tree pass sees only that host. The checks are proven to have teeth —
  removing a figure's fallback description makes them fail on exactly the two unlabelled images
  Compose 1.8's own checks found on 2026-09-15.
- Target size: review marks and the invisible elements that expose page text sit on lines of page
  text, at whatever size the page is drawn. WCAG 2.1 AA has no target-size criterion; WCAG 2.2's
  2.5.8 exempts targets constrained by the line height of the text. Zooming enlarges them. The
  audits' hit-region findings are suppressed for this reason and no other.

## WCAG 2.1 Level A

| Criterion | Web | iOS | Android | Remarks |
| --- | --- | --- | --- | --- |
| 1.1.1 Non-text content | Supports | Supports | Supports | Toolbar buttons have labels; the page bitmap is hidden from assistive technology and its content exposed as text; a figure without alternate text is announced as "Figure without a description" |
| 1.2.x Time-based media | Not applicable | Not applicable | Not applicable | No audio or video |
| 1.3.1 Info and relationships | Supports | Supports | Supports | A tagged PDF's headings, lists, tables and form labels are exposed; an untagged page is one block of text, which is what it is |
| 1.3.2 Meaningful sequence | Supports | Supports | Supports | Reading order follows the structure tree; `traversalIndex` and sort priority set it on Android and iOS |
| 1.3.3 Sensory characteristics | Supports | Supports | Supports | No instruction depends on shape or position |
| 1.4.1 Use of colour | Partially supports | Partially supports | Partially supports | Review marks differ by colour **and** outline style (solid, dashed, filled), but a colour-blind user may still find pending and accepted marks close; their state is in the accessible label |
| 1.4.2 Audio control | Not applicable | Not applicable | Not applicable | |
| 2.1.1 Keyboard | Supports | Not evaluated | Not evaluated | Web: every control and mark is a button, the page zooms and pages from the keyboard. iOS and Android: hardware-keyboard support is untested |
| 2.1.2 No keyboard trap | Supports | Not evaluated | Not evaluated | Web: focus moves through and out of the component |
| 2.1.4 Character key shortcuts | Supports | Not applicable | Not applicable | `+`, `-`, Page Up and Page Down act only while the page has focus |
| 2.2.x Enough time | Not applicable | Not applicable | Not applicable | Nothing times out |
| 2.3.1 Three flashes | Supports | Supports | Supports | Nothing flashes |
| 2.4.1 Bypass blocks | Not applicable | Not applicable | Not applicable | A component, not a page |
| 2.4.2 Page titled | Not applicable | Not applicable | Not applicable | The host app owns titles |
| 2.4.3 Focus order | Supports | Not evaluated | Not evaluated | Web: DOM order is toolbar, page, review bar |
| 2.4.4 Link purpose | Not applicable | Not applicable | Not applicable | Links inside the PDF are not yet exposed as targets |
| 2.5.1 Pointer gestures | Supports | Supports | Supports | Every gesture has a single-pointer path; pinch zoom has toolbar equivalents |
| 2.5.2 Pointer cancellation | Supports | Supports | Supports | Actions fire on release |
| 2.5.3 Label in name | Supports | Supports | Supports | Visible labels match accessible names |
| 2.5.4 Motion actuation | Not applicable | Not applicable | Not applicable | |
| 3.1.1 Language of page | Not applicable | Not applicable | Not applicable | The host app owns the document language; remediation writes `/Lang` into PDFs it tags |
| 3.2.1 On focus | Supports | Supports | Supports | Focus changes nothing |
| 3.2.2 On input | Supports | Supports | Supports | |
| 3.3.1 Error identification | Supports | Supports | Supports | Failures are shown as text in the component |
| 3.3.2 Labels or instructions | Supports | Supports | Supports | The review bar carries its notice |
| 4.1.2 Name, role, value | Supports | Supports | Supports | Android: checked at the node level in the gates, over the platform's own accessibility tree |

## WCAG 2.1 Level AA

| Criterion | Web | iOS | Android | Remarks |
| --- | --- | --- | --- | --- |
| 1.3.4 Orientation | Supports | Supports | Supports | The component adapts to its size |
| 1.3.5 Identify input purpose | Not applicable | Not applicable | Not applicable | The component has no user input fields of its own |
| 1.4.3 Contrast (minimum) | Supports | Supports | Not evaluated | Web: axe reports none; iOS: the audit reports none after the review buttons were darkened; Android: not measured |
| 1.4.4 Resize text | Supports | Supports | Supports | Web sizes in `rem` and the toolbar grows; iOS scales with Dynamic Type to AccessibilityXXXL; Android's review bar wraps at 2× font scale |
| 1.4.5 Images of text | Partially supports | Partially supports | Partially supports | The page itself is a bitmap by nature; its text is exposed in parallel |
| 1.4.10 Reflow | Supports | Supports | Supports | Tested at 320 px wide (web) and at accessibility text sizes |
| 1.4.11 Non-text contrast | Not evaluated | Not evaluated | Not evaluated | Mark outlines and the focus ring have not been measured against 3:1 |
| 1.4.12 Text spacing | Not evaluated | Not applicable | Not applicable | Web: the component's own text has not been tested with the spacing overrides |
| 1.4.13 Content on hover or focus | Not applicable | Not applicable | Not applicable | Nothing appears on hover |
| 2.4.5 Multiple ways | Not applicable | Not applicable | Not applicable | |
| 2.4.6 Headings and labels | Supports | Supports | Supports | |
| 2.4.7 Focus visible | Supports | Not evaluated | Not evaluated | Web: a 2 px outline on every control and mark |
| 3.1.2 Language of parts | Not applicable | Not applicable | Not applicable | |
| 3.2.3 Consistent navigation | Supports | Supports | Supports | |
| 3.2.4 Consistent identification | Supports | Supports | Supports | |
| 3.3.3 Error suggestion | Supports | Supports | Supports | |
| 3.3.4 Error prevention | Supports | Supports | Supports | Nothing is written without an explicit apply; changes are undoable |
| 4.1.3 Status messages | Partially supports | Partially supports | Partially supports | The review counts and the status line update, but are not announced as live regions |

## EN 301 549 v3.2.1

- **Chapter 9 (Web)** and **11 (Software)**: as the WCAG tables above; 11.5.2.x (platform
  accessibility services) is met by using each platform's own semantics — the DOM, UIAccessibility
  and Compose semantics — rather than custom trees.
- **Chapter 5 (Generic)**: 5.2 activation of accessibility features is the host app's; the SDK
  turns nothing off.
- **Chapter 12 (Documentation)**: the README documents the accessibility features (screen readers,
  keyboard, text scaling); this report is the accessibility documentation, in the state described
  at the top.

## What should be fixed or closed next

1. Commission the independent audit (A11Y-4), including screen-reader passes on all three platforms.
2. Measure non-text contrast (1.4.11) and text spacing (1.4.12) on the web component.
3. Announce review counts as a live region (4.1.3) and test hardware-keyboard support on iOS and
   Android (2.1.1, 2.1.2, 2.4.3, 2.4.7).
4. Drive all three components with real screen readers; the automated passes above cannot judge
   what a person actually hears.
