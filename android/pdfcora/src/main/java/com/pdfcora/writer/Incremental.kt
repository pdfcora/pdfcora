package com.pdfcora.writer

import java.io.ByteArrayOutputStream

/**
 * Appending an incremental update.
 *
 * The original bytes are never touched: new and replaced objects are written after them,
 * followed by a cross-reference section listing only what changed and a trailer whose
 * /Prev points at the previous section. A reader that follows the chain sees the new
 * objects; the old file is intact underneath, which is what lets an earlier signature
 * keep verifying.
 */
object PdfWriter {

    private const val LF = '\u000A'.code.toByte()
    private const val CR = '\u000D'.code.toByte()

    fun appendUpdate(
        base: ByteArray,
        objects: Map<Int, PdfValue>,
        trailer: List<Pair<String, PdfValue>> = emptyList(),
    ): ByteArray {
        val info = TrailerInfo.scan(base)
        val out = ByteArrayOutputStream()
        out.write(base)
        var offset = base.size

        // A generating application may omit the final newline; without one the first
        // appended object would run into %%EOF.
        if (base.isNotEmpty() && base.last() != LF && base.last() != CR) {
            out.write(LF.toInt())
            offset += 1
        }

        val positions = LinkedHashMap<Int, Int>()
        for (number in objects.keys.sorted()) {
            positions[number] = offset
            val bytes = PdfValue.serialize(objects.getValue(number), number)
            out.write(bytes)
            offset += bytes.size
        }

        val highest = positions.keys.maxOrNull() ?: (info.size - 1)
        val size = maxOf(info.size, highest + 1)

        out.write(
            if (info.style == XrefStyle.TABLE) {
                xrefTable(positions, size, info, offset, trailer)
            } else {
                xrefStream(positions, size, info, offset, trailer)
            }
        )
        return out.toByteArray()
    }

    private fun trailerEntries(
        size: Int,
        info: TrailerInfo,
        extra: List<Pair<String, PdfValue>>,
    ): List<Pair<String, PdfValue>> {
        val entries = mutableListOf(
            "Size" to PdfValue.Integer(size),
            "Root" to info.root,
            "Prev" to PdfValue.Integer(info.startXref),
        )
        info.info?.let { entries += "Info" to it }
        info.id?.let { entries += "ID" to it }
        val overridden = extra.map { it.first }.toSet()
        return entries.filterNot { it.first in overridden } + extra
    }

    /**
     * Classic cross-reference table. Entries are grouped into runs of consecutive object
     * numbers, and each line is exactly 20 bytes.
     */
    private fun xrefTable(
        positions: Map<Int, Int>,
        size: Int,
        info: TrailerInfo,
        xrefOffset: Int,
        extra: List<Pair<String, PdfValue>>,
    ): ByteArray {
        val numbers = positions.keys.sorted()
        val table = StringBuilder("xref\n")
        var i = 0
        while (i < numbers.size) {
            var end = i + 1
            while (end < numbers.size && numbers[end] == numbers[end - 1] + 1) end++
            table.append("${numbers[i]} ${end - i}\n")
            for (j in i until end) {
                table.append("%010d 00000 n \n".format(positions.getValue(numbers[j])))
            }
            i = end
        }

        val out = ByteArrayOutputStream()
        out.write(latin1(table.toString()))
        out.write(latin1("trailer\n"))
        out.write(PdfValue.serialize(PdfValue.Dictionary(trailerEntries(size, info, extra))))
        out.write(latin1("\nstartxref\n$xrefOffset\n%%EOF\n"))
        return out.toByteArray()
    }

    /**
     * Cross-reference stream, for files written that way. The stream is its own object,
     * so it occupies a number and appears in its own table. Fields are uncompressed —
     * /Filter is omitted — because the saving is irrelevant for a handful of entries and
     * an undecodable stream is a much worse failure than a large one.
     */
    private fun xrefStream(
        positions: Map<Int, Int>,
        size: Int,
        info: TrailerInfo,
        xrefOffset: Int,
        extra: List<Pair<String, PdfValue>>,
    ): ByteArray {
        val streamNumber = size
        val all = LinkedHashMap(positions).apply { put(streamNumber, xrefOffset) }
        val numbers = all.keys.sorted()

        val index = mutableListOf<PdfValue>()
        val body = ByteArrayOutputStream()
        var i = 0
        while (i < numbers.size) {
            var end = i + 1
            while (end < numbers.size && numbers[end] == numbers[end - 1] + 1) end++
            index += PdfValue.Integer(numbers[i])
            index += PdfValue.Integer(end - i)
            for (j in i until end) {
                val position = all.getValue(numbers[j])
                // /W [1 4 2]: type, a four-byte offset, a two-byte generation.
                body.write(1)
                body.write((position shr 24) and 0xff)
                body.write((position shr 16) and 0xff)
                body.write((position shr 8) and 0xff)
                body.write(position and 0xff)
                body.write(0)
                body.write(0)
            }
            i = end
        }

        val bodyBytes = body.toByteArray()
        val dictionary = trailerEntries(streamNumber + 1, info, extra) + listOf(
            "Type" to PdfValue.Name("XRef"),
            "W" to PdfValue.Array(
                listOf(PdfValue.Integer(1), PdfValue.Integer(4), PdfValue.Integer(2)),
            ),
            "Index" to PdfValue.Array(index),
            "Length" to PdfValue.Integer(bodyBytes.size),
        )

        val out = ByteArrayOutputStream()
        out.write(latin1("$streamNumber 0 obj\n"))
        out.write(PdfValue.serialize(PdfValue.Dictionary(dictionary)))
        out.write(latin1("\nstream\n"))
        out.write(bodyBytes)
        out.write(latin1("\nendstream\nendobj\n"))
        out.write(latin1("startxref\n$xrefOffset\n%%EOF\n"))
        return out.toByteArray()
    }
}
