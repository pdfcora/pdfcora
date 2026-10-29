package com.pdfcora.xfdf

import com.pdfcora.Native
import com.pdfcora.PdfAnnotation
import com.pdfcora.PdfColor
import com.pdfcora.PdfDocument
import com.pdfcora.PdfFormField
import com.pdfcora.PdfPoint
import com.pdfcora.PdfSaveMode
import com.pdfcora.annotations
import com.pdfcora.formFields
import com.pdfcora.writer.PdfReader
import com.pdfcora.writer.PdfValue
import com.pdfcora.writer.Xref
import kotlin.math.roundToInt

/** What XFDF carries about an annotation that the public [PdfAnnotation] does not. */
internal data class XfdfAnnotationEntries(
    val name: String?, val title: String?, val modified: String?, val created: String?,
    val opacity: Double?, val borderWidth: Double?, val line: Pair<PdfPoint, PdfPoint>?,
    val defaultAppearance: String?, val icon: String?,
)

private val FLAG_NAMES = listOf("invisible", "hidden", "print", "nozoom", "norotate", "noview", "readonly", "locked",
    "togglenoview", "lockedcontents")

internal suspend fun readEntries(document: PdfDocument, pageIndex: Int, index: Int): XfdfAnnotationEntries =
    document.onDocument { h ->
        fun string(key: String) = Native.annotationString(h, pageIndex, index, key).ifEmpty { null }
        val n = Native.annotationXfdfNumbers(h, pageIndex, index)
        XfdfAnnotationEntries(
            name = string("NM"), title = string("T"), modified = string("M"), created = string("CreationDate"),
            opacity = if (n[0] != 0f) n[1].toDouble() else null,
            borderWidth = if (n[2] != 0f) n[3].toDouble() else null,
            line = if (n[4] != 0f) PdfPoint(n[5], n[6]) to PdfPoint(n[7], n[8]) else null,
            defaultAppearance = string("DA"), icon = string("Name"),
        )
    }

private class FieldNode(val name: String) {
    var values: List<String>? = null
    val children = mutableListOf<FieldNode>()
}

private fun fieldValues(widgets: List<PdfFormField>): List<String>? = when (val first = widgets.first()) {
    is PdfFormField.Text -> first.value.ifEmpty { null }?.let { listOf(it) }
    is PdfFormField.CheckBox, is PdfFormField.RadioButton -> {
        val on = widgets.firstNotNullOfOrNull {
            when (it) {
                is PdfFormField.CheckBox -> if (it.isChecked) it.exportValue ?: "Yes" else null
                is PdfFormField.RadioButton -> if (it.isChecked) it.exportValue ?: "Yes" else null
                else -> null
            }
        }
        listOf(on ?: "Off")
    }
    is PdfFormField.ComboBox -> first.value.ifEmpty { null }?.let { listOf(it) }
    is PdfFormField.ListBox -> first.selectedIndices.mapNotNull { first.options.getOrNull(it) }.ifEmpty { null }
    else -> null
}

private fun fieldTree(byName: Map<String, List<PdfFormField>>): List<FieldNode> {
    val roots = mutableListOf<FieldNode>()
    for ((fullName, widgets) in byName) {
        val values = fieldValues(widgets) ?: continue
        var level = roots
        var node: FieldNode? = null
        for (part in fullName.split('.')) {
            node = level.firstOrNull { it.name == part } ?: FieldNode(part).also { level += it }
            level = node.children
        }
        node?.values = values
    }
    return roots
}

private fun writeFields(nodes: List<FieldNode>, depth: Int, out: MutableList<String>) {
    val pad = "  ".repeat(depth)
    for (node in nodes) {
        out += "$pad<field name=\"${XfdfXml.escapeAttribute(node.name)}\">"
        for (value in node.values.orEmpty()) out += "$pad  <value>${XfdfXml.escapeText(value)}</value>"
        writeFields(node.children, depth + 1, out)
        out += "$pad</field>"
    }
}

private fun elementOf(a: PdfAnnotation): String? = when (a) {
    is PdfAnnotation.Highlight -> "highlight"
    is PdfAnnotation.Underline -> "underline"
    is PdfAnnotation.Strikeout -> "strikeout"
    is PdfAnnotation.Squiggly -> "squiggly"
    is PdfAnnotation.Ink -> "ink"
    is PdfAnnotation.Note -> "text"
    is PdfAnnotation.Square -> "square"
    is PdfAnnotation.Circle -> "circle"
    is PdfAnnotation.Line -> "line"
    is PdfAnnotation.FreeText -> "freetext"
    is PdfAnnotation.Stamp -> "stamp"
    is PdfAnnotation.FileAttachment -> "fileattachment"
    else -> null
}

private fun f(value: Float) = XfdfXml.format(value.toDouble())

private fun writeAnnotation(a: PdfAnnotation, element: String, e: XfdfAnnotationEntries, color: PdfColor?,
                            out: MutableList<String>) {
    val base = a.base
    val attrs = mutableListOf(
        "page" to base.pageIndex.toString(),
        "rect" to listOf(base.rect.left, base.rect.bottom, base.rect.right, base.rect.top).joinToString(",") { f(it) },
    )
    if (color != null) attrs += "color" to "#%02X%02X%02X".format(color.red, color.green, color.blue)
    e.opacity?.takeIf { it != 1.0 }?.let { attrs += "opacity" to XfdfXml.format(it) }
    val flags = FLAG_NAMES.filterIndexed { bit, _ -> base.flags and (1 shl bit) != 0 }
    if (flags.isNotEmpty()) attrs += "flags" to flags.joinToString(",")
    e.name?.let { attrs += "name" to it }
    e.title?.let { attrs += "title" to it }
    e.modified?.let { attrs += "date" to it }
    e.created?.let { attrs += "creationdate" to it }
    val quads = when (a) {
        is PdfAnnotation.Highlight -> a.quads
        is PdfAnnotation.Underline -> a.quads
        is PdfAnnotation.Strikeout -> a.quads
        is PdfAnnotation.Squiggly -> a.quads
        else -> null
    }
    if (quads != null) {
        attrs += "coords" to quads.flatMap { listOf(it.p1, it.p2, it.p3, it.p4) }.flatMap { listOf(f(it.x), f(it.y)) }.joinToString(",")
    }
    if (a is PdfAnnotation.Ink) e.borderWidth?.let { attrs += "width" to XfdfXml.format(it) }
    if (a is PdfAnnotation.Note) e.icon?.let { attrs += "icon" to it }
    if (a is PdfAnnotation.Line) e.line?.let { (start, end) ->
        attrs += "start" to "${f(start.x)},${f(start.y)}"
        attrs += "end" to "${f(end.x)},${f(end.y)}"
    }

    out += "    <$element " + attrs.joinToString(" ") { (k, v) -> "$k=\"${XfdfXml.escapeAttribute(v)}\"" } + ">"
    if (a is PdfAnnotation.Ink) {
        out += "      <inklist>"
        for (stroke in a.strokes) out += "        <gesture>" + stroke.joinToString(";") { "${f(it.x)},${f(it.y)}" } + "</gesture>"
        out += "      </inklist>"
    }
    base.contents?.let { out += "      <contents>${XfdfXml.escapeText(it)}</contents>" }
    if (a is PdfAnnotation.FreeText) e.defaultAppearance?.let {
        out += "      <defaultappearance>${XfdfXml.escapeText(it)}</defaultappearance>"
    }
    out += "    </$element>"
}

/**
 * Each annotation's `/C`, keyed `page:index`, from a full save. PDFium's `FPDFAnnot_GetColor`
 * refuses once an annotation has an appearance stream, which PDFium generates for most markup
 * when a page is loaded; `/Annots` order is the index PDFium uses.
 */
private suspend fun annotationColors(document: PdfDocument): Map<String, PdfColor> {
    val bytes = document.toByteArray(PdfSaveMode.FULL)
    val xref = Xref.build(bytes)
    val catalog = PdfReader.catalog(bytes).second
    val colors = mutableMapOf<String, PdfColor>()
    PdfReader.pages(bytes, xref, catalog).forEachIndexed { pageIndex, pageNumber ->
        val page = PdfReader.obj(bytes, xref, pageNumber) ?: return@forEachIndexed
        val annots = (PdfReader.entry(page, "Annots") as? PdfValue.Array)?.items
            ?: PdfReader.reference(page, "Annots")?.let { (PdfReader.obj(bytes, xref, it) as? PdfValue.Array)?.items }
            ?: emptyList()
        annots.forEachIndexed { index, entry ->
            val dictionary = (entry as? PdfValue.Reference)?.let { PdfReader.obj(bytes, xref, it.number) } ?: entry
            colorOf(PdfReader.entry(dictionary, "C"))?.let { colors["$pageIndex:$index"] = it }
        }
    }
    return colors
}

/** `/C` has 1 (grey), 3 (RGB) or 4 (CMYK) components; none means transparent. */
private fun colorOf(value: PdfValue?): PdfColor? {
    val items = (value as? PdfValue.Array)?.items ?: return null
    val c = items.map {
        when (it) {
            is PdfValue.Integer -> it.value.toDouble()
            is PdfValue.Real -> it.value
            else -> return null
        }
    }
    fun byte(v: Double) = (v.coerceIn(0.0, 1.0) * 255).roundToInt()
    return when (c.size) {
        1 -> PdfColor(byte(c[0]), byte(c[0]), byte(c[0]))
        3 -> PdfColor(byte(c[0]), byte(c[1]), byte(c[2]))
        4 -> (1 - c[3]).let { k -> PdfColor(byte((1 - c[0]) * k), byte((1 - c[1]) * k), byte((1 - c[2]) * k)) }
        else -> null
    }
}

internal suspend fun exportXfdf(document: PdfDocument): String {
    val colors = annotationColors(document)
    val byName = linkedMapOf<String, MutableList<PdfFormField>>()
    val annots = mutableListOf<String>()
    for (pageIndex in 0 until document.pageCount()) {
        val page = document.page(pageIndex)
        for (field in page.formFields().sortedBy { it.base.annotationIndex }) {
            val name = field.base.name ?: continue
            byName.getOrPut(name) { mutableListOf() } += field
        }
        for (annotation in page.annotations()) {
            val element = elementOf(annotation) ?: continue
            writeAnnotation(annotation, element, readEntries(document, pageIndex, annotation.base.index),
                colors["$pageIndex:${annotation.base.index}"] ?: annotation.base.color, annots)
        }
    }
    val out = mutableListOf("<?xml version=\"1.0\" encoding=\"UTF-8\"?>",
        "<xfdf xmlns=\"http://ns.adobe.com/xfdf/\" xml:space=\"preserve\">")
    val fieldLines = mutableListOf<String>()
    writeFields(fieldTree(byName), 2, fieldLines)
    if (fieldLines.isNotEmpty()) out += listOf("  <fields>") + fieldLines + "  </fields>"
    if (annots.isNotEmpty()) out += listOf("  <annots>") + annots + "  </annots>"
    out += "</xfdf>"
    return out.joinToString("\n") + "\n"
}
