package com.pdfcora.cms

/**
 * Just enough DER to walk a PKCS#7 SignedData.
 *
 * This runs on untrusted input — a signature blob out of an arbitrary PDF — so malformed
 * data is the expected case, not the exceptional one. Every read bounds-checks before it
 * indexes, and anything it cannot make sense of throws rather than returning a guess.
 *
 * Deliberately narrow: no encoding, no schema, no types beyond the handful the CMS walk
 * needs. It is not a general ASN.1 library and should not become one.
 */
internal object Der {

    class Failure(reason: String) : Exception("DER: $reason")

    data class Tlv(
        /** Identifier octet, e.g. 0x30 SEQUENCE, 0x31 SET, 0xa0 [0] constructed. */
        val tag: Int,
        /** Offset of the identifier octet, so the whole encoding can be taken verbatim. */
        val start: Int,
        val length: Int,
        val contentStart: Int,
        val contentEnd: Int,
    ) {
        val end: Int get() = contentEnd
    }

    fun isConstructed(tag: Int): Boolean = tag and 0x20 != 0

    fun readTlv(bytes: ByteArray, offset: Int): Tlv {
        if (offset < 0 || offset >= bytes.size) {
            throw Failure("truncated: no tag at offset $offset")
        }

        var cursor = offset
        val tag = bytes[cursor].toInt() and 0xff
        cursor++

        // High-tag-number form: the low five bits are all set and the number continues
        // in following octets. Nothing in CMS uses it, so it is refused rather than
        // half-read.
        if (tag and 0x1f == 0x1f) throw Failure("high-tag-number form is not supported")
        if (cursor >= bytes.size) throw Failure("truncated: no length octet")

        val first = bytes[cursor].toInt() and 0xff
        cursor++

        val length: Int
        when {
            first < 0x80 -> length = first
            // Permitted in BER, forbidden in DER. Accepting it would mean scanning for an
            // end-of-contents marker, which is exactly the unbounded read to avoid.
            first == 0x80 -> throw Failure("indefinite length is not valid DER")
            else -> {
                val count = first and 0x7f
                if (count > 4) throw Failure("length of $count octets is implausible")
                if (cursor + count > bytes.size) throw Failure("truncated: length octets")
                var value = 0
                repeat(count) {
                    value = value * 256 + (bytes[cursor].toInt() and 0xff)
                    cursor++
                }
                length = value
            }
        }

        val contentEnd = cursor + length
        if (contentEnd > bytes.size) {
            throw Failure("truncated: value of $length bytes runs past the buffer")
        }
        return Tlv(tag, offset, length, cursor, contentEnd)
    }

    /** The immediate children of a constructed value; empty for a primitive one. */
    fun children(bytes: ByteArray, tlv: Tlv): List<Tlv> {
        if (!isConstructed(tlv.tag)) return emptyList()

        val out = mutableListOf<Tlv>()
        var cursor = tlv.contentStart
        while (cursor < tlv.contentEnd) {
            val child = readTlv(bytes, cursor)
            if (child.end > tlv.contentEnd) throw Failure("child runs past its parent")
            if (child.end <= cursor) throw Failure("zero-width child would not terminate")
            out += child
            cursor = child.end
        }
        return out
    }

    /**
     * Decodes an OBJECT IDENTIFIER to dotted form.
     *
     * The first octet packs two arcs as `40 * first + second`, which is why 1.2 and 2.16
     * encode so differently — the second arc is unbounded once the first is 2.
     */
    fun readOid(bytes: ByteArray, tlv: Tlv): String {
        if (tlv.length == 0) throw Failure("empty OID")

        val arcs = mutableListOf<Int>()
        var value = 0
        var started = false

        for (i in tlv.contentStart until tlv.contentEnd) {
            val byte = bytes[i].toInt() and 0xff
            value = value * 128 + (byte and 0x7f)
            if (byte and 0x80 != 0) continue

            if (!started) {
                val first = minOf(value / 40, 2)
                arcs += first
                arcs += value - first * 40
                started = true
            } else {
                arcs += value
            }
            value = 0
        }

        if (value != 0) throw Failure("OID ends mid-arc")
        return arcs.joinToString(".")
    }

    /** INTEGER as unsigned big-endian bytes, since certificate serials exceed 64 bits. */
    fun readIntegerBytes(bytes: ByteArray, tlv: Tlv): ByteArray {
        if (tlv.length == 0) throw Failure("empty INTEGER")
        var value = bytes.copyOfRange(tlv.contentStart, tlv.contentEnd)
        // DER prefixes a zero octet when the high bit would otherwise mean negative.
        var from = 0
        while (from < value.size - 1 && value[from] == 0.toByte()) from++
        if (from > 0) value = value.copyOfRange(from, value.size)
        return value
    }

    fun content(bytes: ByteArray, tlv: Tlv): ByteArray =
        bytes.copyOfRange(tlv.contentStart, tlv.contentEnd)

    /** The whole triple including tag and length, which is what signatures cover. */
    fun encoding(bytes: ByteArray, tlv: Tlv): ByteArray = bytes.copyOfRange(tlv.start, tlv.end)
}
