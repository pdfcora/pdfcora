import type {
  PdfColor, PdfPoint, PdfQuad, PdfRect, PdfPageRotation, PdfRedactionTarget,
} from '../types.js';
import type { PdfZoom } from './zoom.js';

export type PdfPageLayout = 'single' | 'continuous';

/** What a drag on the page does. Lives in the SDK so peers can agree on it. */
export type PdfTool = 'select' | 'ink' | 'note' | 'highlight' | 'redact';

/** What the user has picked out: a dragged area, or an existing annotation. */
export type PdfSelection =
  | { readonly kind: 'region'; readonly page: number; readonly rect: PdfRect }
  | { readonly kind: 'annotation'; readonly page: number; readonly index: number };

/**
 * Where a viewer is looking, in a form that survives a change of screen.
 *
 * Held in document space rather than view space: a scroll offset is in the sending
 * viewer's own pixels and means nothing elsewhere, so what travels is the page and the
 * PDF point at the centre of the viewport.
 */
export interface PdfViewState {
  readonly pageIndex: number;
  /** In PDF coordinates on `pageIndex`: the point at the centre of the viewport. */
  readonly center: PdfPoint;
  readonly zoom: PdfZoom;
  readonly rotation: PdfPageRotation;
  readonly layout: PdfPageLayout;
}

/**
 * A change to the document, carrying the arguments of the call that made it.
 *
 * An event saying only "annotation 3 was added" cannot be reproduced by a peer — it does
 * not say what to add — so each case mirrors the parameters of the API it came from.
 */
export type PdfEdit =
  | { readonly kind: 'noteAdded'; readonly page: number; readonly rect: PdfRect;
      readonly contents: string; readonly color: PdfColor }
  | { readonly kind: 'inkAdded'; readonly page: number; readonly strokes: readonly (readonly PdfPoint[])[];
      readonly color: PdfColor; readonly lineWidth: number }
  | { readonly kind: 'highlightAdded'; readonly page: number; readonly quads: readonly PdfQuad[];
      readonly color: PdfColor }
  | { readonly kind: 'annotationRemoved'; readonly page: number; readonly index: number }
  | { readonly kind: 'fieldTextSet'; readonly page: number; readonly annotationIndex: number;
      readonly value: string }
  | { readonly kind: 'fieldCheckedSet'; readonly page: number; readonly annotationIndex: number;
      readonly checked: boolean }
  | { readonly kind: 'fieldOptionSet'; readonly page: number; readonly annotationIndex: number;
      readonly option: number; readonly selected: boolean }
  | { readonly kind: 'redacted'; readonly targets: readonly PdfRedactionTarget[] };

export type PdfViewChange =
  | { readonly kind: 'viewport'; readonly state: PdfViewState }
  | { readonly kind: 'selection'; readonly selection: PdfSelection | null }
  | { readonly kind: 'tool'; readonly tool: PdfTool }
  | { readonly kind: 'edit'; readonly edit: PdfEdit };

export interface PdfViewEvent {
  /** Per sender. A peer ignores anything at or below the highest it has seen. */
  readonly sequence: number;
  /**
   * Set on edit events: a hash of the bytes the sender opened.
   *
   * Annotation and field indices are positions in specific bytes, so replaying a
   * removal against a different document removes the wrong thing. A peer refuses an
   * edit whose fingerprint does not match its own.
   */
  readonly documentFingerprint?: string;
  readonly sessionId: string;
  /** Applying a remote event must emit nothing, or two viewers echo each other. */
  readonly origin: 'local' | 'remote';
  readonly change: PdfViewChange;
}

/**
 * Which page the centre falls on, walking the stack of page heights.
 *
 * `gap` is the spacing the app draws between pages. It counts: ignoring it drifts by a
 * whole page part-way down a long document.
 */
export function currentPage(
  pages: readonly { height: number }[],
  centerY: number,
  gap: number,
): number {
  let bottom = 0;
  for (let index = 0; index < pages.length; index++) {
    bottom += pages[index]!.height + gap;
    if (centerY < bottom) return index;
  }
  // Past the end: the last page, rather than an index nobody can use.
  return Math.max(0, pages.length - 1);
}

/** A reviewable region drawn over a page, such as a redaction suggestion. */
export type PdfMarkState = 'pending' | 'accepted' | 'rejected';

export interface PdfMark {
  readonly id: string;
  readonly pageIndex: number;
  readonly rects: readonly PdfRect[];
  readonly state: PdfMarkState;
}
