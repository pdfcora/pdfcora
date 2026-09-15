package com.pdfiumkit.sign

import com.pdfiumkit.PdfError
import com.pdfiumkit.writer.PdfReader
import com.pdfiumkit.writer.PdfValue
import com.pdfiumkit.writer.PdfWriter
import com.pdfiumkit.writer.TrailerInfo
import com.pdfiumkit.writer.Xref
import java.util.Calendar
import java.util.Date
import java.util.Locale
import java.util.TimeZone

/**
 * Placing a signature field in a document.
 *
 * Everything except the cryptography. The field, its signature dictionary and the
 * AcroForm entry are appended as an incremental update, with a fixed-size /Contents
 * placeholder that the signer patches in place afterwards.
 *
 * The placeholder's size is fixed because /ByteRange records absolute offsets: writing
 * the signature by re-serialising would shift every offset after it, and the range would
 * then name the wrong bytes.
 */
internal object SignatureField {

    data class Options(
        /** Bytes reserved for the signature. 8192 fits RSA-2048 with a timestamp. */
        val reservedBytes: Int = 8192,
        val reason: String? = null,
        val contactInfo: String? = null,
        val fieldName: String? = null,
        val pageIndex: Int = 0,
        /**
         * Declared up front because it is written into the signed bytes before the CMS
         * exists, so it must match what the signer produces. ETSI.CAdES.detached is
         * PAdES and requires CAdES-BES; strict verifiers reject a plain PKCS#7 under it.
         */
        val subFilter: String = "ETSI.CAdES.detached",
    )

    data class Placement(
        val bytes: ByteArray,
        /** Offset of the `<` opening the /Contents hex string. */
        val contentsAt: Int,
        /** Length of the whole hex string, angle brackets included. */
        val contentsLength: Int,
        /** `[0, contentsAt, contentsAt + contentsLength, rest]`. */
        val byteRange: List<Int>,
    ) {
        override fun equals(other: Any?) = other is Placement && bytes.contentEquals(other.bytes)
        override fun hashCode() = bytes.contentHashCode()
    }

    /** Every offset is written this wide so patching cannot move a single byte. */
    private const val OFFSET_WIDTH = 10

    fun place(base: ByteArray, options: Options): Placement {
        // scanTrailer refuses encrypted documents, which is right here too: the strings
        // about to be written would have to be encrypted with the document key.
        val info = TrailerInfo.scan(base)
        val xref = Xref.build(base)
        val (catalogNumber, catalog) = PdfReader.catalog(base)

        val first = info.nextObjectNumber
        val signatureNumber = first
        val widgetNumber = first + 1
        val acroFormNumber = first + 2

        val pageNumber = PdfReader.pages(base, xref, catalog).getOrNull(options.pageIndex)
        val page = pageNumber?.let { PdfReader.obj(base, xref, it) }

        val objects = mutableMapOf<Int, PdfValue>()

        val signature = mutableListOf(
            "Type" to PdfValue.Name("Sig"),
            "Filter" to PdfValue.Name("Adobe.PPKLite"),
            "SubFilter" to PdfValue.Name(options.subFilter),
            // Placeholders: fixed width, patched once the real offsets are known.
            "ByteRange" to PdfValue.Raw(
                "[${pad(0)} ${pad(0)} ${pad(0)} ${pad(0)}]".toByteArray(Charsets.ISO_8859_1),
            ),
            "Contents" to PdfValue.Raw(
                ("<" + "0".repeat(options.reservedBytes * 2) + ">").toByteArray(Charsets.ISO_8859_1),
            ),
            "M" to PdfValue.Text(pdfDate(Date())),
        )
        options.reason?.let { signature += "Reason" to PdfValue.Text(it) }
        options.contactInfo?.let { signature += "ContactInfo" to PdfValue.Text(it) }
        objects[signatureNumber] = PdfValue.Dictionary(signature)

        val widget = mutableListOf(
            "Type" to PdfValue.Name("Annot"),
            "Subtype" to PdfValue.Name("Widget"),
            "FT" to PdfValue.Name("Sig"),
            "T" to PdfValue.Text(options.fieldName ?: "Signature${System.currentTimeMillis() % 100000}"),
            "V" to PdfValue.Reference(signatureNumber),
            // An invisible signature: zero rect, hidden and not printed. Valid without an
            // appearance stream, which is why the first release does not draw one.
            "Rect" to PdfValue.Array(List(4) { PdfValue.Integer(0) }),
            "F" to PdfValue.Integer(132),
        )
        pageNumber?.let { widget += "P" to PdfValue.Reference(it) }
        objects[widgetNumber] = PdfValue.Dictionary(widget)

        // Merge rather than replace: an existing AcroForm carries /DR, /DA and the
        // document's other fields, and dropping them would break every form in the file.
        val existing = acroForm(base, xref, catalog)
        val acro = existing.orEmpty().filterNot { it.first == "Fields" || it.first == "SigFlags" } +
            listOf(
                "Fields" to PdfValue.Array(fields(existing) + PdfValue.Reference(widgetNumber)),
                "SigFlags" to PdfValue.Integer(3),
            )
        objects[acroFormNumber] = PdfValue.Dictionary(acro)

        objects[catalogNumber] = PdfValue.Dictionary(
            entries(catalog).filterNot { it.first == "AcroForm" } +
                ("AcroForm" to PdfValue.Reference(acroFormNumber)),
        )

        if (pageNumber != null && page != null) {
            objects[pageNumber] = PdfValue.Dictionary(
                entries(page).filterNot { it.first == "Annots" } +
                    ("Annots" to PdfValue.Array(annots(base, xref, page) + PdfValue.Reference(widgetNumber))),
            )
        }

        return patchByteRange(PdfWriter.appendUpdate(base, objects), options.reservedBytes)
    }

    /**
     * Rewrites the /ByteRange placeholder with the real offsets. Both the placeholder and
     * the values are [OFFSET_WIDTH] digits wide, so nothing moves.
     */
    private fun patchByteRange(bytes: ByteArray, reservedBytes: Int): Placement {
        val text = bytes.toString(Charsets.ISO_8859_1)
        val contentsMarker = text.lastIndexOf("/Contents <")
        if (contentsMarker < 0) throw PdfError.SaveFailed("sign: the placeholder went missing")
        val rangeMarker = text.lastIndexOf("/ByteRange [")
        if (rangeMarker < 0) throw PdfError.SaveFailed("sign: the byte range went missing")

        val contentsAt = contentsMarker + "/Contents ".length
        val contentsLength = reservedBytes * 2 + 2
        val byteRange = listOf(
            0, contentsAt,
            contentsAt + contentsLength,
            bytes.size - (contentsAt + contentsLength),
        )

        val out = bytes.copyOf()
        val written = ("[" + byteRange.joinToString(" ") { pad(it) } + "]")
            .toByteArray(Charsets.ISO_8859_1)
        System.arraycopy(written, 0, out, rangeMarker + "/ByteRange ".length, written.size)

        return Placement(out, contentsAt, contentsLength, byteRange)
    }

    private fun pad(value: Int) = value.toString().padStart(OFFSET_WIDTH, '0')

    /** `D:YYYYMMDDHHmmSS+00'00'`, the form the reader already parses. */
    private fun pdfDate(date: Date): String {
        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { time = date }
        return String.format(
            Locale.US, "D:%04d%02d%02d%02d%02d%02d+00'00'",
            calendar.get(Calendar.YEAR), calendar.get(Calendar.MONTH) + 1,
            calendar.get(Calendar.DAY_OF_MONTH), calendar.get(Calendar.HOUR_OF_DAY),
            calendar.get(Calendar.MINUTE), calendar.get(Calendar.SECOND),
        )
    }

    private fun entries(value: PdfValue?): List<Pair<String, PdfValue>> =
        (value as? PdfValue.Dictionary)?.entries ?: emptyList()

    /** /AcroForm may be an inline dictionary or a reference; real files use both. */
    private fun acroForm(
        bytes: ByteArray,
        xref: Map<Int, Xref.Entry>,
        catalog: PdfValue,
    ): List<Pair<String, PdfValue>>? {
        PdfReader.reference(catalog, "AcroForm")?.let {
            return entries(PdfReader.obj(bytes, xref, it))
        }
        return PdfReader.entry(catalog, "AcroForm")?.let { entries(it) }
    }

    private fun fields(acroForm: List<Pair<String, PdfValue>>?): List<PdfValue> =
        (acroForm?.firstOrNull { it.first == "Fields" }?.second as? PdfValue.Array)?.items
            ?: emptyList()

    /** /Annots may likewise be inline or a reference. */
    private fun annots(bytes: ByteArray, xref: Map<Int, Xref.Entry>, page: PdfValue): List<PdfValue> {
        (PdfReader.entry(page, "Annots") as? PdfValue.Array)?.let { return it.items }
        val number = PdfReader.reference(page, "Annots") ?: return emptyList()
        return (PdfReader.obj(bytes, xref, number) as? PdfValue.Array)?.items ?: emptyList()
    }
}
