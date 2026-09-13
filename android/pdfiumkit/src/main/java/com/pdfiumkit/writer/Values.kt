package com.pdfiumkit.writer

/**
 * A PDF value, for writing only. Nothing here parses.
 *
 * PDFium cannot create dictionaries, so anything this SDK must write into a document —
 * a signature dictionary, a replacement /Info — is built here and appended as an
 * incremental update.
 */
sealed class PdfValue {
    object Null : PdfValue()
    data class Bool(val value: Boolean) : PdfValue()
    data class Integer(val value: Int) : PdfValue()
    data class Real(val value: Double) : PdfValue()
    data class Text(val value: String) : PdfValue()
    data class Name(val value: String) : PdfValue()
    data class HexString(val value: ByteArray) : PdfValue() {
        override fun equals(other: Any?) = other is HexString && value.contentEquals(other.value)
        override fun hashCode() = value.contentHashCode()
    }
    data class Reference(val number: Int, val generation: Int = 0) : PdfValue()
    data class Array(val items: List<PdfValue>) : PdfValue()
    /** Ordered: readers do not care, but stable output makes diffs and tests legible. */
    data class Dictionary(val entries: List<Pair<String, PdfValue>>) : PdfValue()
    /** Bytes written verbatim, for stream bodies, which are not PDF values. */
    data class Raw(val value: ByteArray) : PdfValue() {
        override fun equals(other: Any?) = other is Raw && value.contentEquals(other.value)
        override fun hashCode() = value.contentHashCode()
    }

    companion object {
        fun serialize(value: PdfValue, objectNumber: Int? = null, generation: Int = 0): ByteArray {
            val body = encode(value)
            if (objectNumber == null) return body
            return latin1("$objectNumber $generation obj\n") + body + latin1("\nendobj\n")
        }

        private fun encode(value: PdfValue): ByteArray = when (value) {
            is Null -> latin1("null")
            is Bool -> latin1(if (value.value) "true" else "false")
            is Integer -> latin1(value.value.toString())
            is Real -> {
                val rounded = Math.round(value.value * 1_000_000.0) / 1_000_000.0
                latin1(if (rounded == Math.floor(rounded)) rounded.toInt().toString() else rounded.toString())
            }
            is Text -> encodeString(value.value)
            is Name -> latin1(encodeName(value.value))
            is HexString -> latin1("<") + hex(value.value) + latin1(">")
            is Reference -> latin1("${value.number} ${value.generation} R")
            is Array -> {
                val out = java.io.ByteArrayOutputStream()
                out.write(latin1("["))
                value.items.forEachIndexed { i, item ->
                    if (i > 0) out.write(' '.code)
                    out.write(encode(item))
                }
                out.write(latin1("]"))
                out.toByteArray()
            }
            is Dictionary -> {
                val out = java.io.ByteArrayOutputStream()
                out.write(latin1("<<"))
                value.entries.forEachIndexed { i, (key, item) ->
                    if (i > 0) out.write(' '.code)
                    out.write(latin1(encodeName(key)))
                    out.write(' '.code)
                    out.write(encode(item))
                }
                out.write(latin1(">>"))
                out.toByteArray()
            }
            is Raw -> value.value
        }

        /** A name is terminated by whitespace or a delimiter, so those bytes are escaped. */
        private fun encodeName(value: String): String = buildString {
            append('/')
            for (c in value) {
                val safe = c.code in 0x21..0x7e && c !in "()<>[]{}/%#"
                if (safe) append(c) else append('#').append("%02X".format(c.code))
            }
        }

        private fun encodeString(value: String): ByteArray {
            // PDF text strings are PDFDocEncoding unless they open with a UTF-16BE byte
            // order mark. Rather than model PDFDocEncoding, anything outside ASCII takes
            // the BOM path.
            if (value.any { it.code > 0x7f }) {
                val out = java.io.ByteArrayOutputStream()
                out.write(0xfe); out.write(0xff)
                for (c in value) { out.write(c.code shr 8); out.write(c.code and 0xff) }
                return latin1("<") + hex(out.toByteArray()) + latin1(">")
            }
            val escaped = buildString {
                for (c in value) when (c) {
                    '\\' -> append("\\\\")
                    '(' -> append("\\(")
                    ')' -> append("\\)")
                    '\r' -> append("\\r")
                    '\n' -> append("\\n")
                    '\t' -> append("\\t")
                    else -> append(c)
                }
            }
            return latin1("($escaped)")
        }

        private val HEX_DIGITS = "0123456789ABCDEF".toByteArray(Charsets.ISO_8859_1)

        private fun hex(bytes: ByteArray): ByteArray {
            val out = ByteArray(bytes.size * 2)
            bytes.forEachIndexed { i, byte ->
                val value = byte.toInt() and 0xff
                out[i * 2] = HEX_DIGITS[value shr 4]
                out[i * 2 + 1] = HEX_DIGITS[value and 0x0f]
            }
            return out
        }
    }
}

internal fun latin1(value: String): ByteArray = value.toByteArray(Charsets.ISO_8859_1)
