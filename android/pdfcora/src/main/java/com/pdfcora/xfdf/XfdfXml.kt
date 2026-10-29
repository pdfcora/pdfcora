package com.pdfcora.xfdf

import com.pdfcora.PdfError
import org.xmlpull.v1.XmlPullParser
import org.xmlpull.v1.XmlPullParserFactory
import java.io.StringReader
import java.util.Locale

/** One element of an XFDF file: its attributes, child elements and the text directly inside. */
internal class XfdfElement(val name: String, val attributes: Map<String, String>) {
    val children = mutableListOf<XfdfElement>()
    val text = StringBuilder()
}

internal object XfdfXml {
    const val MAX_BYTES = 10 * 1024 * 1024

    private fun invalid(why: String) = PdfError.InvalidOperation("not valid XFDF: $why")

    /**
     * Parses XFDF with the platform's pull parser. Input from outside is untrusted, so a
     * DOCTYPE or entity declaration is refused before parsing and DOCDECL processing stays off.
     */
    fun parse(text: String): XfdfElement {
        if (text.toByteArray(Charsets.UTF_8).size > MAX_BYTES) throw invalid("larger than 10 MiB")
        if (text.contains("<!DOCTYPE") || text.contains("<!ENTITY")) {
            throw invalid("DOCTYPE and entity declarations are not allowed")
        }
        val parser = XmlPullParserFactory.newInstance().newPullParser()
        parser.setFeature(XmlPullParser.FEATURE_PROCESS_DOCDECL, false)
        parser.setFeature(XmlPullParser.FEATURE_PROCESS_NAMESPACES, false)
        parser.setInput(StringReader(text))
        val stack = ArrayDeque<XfdfElement>()
        var root: XfdfElement? = null
        try {
            var event = parser.eventType
            while (event != XmlPullParser.END_DOCUMENT) {
                when (event) {
                    XmlPullParser.START_TAG -> {
                        val attributes = (0 until parser.attributeCount)
                            .associate { parser.getAttributeName(it) to parser.getAttributeValue(it) }
                        val element = XfdfElement(parser.name, attributes)
                        val parent = stack.lastOrNull()
                        if (parent != null) parent.children += element
                        else if (root != null) throw invalid("more than one root element")
                        else root = element
                        stack.addLast(element)
                    }
                    XmlPullParser.END_TAG -> stack.removeLast()
                    XmlPullParser.TEXT, XmlPullParser.CDSECT -> stack.lastOrNull()?.text?.append(parser.text)
                    // The five predefined entities and character references resolve; anything
                    // else would need a DTD, which is refused.
                    XmlPullParser.ENTITY_REF ->
                        stack.lastOrNull()?.text?.append(parser.text ?: throw invalid("unknown entity &${parser.name};"))
                }
                event = parser.nextToken()
            }
        } catch (e: PdfError) {
            throw e
        } catch (e: Exception) {
            throw invalid(e.message ?: "malformed XML")
        }
        return root ?: throw invalid("no root element")
    }

    /** At most four decimals, no trailing zeros, no exponent, and never "-0". */
    fun format(value: Double): String {
        var text = String.format(Locale.ROOT, "%.4f", value).trimEnd('0').trimEnd('.')
        if (text == "-0") text = "0"
        return text
    }

    fun escapeAttribute(s: String): String = buildString {
        for (c in s) append(when (c) { '&' -> "&amp;"; '<' -> "&lt;"; '>' -> "&gt;"; '"' -> "&quot;"; '\'' -> "&apos;"; else -> c })
    }

    fun escapeText(s: String): String = buildString {
        for (c in s) append(when (c) { '&' -> "&amp;"; '<' -> "&lt;"; '>' -> "&gt;"; else -> c })
    }
}
