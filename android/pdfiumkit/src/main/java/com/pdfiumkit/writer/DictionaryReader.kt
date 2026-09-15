package com.pdfiumkit.writer

import com.pdfiumkit.PdfError

/**
 * A minimal dictionary reader.
 *
 * It understands the value forms that appear in a trailer — numbers, names, references,
 * arrays, strings and nested dictionaries — and preserves nothing else, because nothing
 * else is carried forward into the update.
 */
internal class PdfDictionaryReader(private val text: String) {

    fun read(start: Int): Map<String, PdfValue> = readDictionary(start).first

    private fun readDictionary(start: Int): Pair<Map<String, PdfValue>, Int> {
        if (at(start) != '<' || at(start + 1) != '<') {
            throw PdfError.SaveFailed("expected a dictionary")
        }
        val result = LinkedHashMap<String, PdfValue>()
        var i = skipSpace(start + 2)

        while (true) {
            if (at(i) == '>' && at(i + 1) == '>') return result to i + 2
            if (i >= text.length) throw PdfError.SaveFailed("unterminated dictionary")
            if (at(i) != '/') throw PdfError.SaveFailed("expected a key at $i")

            val keyEnd = endOfToken(i + 1)
            val key = decodeName(text.substring(i + 1, keyEnd))
            val (value, next) = readValue(skipSpace(keyEnd))
            result[key] = value
            i = skipSpace(next)
        }
    }

    private fun readValue(start: Int): Pair<PdfValue, Int> {
        val i = skipSpace(start)
        when {
            at(i) == '<' && at(i + 1) == '<' -> {
                val (map, next) = readDictionary(i)
                return PdfValue.Dictionary(map.toList()) to next
            }
            at(i) == '<' -> {
                var end = i
                while (end < text.length && text[end] != '>') end++
                val digits = text.substring(i + 1, end).filter { it.isDigit() || it in "abcdefABCDEF" }
                return PdfValue.HexString(digits.hexToBytes()) to end + 1
            }
            at(i) == '[' -> {
                val items = mutableListOf<PdfValue>()
                var j = skipSpace(i + 1)
                while (true) {
                    if (at(j) == ']') return PdfValue.Array(items) to j + 1
                    if (j >= text.length) throw PdfError.SaveFailed("unterminated array")
                    val (item, next) = readValue(j)
                    items += item
                    j = skipSpace(next)
                }
            }
            at(i) == '(' -> return readLiteralString(i)
            at(i) == '/' -> {
                val end = endOfToken(i + 1)
                return PdfValue.Name(decodeName(text.substring(i + 1, end))) to end
            }
        }

        // "12 0 R" is a reference; "12 0" on its own is two numbers. Only the
        // three-token form may be consumed here, or array elements get swallowed.
        REFERENCE.matchAt(text, i)?.let {
            return PdfValue.Reference(
                it.groupValues[1].toInt(),
                it.groupValues[2].toInt(),
            ) to i + it.value.length
        }

        val end = endOfToken(i)
        val token = text.substring(i, end)
        return when {
            token == "true" -> PdfValue.Bool(true) to end
            token == "false" -> PdfValue.Bool(false) to end
            token == "null" -> PdfValue.Null to end
            token.toIntOrNull() != null -> PdfValue.Integer(token.toInt()) to end
            token.toDoubleOrNull() != null -> PdfValue.Real(token.toDouble()) to end
            else -> throw PdfError.SaveFailed("unrecognised token \"$token\"")
        }
    }

    private fun readLiteralString(start: Int): Pair<PdfValue, Int> {
        var depth = 0
        var j = start
        while (j < text.length) {
            val c = text[j]
            if (c == BACKSLASH) { j += 2; continue }
            if (c == '(') depth++
            if (c == ')') {
                depth--
                if (depth == 0) { j++; break }
            }
            j++
        }
        // Kept as written, escapes and all: decoding and re-encoding would change the bytes
        // of any string a rewritten object carries forward.
        val end = minOf(j, text.length)
        return PdfValue.Raw(text.substring(start, end).toByteArray(Charsets.ISO_8859_1)) to end
    }

    private fun at(index: Int): Char? = text.getOrNull(index)

    private fun skipSpace(start: Int): Int {
        var i = start
        while (true) {
            while (i < text.length && (text[i].isWhitespace() || text[i] == NUL)) i++
            if (at(i) != '%') return i          // comments run to end of line
            while (i < text.length && text[i] != LF && text[i] != CR) i++
        }
    }

    private fun endOfToken(start: Int): Int {
        var i = start
        while (i < text.length && !text[i].isWhitespace() && text[i] !in DELIMITERS) i++
        return i
    }

    private fun decodeName(value: String): String = buildString {
        var i = 0
        while (i < value.length) {
            val code = if (value[i] == '#' && i + 2 < value.length) {
                value.substring(i + 1, i + 3).toIntOrNull(16)
            } else {
                null
            }
            if (code != null) {
                append(code.toChar()); i += 3
            } else {
                append(value[i]); i++
            }
        }
    }

    private fun String.hexToBytes(): ByteArray {
        val digits = if (length % 2 == 1) this + "0" else this
        return ByteArray(digits.length / 2) {
            digits.substring(it * 2, it * 2 + 2).toInt(16).toByte()
        }
    }

    private companion object {
        val REFERENCE = Regex("""(\d+)\s+(\d+)\s+R\b""")
        const val DELIMITERS = "()<>[]{}/%"
        const val BACKSLASH = '\u005C'
        const val NUL = '\u0000'
        const val LF = '\u000A'
        const val CR = '\u000D'
    }
}
