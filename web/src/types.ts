/** A point in PDF page space: origin bottom-left, units are points. */
export interface PdfPoint {
  readonly x: number;
  readonly y: number;
}

/**
 * A rectangle in PDF page space: origin bottom-left.
 *
 * Converting to view space is always explicit — see {@link toViewRect}. There is no
 * implicit Y-flip anywhere in this SDK.
 */
export interface PdfRect {
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
  readonly top: number;
}

export interface ViewRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/** Converts a PDF-space rect to top-left-origin view coordinates. */
export function toViewRect(rect: PdfRect, pageHeight: number, scale = 1): ViewRect {
  return {
    x: rect.left * scale,
    y: (pageHeight - rect.top) * scale,
    width: (rect.right - rect.left) * scale,
    height: (rect.top - rect.bottom) * scale,
  };
}

export interface PdfQuad {
  readonly p1: PdfPoint;
  readonly p2: PdfPoint;
  readonly p3: PdfPoint;
  readonly p4: PdfPoint;
}

export interface PdfSize {
  readonly width: number;
  readonly height: number;
}

/** An RGBA colour. */
export interface PdfColor {
  readonly red: number;
  readonly green: number;
  readonly blue: number;
  readonly alpha?: number;
}

export const BLACK: PdfColor = { red: 0, green: 0, blue: 0, alpha: 255 };
export const YELLOW: PdfColor = { red: 255, green: 255, blue: 0, alpha: 128 };

export type PdfPageRotation = 0 | 90 | 180 | 270;

export interface PdfRenderOptions {
  /** Width in pixels; height follows the page aspect ratio unless `height` is given. */
  readonly width?: number;
  readonly height?: number;
  readonly annotations?: boolean;
  readonly forms?: boolean;
  readonly grayscale?: boolean;
  readonly background?: PdfColor;
}

export interface PdfSearchOptions {
  readonly caseSensitive?: boolean;
  readonly wholeWord?: boolean;
}

export interface PdfTextMatch {
  readonly start: number;
  readonly length: number;
  readonly rects: readonly PdfRect[];
}

/** Typed document metadata. Non-standard keys are reachable via `document.metadataValue`. */
export interface PdfMetadata {
  readonly title?: string;
  readonly author?: string;
  readonly subject?: string;
  readonly keywords?: string;
  readonly creator?: string;
  readonly producer?: string;
}

export interface PdfPermissions {
  readonly canPrint: boolean;
  readonly canModify: boolean;
  readonly canCopy: boolean;
  readonly canAnnotate: boolean;
  readonly canFillForms: boolean;
}

export interface PdfAttachment {
  readonly name: string;
}

export interface PdfOutlineItem {
  readonly title: string;
  readonly pageIndex?: number;
  readonly children: readonly PdfOutlineItem[];
}

export type PdfLinkTarget =
  | { readonly kind: 'page'; readonly pageIndex: number }
  | { readonly kind: 'uri'; readonly uri: string }
  | { readonly kind: 'unresolved' };

export interface PdfLink {
  readonly rect: PdfRect;
  readonly target: PdfLinkTarget;
}

/**
 * How to write the document out.
 *
 * `'incremental'` keeps the original bytes and existing signatures, but — verified
 * against PDFium `chromium/7243` — does not persist annotations created in this
 * session. Use `'full'` after adding annotations.
 */
export type PdfSaveMode = 'full' | 'incremental';

// MARK: - Annotations

export interface PdfAnnotationBase {
  readonly pageIndex: number;
  readonly index: number;
  readonly rect: PdfRect;
  readonly color?: PdfColor;
  readonly flags: number;
  readonly contents?: string;
}

/**
 * An annotation, as a snapshot. A discriminated union on `kind`, so a `switch` over it
 * is exhaustive and each variant exposes only the fields that apply to it.
 */
export type PdfAnnotation =
  | ({ readonly kind: 'highlight' | 'underline' | 'strikeout' | 'squiggly'; readonly quads: readonly PdfQuad[] } & PdfAnnotationBase)
  | ({ readonly kind: 'ink'; readonly strokes: readonly (readonly PdfPoint[])[] } & PdfAnnotationBase)
  | ({ readonly kind: 'freeText' | 'square' | 'circle' | 'line' | 'note' | 'stamp' | 'fileAttachment' } & PdfAnnotationBase)
  | ({ readonly kind: 'link'; readonly uri?: string } & PdfAnnotationBase)
  | ({ readonly kind: 'widget'; readonly fieldName?: string } & PdfAnnotationBase)
  /** A subtype this SDK does not model. Never dropped silently. */
  | ({ readonly kind: 'unknown'; readonly subtypeCode: number } & PdfAnnotationBase);

// MARK: - Form fields

export interface PdfFormFieldBase {
  readonly pageIndex: number;
  readonly annotationIndex: number;
  readonly name?: string;
  readonly alternateName?: string;
  readonly rect: PdfRect;
  readonly flags: number;
  readonly isReadOnly: boolean;
  readonly isRequired: boolean;
}

/** An interactive form field, as a discriminated union on `kind`. */
export type PdfFormField =
  | ({ readonly kind: 'text'; readonly value: string; readonly isMultiline: boolean; readonly isPassword: boolean } & PdfFormFieldBase)
  | ({ readonly kind: 'checkBox' | 'radioButton'; readonly isChecked: boolean; readonly exportValue?: string } & PdfFormFieldBase)
  | ({ readonly kind: 'comboBox' | 'listBox'; readonly value: string; readonly options: readonly string[]; readonly selectedIndices: readonly number[] } & PdfFormFieldBase)
  | ({ readonly kind: 'pushButton' | 'signature' } & PdfFormFieldBase)
  | ({ readonly kind: 'unknown'; readonly typeCode: number } & PdfFormFieldBase);
