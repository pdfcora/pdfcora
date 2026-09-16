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
import { buildXref } from '../writer/xref.js';
import { acroFormOf, annotsOf, listPages, readObject, readCatalog } from '../writer/read.js';
import { name, raw, ref } from '../writer/values.js';
/** Every offset is written this wide so patching cannot move a single byte. */
const OFFSET_WIDTH = 10;
export async function addSignatureField(base, options) {
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
    const objects = new Map();
    objects.set(signatureNumber, {
        Type: name('Sig'),
        Filter: name('Adobe.PPKLite'),
        SubFilter: name(options.subFilter ?? 'ETSI.CAdES.detached'),
        // Placeholders: fixed width, patched once the real offsets are known.
        ByteRange: raw(new TextEncoder().encode(`[${pad(0)} ${pad(0)} ${pad(0)} ${pad(0)}]`)),
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
function patchByteRange(bytes, reservedBytes) {
    const text = new TextDecoder('latin1').decode(bytes);
    const contentsLength = reservedBytes * 2 + 2;
    const contentsAt = text.lastIndexOf('/Contents <') + '/Contents '.length;
    if (contentsAt < '/Contents '.length)
        throw new Error('sign: the placeholder went missing');
    const rangeAt = text.lastIndexOf('/ByteRange [');
    if (rangeAt < 0)
        throw new Error('sign: the byte range went missing');
    const byteRange = [
        0,
        contentsAt,
        contentsAt + contentsLength,
        bytes.length - (contentsAt + contentsLength),
    ];
    const written = new TextEncoder().encode(`[${byteRange.map(pad).join(' ')}]`);
    const out = new Uint8Array(bytes);
    out.set(written, rangeAt + '/ByteRange '.length);
    return { bytes: out, contentsAt, contentsLength, byteRange };
}
const pad = (value) => String(value).padStart(OFFSET_WIDTH, '0');
/** `D:YYYYMMDDHHmmSS+00'00'`, the form the reader already parses. */
function pdfDate(date) {
    const two = (n) => String(n).padStart(2, '0');
    return `D:${date.getUTCFullYear()}${two(date.getUTCMonth() + 1)}${two(date.getUTCDate())}`
        + `${two(date.getUTCHours())}${two(date.getUTCMinutes())}${two(date.getUTCSeconds())}+00'00'`;
}
function fieldsOf(acroForm) {
    const fields = acroForm?.Fields;
    return Array.isArray(fields) ? [...fields] : undefined;
}
const asDictionary = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
//# sourceMappingURL=field.js.map