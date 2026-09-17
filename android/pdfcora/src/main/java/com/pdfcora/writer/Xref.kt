package com.pdfcora.writer

import com.pdfcora.PdfError
import java.io.ByteArrayOutputStream
import java.util.zip.Inflater

/**
 * Flate decompression and PNG prediction.
 *
 * Needed because a cross-reference stream and the object streams it points into are both
 * compressed, and one corpus document keeps its Catalog inside one.
 */
internal object Flate {

    fun inflate(bytes: ByteArray): ByteArray {
        if (bytes.isEmpty()) throw PdfError.SaveFailed("inflate: empty stream")
        // Try the zlib wrapper first, then raw: some producers omit the two-byte header.
        return runCatching { inflate(bytes, raw = false) }
            .recoverCatching { inflate(bytes, raw = true) }
            .getOrElse { throw PdfError.SaveFailed("inflate: the stream could not be decompressed") }
    }

    private fun inflate(bytes: ByteArray, raw: Boolean): ByteArray {
        val inflater = Inflater(raw)
        try {
            inflater.setInput(bytes)
            val out = ByteArrayOutputStream(bytes.size * 4)
            val buffer = ByteArray(1 shl 16)
            while (!inflater.finished()) {
                val written = inflater.inflate(buffer)
                if (written == 0) {
                    if (inflater.needsInput() || inflater.needsDictionary()) break
                }
                out.write(buffer, 0, written)
            }
            if (out.size() == 0) throw PdfError.SaveFailed("inflate: produced nothing")
            return out.toByteArray()
        } finally {
            inflater.end()
        }
    }

    /**
     * Undoes a PNG predictor.
     *
     * Cross-reference streams are routinely written with /Predictor 12, which makes each
     * row a delta against the one above. Inflating without undoing it yields
     * plausible-looking bytes and completely wrong offsets — a failure that shows up as
     * "object not found" rather than as a decode error.
     */
    fun undoPredictor(
        data: ByteArray,
        predictor: Int,
        columns: Int,
        colors: Int = 1,
        bitsPerComponent: Int = 8,
    ): ByteArray {
        if (predictor <= 1) return data
        if (predictor < 10) {
            throw PdfError.SaveFailed("inflate: TIFF predictor $predictor is not supported")
        }

        val pixel = maxOf(1, (colors * bitsPerComponent + 7) / 8)
        val rowLength = (columns * colors * bitsPerComponent + 7) / 8
        val stride = rowLength + 1                  // each row carries a leading filter byte
        val rows = data.size / stride

        val out = ByteArray(rows * rowLength)
        var previous = ByteArray(rowLength)

        for (row in 0 until rows) {
            val type = data[row * stride].toInt() and 0xff
            val current = ByteArray(rowLength)

            for (i in 0 until rowLength) {
                val rawByte = data[row * stride + 1 + i].toInt() and 0xff
                val left = if (i >= pixel) current[i - pixel].toInt() and 0xff else 0
                val up = previous[i].toInt() and 0xff
                val upLeft = if (i >= pixel) previous[i - pixel].toInt() and 0xff else 0

                val value = when (type) {
                    0 -> rawByte                                    // None
                    1 -> rawByte + left                             // Sub
                    2 -> rawByte + up                               // Up
                    3 -> rawByte + (left + up) / 2                  // Average
                    4 -> rawByte + paeth(left, up, upLeft)          // Paeth
                    else -> throw PdfError.SaveFailed("inflate: unknown PNG filter type $type")
                }
                current[i] = (value and 0xff).toByte()
            }

            System.arraycopy(current, 0, out, row * rowLength, rowLength)
            previous = current
        }
        return out
    }

    private fun paeth(left: Int, up: Int, upLeft: Int): Int {
        val estimate = left + up - upLeft
        val dl = Math.abs(estimate - left)
        val du = Math.abs(estimate - up)
        val dul = Math.abs(estimate - upLeft)
        return when {
            dl <= du && dl <= dul -> left
            du <= dul -> up
            else -> upLeft
        }
    }
}

/**
 * Locating every object in a document.
 *
 * Both cross-reference styles are walked, following /Prev back through every appended
 * update. Newer sections win, which is what an incremental update means.
 */
internal object Xref {

    sealed class Entry {
        data class AtOffset(val offset: Int, val generation: Int) : Entry()
        data class InObjectStream(val stream: Int, val index: Int) : Entry()
    }

    /** How much of the file to decode when reading a section header or dictionary. */
    private const val WINDOW = 1 shl 20

    fun build(bytes: ByteArray): Map<Int, Entry> {
        val map = mutableMapOf<Int, Entry>()
        val visited = mutableSetOf<Int>()
        var offset: Int? = findStartXref(bytes)

        while (offset != null) {
            // A malformed file can point /Prev at a section already walked. Stopping is
            // the only safe response; continuing would loop forever on untrusted input.
            if (!visited.add(offset)) break
            offset = readSection(bytes, offset, map)
        }

        if (map.isEmpty()) throw PdfError.SaveFailed("xref: no objects were located")
        return map
    }

    /** Returns the /Prev offset, or null at the end of the chain. */
    private fun readSection(bytes: ByteArray, offset: Int, map: MutableMap<Int, Entry>): Int? {
        val end = minOf(bytes.size, offset + WINDOW)
        if (offset >= end) throw PdfError.SaveFailed("xref: offset $offset past the file")
        var text = bytes.copyOfRange(offset, end).toString(Charsets.ISO_8859_1)
        var skipped = 0

        // startxref is not always exact; the writer tolerates the same slippage. Latin-1
        // gives one character per byte, so a character offset is a byte offset.
        if (!text.trimStart().startsWith("xref") && !text.trimStart().startsWith("<<") &&
            SECTION_START.find(text.take(40))?.range?.first ?: 99 > 2
        ) {
            val at = SECTION_START.find(text.take(512))?.range?.first
                ?: throw PdfError.SaveFailed("xref: nothing recognisable at $offset")
            skipped = at
            text = text.substring(at)
        }

        return if (text.trimStart().startsWith("xref")) {
            readTable(text, map)
        } else {
            readStream(bytes, offset + skipped, map)
        }
    }

    /**
     * A classic table: `xref`, then subsections of "first count" followed by that many
     * twenty-byte entries.
     */
    private fun readTable(text: String, map: MutableMap<Int, Entry>): Int? {
        val trailerAt = text.indexOf("trailer")
        if (trailerAt < 0) throw PdfError.SaveFailed("xref: table has no trailer")
        val body = text.substring(0, trailerAt)

        var i = 0
        while (i < body.length && body[i].isWhitespace()) i++
        i += 4                                       // skip the "xref" keyword

        while (i < body.length) {
            while (i < body.length && body[i].isWhitespace()) i++
            val first = readNumber(body, i)?.also { i = it.second }?.first ?: break
            while (i < body.length && body[i] == ' ') i++
            val count = readNumber(body, i)?.also { i = it.second }?.first ?: break
            while (i < body.length && body[i].isWhitespace()) i++

            for (entry in 0 until count) {
                if (i + 18 > body.length) break
                val offset = body.substring(i, i + 10).toIntOrNull()
                val generation = body.substring(i + 11, i + 16).toIntOrNull()
                val kind = body[i + 17]

                val number = first + entry
                if (kind == 'n' && offset != null && generation != null && number !in map) {
                    map[number] = Entry.AtOffset(offset, generation)
                }
                // Entries are twenty bytes, though some writers use a nineteen-byte line
                // ending; step past whatever whitespace follows.
                i += 18
                while (i < body.length && body[i].isWhitespace()) i++
            }
        }

        val dictAt = text.indexOf("<<", trailerAt)
        if (dictAt < 0) throw PdfError.SaveFailed("xref: trailer has no dictionary")
        val trailer = PdfDictionaryReader(text).read(dictAt)
        return (trailer["Prev"] as? PdfValue.Integer)?.value
    }

    private fun readNumber(text: String, start: Int): Pair<Int, Int>? {
        var i = start
        val digits = StringBuilder()
        while (i < text.length && text[i].isDigit()) { digits.append(text[i]); i++ }
        return digits.toString().toIntOrNull()?.let { it to i }
    }

    /**
     * A cross-reference stream: the table is itself an object, usually Flate-compressed
     * and PNG-predicted, whose /W gives each field's width and /Index the objects.
     */
    private fun readStream(bytes: ByteArray, offset: Int, map: MutableMap<Int, Entry>): Int? {
        val end = minOf(bytes.size, offset + WINDOW)
        val text = bytes.copyOfRange(offset, end).toString(Charsets.ISO_8859_1)
        val dictAt = text.indexOf("<<")
        if (dictAt < 0) throw PdfError.SaveFailed("xref: no stream dictionary at $offset")

        val dictionary = PdfDictionaryReader(text).read(dictAt)
        val data = streamBytes(bytes, offset, text, dictionary)

        val widths = (dictionary["W"] as? PdfValue.Array)?.items
            ?.mapNotNull { (it as? PdfValue.Integer)?.value }
            ?: throw PdfError.SaveFailed("xref: stream has no /W")
        if (widths.size < 3) throw PdfError.SaveFailed("xref: malformed /W")

        val size = (dictionary["Size"] as? PdfValue.Integer)?.value ?: 0
        val index = (dictionary["Index"] as? PdfValue.Array)?.items
            ?.mapNotNull { (it as? PdfValue.Integer)?.value }
            ?: listOf(0, size)

        val rowWidth = widths[0] + widths[1] + widths[2]
        if (rowWidth <= 0) throw PdfError.SaveFailed("xref: zero-width rows")

        var row = 0
        var pair = 0
        while (pair + 1 < index.size) {
            var number = index[pair]
            repeat(index[pair + 1]) {
                val at = row * rowWidth
                if (at + rowWidth <= data.size) {
                    var cursor = at
                    fun field(width: Int, fallback: Int): Int {
                        if (width == 0) return fallback
                        var value = 0
                        repeat(width) { value = value * 256 + (data[cursor].toInt() and 0xff); cursor++ }
                        return value
                    }

                    val type = field(widths[0], 1)   // /W [0 …] means "type 1 throughout"
                    val second = field(widths[1], 0)
                    val third = field(widths[2], 0)

                    if (number !in map) {
                        when (type) {
                            1 -> map[number] = Entry.AtOffset(second, third)
                            2 -> map[number] = Entry.InObjectStream(second, third)
                            // type 0 is a free object and is deliberately not recorded.
                        }
                    }
                }
                number++
                row++
            }
            pair += 2
        }

        return (dictionary["Prev"] as? PdfValue.Integer)?.value
    }

    /** The raw bytes of a stream object, decompressed and un-predicted as /Filter says. */
    fun streamBytes(
        bytes: ByteArray,
        offset: Int,
        text: String,
        dictionary: Map<String, PdfValue>,
    ): ByteArray {
        val keyword = text.indexOf("stream")
        if (keyword < 0) throw PdfError.SaveFailed("xref: object is not a stream")

        var start = offset + keyword + "stream".length
        if (start < bytes.size && bytes[start] == '\r'.code.toByte()) start++
        if (start < bytes.size && bytes[start] == '\n'.code.toByte()) start++

        val length = (dictionary["Length"] as? PdfValue.Integer)?.value
        val end = if (length != null) {
            minOf(bytes.size, start + length)
        } else {
            // No /Length: scan for the terminator rather than guessing.
            val body = bytes.copyOfRange(start, minOf(bytes.size, start + (1 shl 22)))
                .toString(Charsets.ISO_8859_1)
            val stop = body.indexOf("endstream")
            if (stop < 0) bytes.size else start + stop
        }
        if (start > end) throw PdfError.SaveFailed("xref: negative stream length")
        val raw = bytes.copyOfRange(start, end)

        val filters = when (val filter = dictionary["Filter"]) {
            is PdfValue.Name -> listOf(filter.value)
            is PdfValue.Array -> filter.items.mapNotNull { (it as? PdfValue.Name)?.value }
            else -> emptyList()
        }
        if (filters.isEmpty()) return raw
        if (!filters.all { it == "FlateDecode" }) {
            throw PdfError.SaveFailed("xref: unsupported stream filter ${filters.joinToString(",")}")
        }

        val inflated = Flate.inflate(raw)
        val params = (dictionary["DecodeParms"] as? PdfValue.Dictionary)?.entries ?: return inflated
        fun parameter(key: String, fallback: Int) =
            (params.firstOrNull { it.first == key }?.second as? PdfValue.Integer)?.value ?: fallback

        val predictor = parameter("Predictor", 1)
        if (predictor <= 1) return inflated
        return Flate.undoPredictor(
            inflated, predictor,
            columns = parameter("Columns", 1),
            colors = parameter("Colors", 1),
            bitsPerComponent = parameter("BitsPerComponent", 8),
        )
    }

    private fun findStartXref(bytes: ByteArray): Int {
        val tail = bytes.copyOfRange(maxOf(0, bytes.size - 2048), bytes.size)
            .toString(Charsets.ISO_8859_1)
        val offset = Regex("""startxref\s+(\d+)""").findAll(tail).lastOrNull()
            ?.groupValues?.get(1)?.toIntOrNull()
            ?: throw PdfError.SaveFailed("xref: no startxref")
        if (offset <= 0 || offset >= bytes.size) {
            throw PdfError.SaveFailed("xref: startxref $offset out of range")
        }
        return offset
    }

    private val SECTION_START = Regex("""\bxref\b|\d+\s+\d+\s+obj""")
}
