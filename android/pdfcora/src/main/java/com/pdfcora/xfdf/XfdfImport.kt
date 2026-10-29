package com.pdfcora.xfdf

import com.pdfcora.Native
import com.pdfcora.PdfColor
import com.pdfcora.PdfDocument
import com.pdfcora.PdfError
import com.pdfcora.PdfFormField
import com.pdfcora.PdfPage
import com.pdfcora.PdfPoint
import com.pdfcora.PdfQuad
import com.pdfcora.PdfRect
import com.pdfcora.addHighlight
import com.pdfcora.addInk
import com.pdfcora.addNote
import com.pdfcora.addStrikeout
import com.pdfcora.addUnderline
import com.pdfcora.formFields
import com.pdfcora.setChecked
import com.pdfcora.setOption
import com.pdfcora.setText
import kotlin.math.roundToInt

enum class PdfXfdfSkipReason(val wire: String) {
    UNSUPPORTED_TYPE("unsupportedType"), UNKNOWN_FIELD("unknownField"), READ_ONLY_FIELD("readOnlyField"),
    INVALID_VALUE("invalidValue"), PAGE_OUT_OF_RANGE("pageOutOfRange"), MISSING_ATTRIBUTE("missingAttribute"),
    WRITE_FAILED("writeFailed");

    companion object {
        fun fromWire(wire: String): PdfXfdfSkipReason = entries.first { it.wire == wire }
    }
}

/** An XFDF element import did not apply, and why. [element] is the XFDF element name, e.g. `field`. */
data class PdfXfdfSkip(val element: String, val page: Int?, val reason: PdfXfdfSkipReason)

/** What `importXfdf` applied. Skipped entries are in the order they appear in the XFDF. */
data class PdfXfdfReport(val fieldsSet: Int, val annotationsAdded: Int, val skipped: List<PdfXfdfSkip>)

private val SUPPORTED = setOf("ink", "text", "highlight", "underline", "strikeout")

private fun collectFields(element: XfdfElement, prefix: String, out: MutableList<Pair<String, List<String>>>) {
    for (child in element.children.filter { it.name == "field" }) {
        val part = child.attributes["name"] ?: ""
        val name = if (prefix.isEmpty()) part else "$prefix.$part"
        val values = child.children.filter { it.name == "value" }.map { it.text.toString() }
        if (values.isNotEmpty()) out += name to values
        collectFields(child, name, out)
    }
}

private fun numbers(text: String?): List<Float>? {
    if (text == null) return null
    val parts = text.split(',', ';', ' ', '\t', '\n', '\r').filter { it.isNotEmpty() }.map { it.toFloatOrNull() }
    return if (parts.isNotEmpty() && parts.all { it != null && it.isFinite() }) parts.map { it!! } else null
}

private fun colorOf(attributes: Map<String, String>): PdfColor? {
    val text = attributes["color"] ?: return null
    if (!Regex("^#[0-9a-fA-F]{6}$").matches(text)) return null
    val v = text.substring(1).toInt(16)
    val opacity = attributes["opacity"]?.toDoubleOrNull()?.takeIf { it.isFinite() } ?: 1.0
    return PdfColor((v shr 16) and 255, (v shr 8) and 255, v and 255, (opacity.coerceIn(0.0, 1.0) * 255).roundToInt())
}

/**
 * Sets one XFDF field on every widget with its name. Everything is checked before the first
 * write, so a value no widget can take changes nothing; null when set.
 */
private suspend fun setField(widgets: List<Pair<PdfPage, PdfFormField>>, values: List<String>): PdfXfdfSkipReason? {
    if (widgets.any { it.second.base.isReadOnly }) return PdfXfdfSkipReason.READ_ONLY_FIELD
    val first = widgets.first().second
    if (widgets.any { it.second::class != first::class }) return PdfXfdfSkipReason.INVALID_VALUE
    val value = values.firstOrNull() ?: ""
    fun exportOf(f: PdfFormField) = when (f) {
        is PdfFormField.CheckBox -> f.exportValue
        is PdfFormField.RadioButton -> f.exportValue
        else -> null
    }

    val writes: List<suspend () -> Unit> = when (first) {
        is PdfFormField.Text -> widgets.map { (page, f) -> suspend { page.setText(value, f.base.annotationIndex) } }
        is PdfFormField.CheckBox -> {
            // Check boxes sharing a name each carry their own export value; the value turns on
            // the ones it names and off the rest.
            fun on(f: PdfFormField) = value == (exportOf(f) ?: "Yes") || (exportOf(f) == null && value == "On")
            if (value != "Off" && widgets.none { on(it.second) }) return PdfXfdfSkipReason.INVALID_VALUE
            widgets.map { (page, f) -> suspend { page.setChecked(value != "Off" && on(f), f.base.annotationIndex) } }
        }
        is PdfFormField.RadioButton -> if (value == "Off") {
            widgets.map { (page, f) -> suspend { page.setChecked(false, f.base.annotationIndex) } }
        } else {
            val (page, f) = widgets.firstOrNull { exportOf(it.second) == value } ?: return PdfXfdfSkipReason.INVALID_VALUE
            listOf(suspend { page.setChecked(true, f.base.annotationIndex) })
        }
        is PdfFormField.ComboBox -> {
            if (values.any { it !in first.options }) return PdfXfdfSkipReason.INVALID_VALUE
            widgets.map { (page, f) -> suspend { page.setOption(first.options.indexOf(value), true, f.base.annotationIndex) } }
        }
        is PdfFormField.ListBox -> {
            if (values.any { it !in first.options }) return PdfXfdfSkipReason.INVALID_VALUE
            widgets.flatMap { (page, f) ->
                first.options.mapIndexed { i, option -> suspend { page.setOption(i, option in values, f.base.annotationIndex) } }
            }
        }
        else -> return PdfXfdfSkipReason.INVALID_VALUE
    }
    try {
        for (write in writes) write()
    } catch (e: Exception) {
        return PdfXfdfSkipReason.WRITE_FAILED
    }
    return null
}

private suspend fun addAnnotation(document: PdfDocument, pageCount: Int, element: XfdfElement): PdfXfdfSkip? {
    val a = element.attributes
    val page = a["page"]?.takeIf { it.isNotEmpty() && it.all(Char::isDigit) }?.toIntOrNull()
    fun skip(reason: PdfXfdfSkipReason) = PdfXfdfSkip(element.name, page, reason)

    if (element.name !in SUPPORTED) return skip(PdfXfdfSkipReason.UNSUPPORTED_TYPE)
    if (page == null) return skip(PdfXfdfSkipReason.MISSING_ATTRIBUTE)
    if (page >= pageCount) return skip(PdfXfdfSkipReason.PAGE_OUT_OF_RANGE)

    val color = colorOf(a)
    val contents = element.children.firstOrNull { it.name == "contents" }?.text?.toString()
    try {
        val target = document.page(page)
        val index = when (element.name) {
            "ink" -> {
                val gestures = element.children.firstOrNull { it.name == "inklist" }?.children?.filter { it.name == "gesture" }.orEmpty()
                val strokes = gestures.mapNotNull { numbers(it.text.toString()) }.filter { it.size >= 2 }
                    .map { n -> (0 until n.size / 2).map { PdfPoint(n[it * 2], n[it * 2 + 1]) } }
                if (strokes.isEmpty()) return skip(PdfXfdfSkipReason.MISSING_ATTRIBUTE)
                val width = a["width"]?.toFloatOrNull()?.takeIf { it.isFinite() && it > 0 } ?: 2f
                target.addInk(strokes, color ?: PdfColor.BLACK, width)
            }
            "text" -> {
                val r = numbers(a["rect"])?.takeIf { it.size == 4 } ?: return skip(PdfXfdfSkipReason.MISSING_ATTRIBUTE)
                target.addNote(PdfRect(r[0], r[1], r[2], r[3]), contents ?: "", color ?: PdfColor.YELLOW)
            }
            else -> {
                val c = numbers(a["coords"])?.takeIf { it.size >= 8 && it.size % 8 == 0 }
                    ?: return skip(PdfXfdfSkipReason.MISSING_ATTRIBUTE)
                val quads = (0 until c.size / 8).map { q ->
                    val v = q * 8
                    PdfQuad(PdfPoint(c[v], c[v + 1]), PdfPoint(c[v + 2], c[v + 3]), PdfPoint(c[v + 4], c[v + 5]), PdfPoint(c[v + 6], c[v + 7]))
                }
                when (element.name) {
                    "highlight" -> if (color != null) target.addHighlight(quads, color) else target.addHighlight(quads)
                    "underline" -> if (color != null) target.addUnderline(quads, color) else target.addUnderline(quads)
                    else -> if (color != null) target.addStrikeout(quads, color) else target.addStrikeout(quads)
                }
            }
        }
        val strings = mutableListOf("NM" to a["name"], "T" to a["title"], "M" to a["date"], "CreationDate" to a["creationdate"])
        if (element.name != "text") strings += "Contents" to contents
        val written = document.onDocument { h ->
            strings.all { (key, value) -> value == null || Native.setAnnotationString(h, page, index, key, value) }
        }
        if (!written) return skip(PdfXfdfSkipReason.WRITE_FAILED)
    } catch (e: PdfError) {
        return skip(PdfXfdfSkipReason.WRITE_FAILED)
    }
    return null
}

internal suspend fun importXfdf(document: PdfDocument, xml: String): PdfXfdfReport {
    val root = XfdfXml.parse(xml)
    if (root.name != "xfdf") throw PdfError.InvalidOperation("not valid XFDF: the root element is not <xfdf>")

    val fields = mutableListOf<Pair<String, List<String>>>()
    root.children.filter { it.name == "fields" }.forEach { collectFields(it, "", fields) }
    val annots = root.children.filter { it.name == "annots" }.flatMap { it.children }

    val skipped = mutableListOf<PdfXfdfSkip>()
    var fieldsSet = 0
    var annotationsAdded = 0
    val pageCount = document.pageCount()

    if (fields.isNotEmpty()) {
        val widgets = linkedMapOf<String, MutableList<Pair<PdfPage, PdfFormField>>>()
        for (i in 0 until pageCount) {
            val page = document.page(i)
            for (field in page.formFields()) field.base.name?.let { widgets.getOrPut(it) { mutableListOf() } += page to field }
        }
        for ((name, values) in fields) {
            val targets = widgets[name]
            val reason = if (targets == null) PdfXfdfSkipReason.UNKNOWN_FIELD else setField(targets, values)
            if (reason != null) skipped += PdfXfdfSkip("field", null, reason) else fieldsSet++
        }
    }
    val touched = mutableSetOf<Int>()
    for (element in annots) {
        val skip = addAnnotation(document, pageCount, element)
        if (skip != null) skipped += skip else { annotationsAdded++; element.attributes["page"]?.toIntOrNull()?.let { touched += it } }
    }
    // PDFium generates the new annotations' appearances (and, for ink, grows /Rect by half the
    // line width) when a page is next loaded, as it does for a reopened file; the page cache
    // would otherwise hide that until the document is reopened.
    if (touched.isNotEmpty()) document.onDocument { h -> touched.forEach { Native.releasePage(h, it) } }
    return PdfXfdfReport(fieldsSet, annotationsAdded, skipped)
}
