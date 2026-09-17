package com.pdfcora.writer

/**
 * Writing figure alternate text into the structure tree.
 *
 * PDFium reads structure elements but cannot change them, and its element handles carry no
 * object numbers. So the tree is walked again here, from the bytes, and a figure is found by
 * what both sides agree on: its page and its marked-content ids.
 */
internal object FigureWriter {
    data class Edit(val pageIndex: Int, val markedContentIds: List<Int>, val altText: String?, val decorative: Boolean)

    data class Figure(
        val number: Int,
        /** The indirect object whose /K lists this element. */
        val parent: Int?,
        val pageIndex: Int,
        val ids: List<Int>,
    )

    class NotFound(message: String) : Exception(message)

    private const val MAX_DEPTH = 64

    private fun kids(node: PdfValue): List<PdfValue> = when (val k = PdfReader.entry(node, "K")) {
        is PdfValue.Array -> k.items
        null -> emptyList()
        else -> listOf(k)
    }

    /** Every figure element that has marked content on a single page. */
    fun figures(bytes: ByteArray): List<Figure> {
        val xref = Xref.build(bytes)
        val catalog = PdfReader.catalog(bytes).second
        val pages = PdfReader.pages(bytes, xref, catalog).withIndex().associate { it.value to it.index }
        val rootNumber = PdfReader.reference(catalog, "StructTreeRoot")
        val root = (rootNumber?.let { PdfReader.obj(bytes, xref, it) } ?: PdfReader.entry(catalog, "StructTreeRoot"))
            as? PdfValue.Dictionary ?: return emptyList()

        val found = mutableListOf<Figure>()
        val seen = mutableSetOf<Int>()
        val parents = mutableMapOf<Int, Int?>()
        rootNumber?.let { seen += it }

        fun resolve(value: PdfValue): Pair<PdfValue?, Int?> {
            val number = (value as? PdfValue.Reference)?.number ?: return value to null
            if (!seen.add(number)) return null to number
            return PdfReader.obj(bytes, xref, number) to number
        }

        fun visit(node: PdfValue, number: Int?, page: Int?, depth: Int) {
            if (depth > MAX_DEPTH) return
            val ownPage = PdfReader.reference(node, "Pg") ?: page
            val ids = mutableListOf<Pair<Int?, Int>>()

            for (kid in kids(node)) {
                if (kid is PdfValue.Integer) { ids += ownPage to kid.value; continue }
                val (child, childNumber) = resolve(kid)
                if (child !is PdfValue.Dictionary) continue
                val type = PdfReader.entry(child, "Type")
                val hasStructureType = PdfReader.entry(child, "S") != null
                val mcid = PdfReader.entry(child, "MCID") as? PdfValue.Integer
                if ((PdfReader.isName(type, "MCR") || !hasStructureType) && mcid != null) {
                    ids += (PdfReader.reference(child, "Pg") ?: ownPage) to mcid.value
                } else if (hasStructureType && !PdfReader.isName(type, "OBJR")) {
                    visit(child, childNumber, ownPage, depth + 1)
                    if (childNumber != null) parents[childNumber] = number
                }
            }

            if (!PdfReader.isName(PdfReader.entry(node, "S"), "Figure") || number == null || ids.isEmpty()) return
            val pageNumbers = ids.map { it.first }.toSet()
            val only = pageNumbers.singleOrNull() ?: return
            val pageIndex = pages[only] ?: return
            found += Figure(number, null, pageIndex, ids.map { it.second })
        }

        for (kid in kids(root)) {
            val (child, childNumber) = resolve(kid)
            if (child == null || PdfReader.entry(child, "S") == null) continue
            visit(child, childNumber, null, 1)
            if (childNumber != null) parents[childNumber] = rootNumber
        }
        return found.map { it.copy(parent = parents[it.number]) }
    }

    /** The figure each edit names. Throws before anything is written when one is missing or ambiguous. */
    fun find(bytes: ByteArray, edits: List<Edit>): List<Figure> {
        val all = figures(bytes)
        return edits.map { edit ->
            val matches = all.filter { it.pageIndex == edit.pageIndex && it.ids.sorted() == edit.markedContentIds.sorted() }
            val label = "page ${edit.pageIndex}, marked content ${edit.markedContentIds.joinToString(",")}"
            if (matches.isEmpty()) throw NotFound("no figure on $label")
            if (matches.size > 1) throw NotFound("${matches.size} figures on $label")
            if (edit.decorative && matches[0].parent == null) {
                throw NotFound("the figure on $label has no indirect parent to remove it from")
            }
            matches[0]
        }
    }

    /** Appends /Alt for described figures and removes decorative ones from their parents. */
    fun write(bytes: ByteArray, edits: List<Edit>): ByteArray {
        val targets = find(bytes, edits)
        val xref = Xref.build(bytes)
        val objects = mutableMapOf<Int, PdfValue>()
        fun current(number: Int): List<Pair<String, PdfValue>> =
            ((objects[number] ?: PdfReader.obj(bytes, xref, number)) as? PdfValue.Dictionary)?.entries
                ?: throw NotFound("object $number is unreadable")

        for ((edit, target) in edits.zip(targets)) {
            val parent = target.parent
            if (edit.decorative && parent != null) {
                val entries = current(parent)
                val kept = kids(PdfValue.Dictionary(entries)).filter { (it as? PdfValue.Reference)?.number != target.number }
                objects[parent] = PdfValue.Dictionary(entries.filter { it.first != "K" } + ("K" to PdfValue.Array(kept)))
            } else {
                val entries = current(target.number)
                objects[target.number] = PdfValue.Dictionary(entries.filter { it.first != "Alt" } + ("Alt" to PdfValue.Text(edit.altText ?: "")))
            }
        }
        return PdfWriter.appendUpdate(bytes, objects)
    }
}
