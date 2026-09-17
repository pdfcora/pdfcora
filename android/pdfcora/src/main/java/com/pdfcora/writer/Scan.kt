package com.pdfcora.writer

import com.pdfcora.PdfError

enum class XrefStyle { TABLE, STREAM }

/**
 * Reading just enough of an existing PDF to append to it.
 *
 * Deliberately not a parser. To write an incremental update we need where the last
 * cross-reference section starts, which style it uses, the next free object number, and
 * the trailer entries to carry forward. Nothing else.
 */
data class TrailerInfo(
    val startXref: Int,
    val style: XrefStyle,
    val size: Int,
    /** Highest object number actually present, which /Size may understate. */
    val highestObject: Int,
    val root: PdfValue,
    val info: PdfValue?,
    val id: PdfValue?,
) {
    /**
     * Where the next object this writer adds should be numbered.
     *
     * Not simply [size]: real files disagree with their own trailer. bug_455199.pdf
     * declares /Size 6 while its table lists objects 0-6, so trusting it overwrites a
     * live object — in that file, the page content stream.
     */
    val nextObjectNumber: Int get() = maxOf(size, highestObject + 1)

    companion object {
        fun scan(bytes: ByteArray): TrailerInfo {
            val startXref = findStartXref(bytes)
            val (entries, style) = readTrailerDictionary(bytes, startXref)

            if (entries.containsKey("Encrypt")) {
                // Strings in appended objects would have to be encrypted with the
                // document key. Writing them in the clear produces a file that opens
                // and then shows mojibake, which is worse than refusing.
                throw PdfError.SaveFailed("cannot append to an encrypted document")
            }
            val size = (entries["Size"] as? PdfValue.Integer)?.value
                ?: throw PdfError.SaveFailed("trailer has no /Size")
            val root = entries["Root"] ?: throw PdfError.SaveFailed("trailer has no /Root")

            return TrailerInfo(
                startXref, style, size, highestObjectNumber(bytes, size),
                root, entries["Info"], entries["ID"],
            )
        }

        /**
         * Scans for `N G obj` headers, the only account of object numbers that cannot
         * disagree with itself. Objects inside object streams are invisible here, which
         * is why /Size still participates in the maximum.
         */
        private fun highestObjectNumber(bytes: ByteArray, size: Int): Int {
            val text = bytes.toString(Charsets.ISO_8859_1)
            var highest = size - 1
            OBJECT_HEADER.findAll(text).forEach {
                plausible(it.groupValues[1])?.let { n -> highest = maxOf(highest, n) }
            }
            SUBSECTION.findAll(text).forEach {
                val first = plausible(it.groupValues[1])
                val count = plausible(it.groupValues[2])
                if (first != null && count != null) highest = maxOf(highest, first + count - 1)
            }
            return highest
        }

        /**
         * The scan runs over the whole file, binary stream data included, so it finds
         * byte sequences that merely look like object headers. The spec caps object
         * numbers at 8,388,607; anything above that is a false match, not a document
         * with ten million objects.
         */
        private fun plausible(digits: String): Int? =
            digits.toLongOrNull()?.takeIf { it in 0..MAX_OBJECT_NUMBER }?.toInt()

        private const val MAX_OBJECT_NUMBER = 8_388_607L
        private val OBJECT_HEADER = Regex("""(?:^|[\s>])(\d+)\s+(\d+)\s+obj\b""")
        private val SUBSECTION = Regex("""\bxref\s*\n\s*(\d+)\s+(\d+)""")
        private val SECTION_START = Regex("""\bxref\b|<<""")

        private fun findStartXref(bytes: ByteArray): Int {
            // The spec allows junk after %%EOF, so search backwards from the end.
            val tail = bytes.copyOfRange(maxOf(0, bytes.size - 2048), bytes.size)
                .toString(Charsets.ISO_8859_1)
            val offset = Regex("""startxref\s+(\d+)""").findAll(tail).lastOrNull()
                ?.groupValues?.get(1)?.toIntOrNull()
                ?: throw PdfError.SaveFailed("no startxref: not a PDF, or truncated")
            if (offset <= 0 || offset >= bytes.size) {
                throw PdfError.SaveFailed("startxref $offset is out of range")
            }
            return offset
        }

        private fun readTrailerDictionary(
            bytes: ByteArray,
            offset: Int,
        ): Pair<Map<String, PdfValue>, XrefStyle> {
            val end = minOf(bytes.size, offset + 65536)
            var window = bytes.copyOfRange(offset, end).toString(Charsets.ISO_8859_1)

            // startxref is not always exact. bug_455199.pdf points eight bytes early,
            // into the preceding "endobj". PDFium tolerates it, so this must too.
            // Whichever marker comes first, and "xref" only as a whole word: the
            // trailing "startxref" contains it.
            if (!window.trimStart().startsWith("xref") && !window.trimStart().startsWith("<<")) {
                SECTION_START.find(window.take(512))?.let { window = window.substring(it.range.first) }
            }

            if (window.trimStart().startsWith("xref")) {
                val trailerAt = window.indexOf("trailer")
                if (trailerAt < 0) throw PdfError.SaveFailed("xref table has no trailer")
                val dictAt = window.indexOf("<<", trailerAt)
                if (dictAt < 0) throw PdfError.SaveFailed("xref table has no trailer")
                return PdfDictionaryReader(window).read(dictAt) to XrefStyle.TABLE
            }
            val dictAt = window.indexOf("<<")
            if (dictAt < 0) throw PdfError.SaveFailed("no dictionary at startxref $offset")
            return PdfDictionaryReader(window).read(dictAt) to XrefStyle.STREAM
        }
    }
}
