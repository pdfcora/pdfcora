package com.pdfiumkit

/** One thing a screen reader announces on a page. */
data class PdfAccessibleNode(
    val role: Role,
    /** Headings only, 1–6. */
    val level: Int?,
    /** The label to speak; empty for lists, tables and rows, and for a figure without alternate text. */
    val text: String,
    val bounds: PdfRect?,
    val children: List<PdfAccessibleNode>,
) {
    enum class Role { HEADING, PARAGRAPH, LIST, LIST_ITEM, FIGURE, TABLE, ROW, HEADER_CELL, CELL, FORM_FIELD }
}

/**
 * The page as a screen reader should hear it: headings, paragraphs, lists, figures by their
 * alternate text, tables and form fields, in reading order. An untagged page is one paragraph.
 */
suspend fun PdfPage.accessibleContent(): List<PdfAccessibleNode> {
    val roots = structure()
    val packed = document.onDocument { Native.charMarkedContentIds(it, index) }
    val byId = mutableMapOf<Int, StringBuilder>()
    val all = StringBuilder()
    for (i in packed.indices step 2) {
        val char = String(Character.toChars(packed[i]))
        all.append(char)
        if (packed[i + 1] >= 0) byId.getOrPut(packed[i + 1]) { StringBuilder() }.append(char)
    }
    val size = size()
    return AccessibleContent.nodes(roots, byId.mapValues { it.value.toString() }, all.toString(),
        PdfRect(0f, 0f, size.width, size.height), formFields())
}

/** Spec: docs/superpowers/specs/2026-09-15-accessible-content-design.md, function for function with the web. */
internal object AccessibleContent {
    private val PARAGRAPH = setOf("P", "Span", "Quote", "Code", "Link", "Note", "Reference", "BibEntry", "Caption", "TOCI", "Lbl", "LBody", "Index")
    private val PASS_THROUGH = setOf("THead", "TBody", "TFoot")

    private fun collapse(text: String) = text.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }.joinToString(" ")

    fun nodes(
        roots: List<PdfStructureElement>,
        byId: Map<Int, String>,
        pageText: String,
        pageBounds: PdfRect,
        fields: List<PdfFormField>,
    ): List<PdfAccessibleNode> {
        fun own(e: PdfStructureElement) = collapse(e.markedContentIds.joinToString(" ") { byId[it].orEmpty() })
        fun all(e: PdfStructureElement): String = collapse((listOf(own(e)) + e.children.map { all(it) }).joinToString(" "))

        fun map(e: PdfStructureElement): List<PdfAccessibleNode> {
            fun leaf(role: PdfAccessibleNode.Role, level: Int? = null): List<PdfAccessibleNode> {
                val text = e.actualText?.let(::collapse) ?: all(e)
                return if (text.isEmpty()) emptyList() else listOf(PdfAccessibleNode(role, level, text, e.bounds, emptyList()))
            }
            fun container(role: PdfAccessibleNode.Role): List<PdfAccessibleNode> {
                val children = e.children.flatMap { map(it) }
                return if (children.isEmpty()) emptyList() else listOf(PdfAccessibleNode(role, null, "", e.bounds, children))
            }
            val type = e.type
            Regex("^H([1-6])?$").matchEntire(type)?.let { return leaf(PdfAccessibleNode.Role.HEADING, it.groupValues[1].toIntOrNull() ?: 1) }
            if (type in PARAGRAPH) return leaf(PdfAccessibleNode.Role.PARAGRAPH)
            return when (type) {
                "LI" -> leaf(PdfAccessibleNode.Role.LIST_ITEM)
                "TH" -> leaf(PdfAccessibleNode.Role.HEADER_CELL)
                "TD" -> leaf(PdfAccessibleNode.Role.CELL)
                "L", "TOC" -> container(PdfAccessibleNode.Role.LIST)
                "Table" -> container(PdfAccessibleNode.Role.TABLE)
                "TR" -> container(PdfAccessibleNode.Role.ROW)
                in PASS_THROUGH -> e.children.flatMap { map(it) }
                "Figure", "Formula" -> listOf(PdfAccessibleNode(PdfAccessibleNode.Role.FIGURE, null,
                    collapse(e.altText ?: e.actualText ?: all(e)), e.bounds, emptyList()))
                else -> {
                    val text = own(e)
                    (if (text.isEmpty()) emptyList() else listOf(PdfAccessibleNode(PdfAccessibleNode.Role.PARAGRAPH, null, text, e.bounds, emptyList()))) +
                        e.children.flatMap { map(it) }
                }
            }
        }

        val nodes = if (roots.isNotEmpty()) roots.flatMap { map(it) }.toMutableList()
        else collapse(pageText).let { if (it.isEmpty()) mutableListOf() else mutableListOf(PdfAccessibleNode(PdfAccessibleNode.Role.PARAGRAPH, null, it, pageBounds, emptyList())) }
        for (field in fields) {
            nodes += PdfAccessibleNode(PdfAccessibleNode.Role.FORM_FIELD, null, field.base.alternateName ?: field.base.name ?: "", field.base.rect, emptyList())
        }
        return nodes
    }
}
