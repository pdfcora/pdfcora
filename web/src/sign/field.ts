/**
 * Placing a signature field in a document.
 *
 * Everything except the cryptography. The field, its signature dictionary and the
 * AcroForm entry are appended as an incremental update, with a fixed-size `/Contents`
 * placeholder that the signer patches in place afterwards.
 *
 * The placeholder's size is fixed because the `/ByteRange` records absolute offsets:
 * if the signature were written by re-serialising, every offset after it would shift
 * and the range would name the wrong bytes.
 */

import { appendUpdate } from '../writer/incremental.js';
import { scanTrailer, nextObjectNumber } from '../writer/scan.js';
import { buildXref, type XrefMap } from '../writer/xref.js';
import { listPages, readObject, readCatalog, refNumber } from '../writer/read.js';
import { entryOf, name, raw, ref, type PdfValue } from '../writer/values.js';

export interface AddSignatureFieldOptions {
  /** Bytes reserved for the signature itself. 8192 fits RSA-2048 with a timestamp. */
  readonly reservedBytes: number;
  readonly reason?: string;
  readonly contactInfo?: string;
  readonly fieldName?: string;
  /** The page the invisible widget is attached to. */
  readonly pageIndex?: number;
  /**
   * Declared up front because it is written into the signed bytes before the CMS
   * exists, so it must match what the signer actually produces.
   *
   * `ETSI.CAdES.detached` is PAdES and requires CAdES-BES — a CMS carrying the
   * `signingCertificateV2` signed attribute. A plain PKCS#7 under this sub-filter is
   * rejected by strict verifiers even though the signature itself is sound; poppler is
   * one of them. Use `adbe.pkcs7.detached` for a plain PKCS#7 signer.
   */
  readonly subFilter?: 'ETSI.CAdES.detached' | 'adbe.pkcs7.detached';
}

export interface SignatureFieldPlacement {
  readonly bytes: Uint8Array;
  /** Offset of the `<` opening the `/Contents` hex string. */
  readonly contentsAt: number;
  /** Length of the whole hex string, angle brackets included. */
  readonly contentsLength: number;
  /** `[0, contentsAt, contentsAt + contentsLength, rest]`. */
  readonly byteRange: readonly number[];
}

/** Every offset is written this wide so patching cannot move a single byte. */
const OFFSET_WIDTH = 10;

export async function addSignatureField(
  base: Uint8Array,
  options: AddSignatureFieldOptions,
): Promise<SignatureFieldPlacement> {
  // scanTrailer refuses encrypted documents, which is the right answer here too: the
  // strings we are about to write would have to be encrypted with the document key.
  const info = scanTrailer(base);
  const xref = await buildXref(base);
  const { number: catalogNumber, value: catalog } = await readCatalog(base);

  const first = nextObjectNumber(info);
  const signatureNumber = first;
  const widgetNumber = first + 1;
  const acroFormNumber = first + 2;

  const pageNumber = (await listPages(base, xref, catalog))[options.pageIndex ?? 0];
  const page = pageNumber === undefined ? undefined : await readObject(base, xref, pageNumber);

  const objects = new Map<number, PdfValue>();

  objects.set(signatureNumber, {
    Type: name('Sig'),
    Filter: name('Adobe.PPKLite'),
    SubFilter: name(options.subFilter ?? 'ETSI.CAdES.detached'),
    // Placeholders: fixed width, patched once the real offsets are known.
    ByteRange: raw(new TextEncoder().encode(
      `[${pad(0)} ${pad(0)} ${pad(0)} ${pad(0)}]`)),
    Contents: raw(new TextEncoder().encode(`<${'0'.repeat(options.reservedBytes * 2)}>`)),
    M: pdfDate(new Date()),
    ...(options.reason ? { Reason: options.reason } : {}),
    ...(options.contactInfo ? { ContactInfo: options.contactInfo } : {}),
  });

  objects.set(widgetNumber, {
    Type: name('Annot'),
    Subtype: name('Widget'),
    FT: name('Sig'),
    T: options.fieldName ?? `Signature${Date.now() % 100000}`,
    V: ref(signatureNumber),
    // An invisible signature: zero rect, hidden and not printed. Valid without an
    // appearance stream, which is why the first release does not draw one.
    Rect: [0, 0, 0, 0],
    F: 132,
    ...(pageNumber !== undefined ? { P: ref(pageNumber) } : {}),
  });

  // Merge rather than replace: an existing AcroForm carries /DR, /DA and the document's
  // other fields, and dropping them would break every form in the file.
  const existingAcroForm = await acroFormOf(base, xref, catalog);
  objects.set(acroFormNumber, {
    ...(existingAcroForm ?? {}),
    Fields: [...(fieldsOf(existingAcroForm) ?? []), ref(widgetNumber)],
    SigFlags: 3,
  });

  objects.set(catalogNumber, { ...asDictionary(catalog), AcroForm: ref(acroFormNumber) });

  if (pageNumber !== undefined && page) {
    objects.set(pageNumber, {
      ...asDictionary(page),
      Annots: [...(await annotsOf(base, xref, page) ?? []), ref(widgetNumber)],
    });
  }

  const bytes = appendUpdate(base, objects);
  return patchByteRange(bytes, options.reservedBytes);
}

/**
 * Rewrites the `/ByteRange` placeholder with the real offsets.
 *
 * Both the placeholder and the values are `OFFSET_WIDTH` digits wide, so nothing moves.
 */
function patchByteRange(bytes: Uint8Array, reservedBytes: number): SignatureFieldPlacement {
  const text = new TextDecoder('latin1').decode(bytes);

  const contentsLength = reservedBytes * 2 + 2;
  const contentsAt = text.lastIndexOf('/Contents <') + '/Contents '.length;
  if (contentsAt < '/Contents '.length) throw new Error('sign: the placeholder went missing');

  const rangeAt = text.lastIndexOf('/ByteRange [');
  if (rangeAt < 0) throw new Error('sign: the byte range went missing');

  const byteRange = [
    0,
    contentsAt,
    contentsAt + contentsLength,
    bytes.length - (contentsAt + contentsLength),
  ];

  const written = new TextEncoder().encode(
    `[${byteRange.map(pad).join(' ')}]`);
  const out = new Uint8Array(bytes);
  out.set(written, rangeAt + '/ByteRange '.length);

  return { bytes: out, contentsAt, contentsLength, byteRange };
}

const pad = (value: number) => String(value).padStart(OFFSET_WIDTH, '0');

/** `D:YYYYMMDDHHmmSS+00'00'`, the form the reader already parses. */
function pdfDate(date: Date): string {
  const two = (n: number) => String(n).padStart(2, '0');
  return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
    + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}+00'00'`;
}

const asDictionary = (value: PdfValue): Record<string, PdfValue> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, PdfValue>)
    : {};

/** `/AcroForm` may be an inline dictionary or a reference; real files use both. */
async function acroFormOf(
  bytes: Uint8Array,
  xref: XrefMap,
  catalog: PdfValue,
): Promise<Record<string, PdfValue> | undefined> {
  const number = refNumber(catalog, 'AcroForm');
  if (number !== undefined) {
    const value = await readObject(bytes, xref, number);
    return value ? asDictionary(value) : undefined;
  }
  const inline = entryOf(catalog, 'AcroForm');
  return inline ? asDictionary(inline) : undefined;
}

function fieldsOf(acroForm: Record<string, PdfValue> | undefined): PdfValue[] | undefined {
  const fields = acroForm?.Fields;
  return Array.isArray(fields) ? [...fields] : undefined;
}

/** `/Annots` may likewise be inline or a reference. */
async function annotsOf(
  bytes: Uint8Array,
  xref: XrefMap,
  page: PdfValue,
): Promise<PdfValue[] | undefined> {
  const inline = entryOf(page, 'Annots');
  if (Array.isArray(inline)) return [...inline];

  const number = refNumber(page, 'Annots');
  if (number === undefined) return undefined;
  const value = await readObject(bytes, xref, number);
  return Array.isArray(value) ? [...value] : undefined;
}
