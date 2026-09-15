package com.pdfiumkit.writer

import com.pdfiumkit.PdfError

/**
 * Reading existing objects out of a document.
 *
 * Signing must merge /AcroForm into the Catalog and a widget into a page's /Annots.
 * Replacing either without reading it first would discard everything else it holds.
 *
 * Only dictionaries are modelled. Stream bodies are located but not returned, because
 * nothing that rewrites an object needs to reconstruct one.
 */
internal object PdfReader {

    /** How far past an object header to look for its dictionary. */
    private const val WINDOW = 1 shl 20

    fun obj(bytes: ByteArray, xref: Map<Int, Xref.Entry>, number: Int): PdfValue? =
        when (val entry = xref[number]) {
            is Xref.Entry.AtOffset -> atOffset(bytes, entry.offset, number)
            is Xref.Entry.InObjectStream -> fromObjectStream(bytes, xref, entry.stream, entry.index)
            null -> null
        }

    /** `N G obj … endobj` at a known offset. */
    private fun atOffset(bytes: ByteArray, offset: Int, number: Int): PdfValue? {
        if (offset <= 0 || offset >= bytes.size) return null
        val text = bytes.copyOfRange(offset, minOf(bytes.size, offset + WINDOW))
            .toString(Charsets.ISO_8859_1)

        val header = OBJECT_HEADER.find(text) ?: return null
        // A wrong offset points at something that is not this object. Returning null is
        // right: a caller that then wrote a replacement would corrupt the file.
        if (header.range.first != 0 || header.groupValues[1].toIntOrNull() != number) return null

        // Dictionaries and arrays are modelled; a number or string here must not be mistaken for
        // the next object's dictionary.
        val at = (header.range.last + 1 until text.length).firstOrNull { !text[it].isWhitespace() } ?: return null
        if (!text.startsWith("<<", at) && text[at] != '[') return null
        return runCatching { PdfDictionaryReader(text).readContainer(at) }.getOrNull()
    }

    /**
     * An object inside a compressed object stream.
     *
     * The stream begins with /N pairs of "object number, offset", after which /First
     * marks where the objects themselves start.
     */
    private fun fromObjectStream(
        bytes: ByteArray,
        xref: Map<Int, Xref.Entry>,
        streamNumber: Int,
        index: Int,
    ): PdfValue? {
        val entry = xref[streamNumber] as? Xref.Entry.AtOffset ?: return null
        val text = bytes.copyOfRange(entry.offset, minOf(bytes.size, entry.offset + WINDOW))
            .toString(Charsets.ISO_8859_1)
        val dictAt = text.indexOf("<<")
        if (dictAt < 0) return null

        val dictionary = runCatching { PdfDictionaryReader(text).read(dictAt) }.getOrNull() ?: return null
        val count = (dictionary["N"] as? PdfValue.Integer)?.value ?: return null
        val first = (dictionary["First"] as? PdfValue.Integer)?.value ?: return null
        if (index >= count) return null

        val data = runCatching { Xref.streamBytes(bytes, entry.offset, text, dictionary) }
            .getOrNull() ?: return null

        val header = data.copyOfRange(0, minOf(first, data.size)).toString(Charsets.ISO_8859_1)
        val numbers = header.trim().split(Regex("""\s+""")).mapNotNull { it.toIntOrNull() }
        // Pairs, so the offset of entry `index` is at 2 * index + 1.
        if (numbers.size <= index * 2 + 1) return null
        val start = first + numbers[index * 2 + 1]
        if (start >= data.size) return null

        val body = data.copyOfRange(start, data.size).toString(Charsets.ISO_8859_1)
        val at = body.indices.firstOrNull { !body[it].isWhitespace() } ?: return null
        if (!body.startsWith("<<", at) && body[at] != '[') return null
        return runCatching { PdfDictionaryReader(body).readContainer(at) }.getOrNull()
    }

    /** The document Catalog, with the object number so it can be rewritten. */
    fun catalog(bytes: ByteArray): Pair<Int, PdfValue> {
        val xref = Xref.build(bytes)
        val number = catalogNumber(bytes, xref)
            ?: throw PdfError.SaveFailed("read: no /Root and no object claims to be a Catalog")
        val value = obj(bytes, xref, number)
            ?: throw PdfError.SaveFailed("read: catalog object $number is unreadable")
        return number to value
    }

    private fun catalogNumber(bytes: ByteArray, xref: Map<Int, Xref.Entry>): Int? {
        // The trailer's /Root is authoritative; the newest occurrence wins.
        val whole = bytes.toString(Charsets.ISO_8859_1)
        ROOT_REF.findAll(whole).lastOrNull()?.groupValues?.get(1)?.toIntOrNull()?.let { return it }

        // Some malformed files have no usable /Root. Finding the object that calls itself
        // a Catalog is a last resort, and better than failing outright.
        return xref.keys.sorted().firstOrNull { number ->
            isName(entry(obj(bytes, xref, number), "Type"), "Catalog")
        }
    }

    /** The object numbers of the document's pages, in page order. */
    fun pages(bytes: ByteArray, xref: Map<Int, Xref.Entry>, catalog: PdfValue): List<Int> {
        val pages = mutableListOf<Int>()
        val seen = mutableSetOf<Int>()
        fun visit(number: Int, depth: Int) {
            if (depth > 32 || !seen.add(number)) return          // malformed trees can cycle
            val node = obj(bytes, xref, number) ?: return
            if (isName(entry(node, "Type"), "Page")) { pages += number; return }
            val kids = (entry(node, "Kids") as? PdfValue.Array)?.items ?: return
            for (kid in kids) (kid as? PdfValue.Reference)?.let { visit(it.number, depth + 1) }
        }
        reference(catalog, "Pages")?.let { visit(it, 0) }
        return pages
    }

    /** The object number a dictionary's [key] refers to, when it is a reference. */
    fun reference(value: PdfValue?, key: String): Int? =
        (entry(value, key) as? PdfValue.Reference)?.number

    fun entry(value: PdfValue?, key: String): PdfValue? =
        (value as? PdfValue.Dictionary)?.entries?.firstOrNull { it.first == key }?.second

    fun isName(value: PdfValue?, expected: String): Boolean =
        (value as? PdfValue.Name)?.value == expected

    private val OBJECT_HEADER = Regex("""^\s*(\d+)\s+(\d+)\s+obj\b""")
    private val ROOT_REF = Regex("""/Root\s+(\d+)\s+(\d+)\s+R""")
}
