package com.pdfcora.cms

import java.io.ByteArrayOutputStream

/**
 * Writing DER.
 *
 * Only what building a CMS and embedding a timestamp need. Kept separate from [Der],
 * which stays read-only. Nothing here parses.
 */
internal object DerEncode {

    const val BOOLEAN = 0x01
    const val INTEGER = 0x02
    const val OCTET_STRING = 0x04
    const val OID = 0x06
    const val SEQUENCE = 0x30
    const val SET = 0x31
    const val CONTEXT_0 = 0xa0
    const val CONTEXT_1 = 0xa1

    /** One tag-length-value triple, using the shortest legal length form. */
    fun tlv(tag: Int, content: ByteArray): ByteArray {
        val out = ByteArrayOutputStream()
        out.write(tag)
        out.write(length(content.size))
        out.write(content)
        return out.toByteArray()
    }

    private fun length(value: Int): ByteArray {
        if (value < 0x80) return byteArrayOf(value.toByte())

        val octets = mutableListOf<Byte>()
        var remaining = value
        while (remaining > 0) {
            octets.add(0, (remaining % 256).toByte())
            remaining /= 256
        }
        // DER requires the minimum number of octets, which building from the value gives.
        return byteArrayOf((0x80 or octets.size).toByte()) + octets.toByteArray()
    }

    fun sequence(vararg parts: ByteArray): ByteArray = tlv(SEQUENCE, concat(parts))
    fun set(vararg parts: ByteArray): ByteArray = tlv(SET, concat(parts))
    fun octetString(bytes: ByteArray): ByteArray = tlv(OCTET_STRING, bytes)
    fun boolean(value: Boolean): ByteArray =
        tlv(BOOLEAN, byteArrayOf(if (value) 0xff.toByte() else 0x00))

    /** A non-negative INTEGER, with the leading zero DER requires when the top bit is set. */
    fun integer(value: Int): ByteArray {
        require(value >= 0) { "negative integers are not supported" }
        val bytes = mutableListOf<Byte>()
        var remaining = value
        do {
            bytes.add(0, (remaining % 256).toByte())
            remaining /= 256
        } while (remaining > 0)
        if (bytes[0].toInt() and 0x80 != 0) bytes.add(0, 0)
        return tlv(INTEGER, bytes.toByteArray())
    }

    fun integer(value: ByteArray): ByteArray {
        val bytes = value.dropWhile { it == 0.toByte() }.toMutableList()
        if (bytes.isEmpty()) bytes.add(0)
        if (bytes[0].toInt() and 0x80 != 0) bytes.add(0, 0)
        return tlv(INTEGER, bytes.toByteArray())
    }

    /** A dotted OID, packing the first two arcs as `40 * first + second`. */
    fun oid(dotted: String): ByteArray {
        val arcs = dotted.split(".").map { it.toInt() }
        require(arcs.size >= 2) { "bad OID $dotted" }

        val bytes = mutableListOf((arcs[0] * 40 + arcs[1]).toByte())
        for (arc in arcs.drop(2)) {
            val septets = mutableListOf<Int>()
            var remaining = arc
            do {
                septets.add(0, remaining and 0x7f)
                remaining = remaining shr 7
            } while (remaining > 0)
            for (i in 0 until septets.size - 1) septets[i] = septets[i] or 0x80
            septets.forEach { bytes.add(it.toByte()) }
        }
        return tlv(OID, bytes.toByteArray())
    }

    private fun concat(parts: Array<out ByteArray>): ByteArray {
        val out = ByteArrayOutputStream()
        parts.forEach { out.write(it) }
        return out.toByteArray()
    }
}
