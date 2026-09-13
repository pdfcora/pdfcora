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

/**
 * Converts between PDF page space (bottom-left origin) and view space (top-left).
 *
 * Anything interactive needs both directions: PDF to view to place an overlay, view to
 * PDF to work out what a click landed on. Doing the Y-flip by hand at each call site is
 * where this goes wrong, so it lives here.
 *
 * ```ts
 * const t = PdfViewTransform.fittingWidth(await page.size(), canvas.clientWidth)
 * const box = t.toViewRect(field.rect)          // position a control
 * const hit = t.toPdf({ x: event.offsetX, y: event.offsetY })
 * ```
 */
export class PdfViewTransform {
  constructor(
    readonly pageSize: PdfSize,
    /** View pixels per PDF point. */
    readonly scale: number,
  ) {}

  /** Derives the scale needed to fit the page into `width` view pixels. */
  static fittingWidth(pageSize: PdfSize, width: number): PdfViewTransform {
    // A degenerate page would otherwise give an infinite scale, which silently
    // poisons every later coordinate.
    return new PdfViewTransform(pageSize, pageSize.width > 0 ? width / pageSize.width : 1);
  }

  get viewSize(): { width: number; height: number } {
    return { width: this.pageSize.width * this.scale, height: this.pageSize.height * this.scale };
  }

  toView(point: PdfPoint): { x: number; y: number } {
    return { x: point.x * this.scale, y: (this.pageSize.height - point.y) * this.scale };
  }

  toViewRect(rect: PdfRect): ViewRect {
    const topLeft = this.toView({
      x: Math.min(rect.left, rect.right),
      y: Math.max(rect.bottom, rect.top),
    });
    return {
      x: topLeft.x,
      y: topLeft.y,
      width: Math.abs(rect.right - rect.left) * this.scale,
      height: Math.abs(rect.top - rect.bottom) * this.scale,
    };
  }

  toPdf(point: { x: number; y: number }): PdfPoint {
    return { x: point.x / this.scale, y: this.pageSize.height - point.y / this.scale };
  }

  toPdfRect(rect: ViewRect): PdfRect {
    const topLeft = this.toPdf({ x: rect.x, y: rect.y });
    const bottomRight = this.toPdf({ x: rect.x + rect.width, y: rect.y + rect.height });
    return { left: topLeft.x, bottom: bottomRight.y, right: bottomRight.x, top: topLeft.y };
  }
}

/**
 * Whether `point` falls inside `rect`, edges included.
 *
 * Edge order is normalised first: PDFium returns rects with `left > right` or
 * `bottom > top` often enough that assuming otherwise misses real hits.
 */
export function rectContains(rect: PdfRect, point: PdfPoint): boolean {
  return point.x >= Math.min(rect.left, rect.right)
    && point.x <= Math.max(rect.left, rect.right)
    && point.y >= Math.min(rect.bottom, rect.top)
    && point.y <= Math.max(rect.bottom, rect.top);
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

// MARK: - Signatures

/** A signature already present in a document. Reading only; nothing here is verified. */
export interface PdfSignature {
  readonly index: number;
  readonly reason?: string;
  /** The time the signer claimed. Not trusted, and not a timestamp authority's. */
  readonly signingTime?: Date;
  /** e.g. `adbe.pkcs7.detached`, `ETSI.CAdES.detached`. */
  readonly subFilter?: string;
  /** Pairs of offset and length covering the signed spans of the file. */
  readonly byteRange: readonly number[];
  /** The raw PKCS#7 blob, for a verifier to check. */
  readonly contents: Uint8Array;
  readonly docMdpPermission?: number;
  /**
   * Whether the signed ranges reach the end of the file.
   *
   * A signature can be cryptographically valid and still cover only part of the
   * document; anything appended afterwards is unprotected.
   */
  readonly coversWholeDocument: boolean;
}

/** A certificate from a signature's chain. */
export interface PdfCertificateInfo {
  readonly commonName?: string;
  readonly serialNumber: bigint;
  readonly notBefore: Date;
  readonly notAfter: Date;
  /** The certificate as DER, for callers that want to inspect it further. */
  readonly der: Uint8Array;
}

/**
 * The outcome of verifying a signature.
 *
 * Integrity and trust are deliberately separate outcomes. `valid` means the bytes have
 * not changed **and** the chain reaches a supplied anchor; a signature that is
 * cryptographically intact but whose issuer is unknown is `untrusted`, not `valid`.
 *
 * Revocation (CRL/OCSP) is not checked, so `valid` does not mean the certificate is
 * still in good standing.
 */
export type PdfSignatureValidity =
  | { readonly kind: 'valid'; readonly signer: PdfCertificateInfo; readonly timestamp?: Date }
  /** The signed bytes changed after signing. */
  | { readonly kind: 'digestMismatch' }
  /** Cryptographically intact, but the chain does not reach a trusted anchor. */
  | { readonly kind: 'untrusted'; readonly chain: readonly PdfCertificateInfo[]; readonly reason: string }
  | { readonly kind: 'expired'; readonly at: Date }
  | { readonly kind: 'malformed'; readonly reason: string }
  | { readonly kind: 'unsupported'; readonly subFilter: string };

export interface PdfVerifyOptions {
  /** DER-encoded certificates to trust. With none supplied, nothing is trusted. */
  readonly trustAnchors?: readonly Uint8Array[];
  /** The instant to judge validity at. Defaults to now; set it to make tests stable. */
  readonly at?: Date;
}
