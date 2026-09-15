package com.pdfiumkit.writer

import com.pdfiumkit.PdfError

/**
 * Writing a new structure tree for content PDFium has already marked.
 *
 * PDFium puts the marked-content ids into the page content; the tree that points at them is
 * dictionaries, which only this writer can create.
 */
internal object TagTreeWriter {
    /** [mcids] are the marked-content ids PDFium gave the block's objects. */
    data class Block(val pageIndex: Int, val type: String, val mcids: List<Int>, val altText: String?)

    /** [blocks] in reading order, artifacts excluded; [language] null keeps the Catalog's own. */
    data class Tree(val blocks: List<Block>, val mcidCounts: List<Int>, val title: String, val language: String?)

    fun write(bytes: ByteArray, tree: Tree): ByteArray {
        val info = TrailerInfo.scan(bytes)
        val xref = Xref.build(bytes)
        val (catalogNumber, catalog) = PdfReader.catalog(bytes)
        val pages = PdfReader.pages(bytes, xref, catalog)

        var next = info.nextObjectNumber
        fun allocate() = next++
        val rootNumber = allocate()
        val documentNumber = allocate()
        val metadataNumber = allocate()

        val objects = mutableMapOf<Int, PdfValue>()
        val documentKids = mutableListOf<PdfValue>()
        val parents = tree.mcidCounts.map { MutableList<PdfValue>(it) { PdfValue.Null } }
        fun element(type: String, parent: Int, rest: List<Pair<String, PdfValue>>) = PdfValue.Dictionary(
            listOf("Type" to PdfValue.Name("StructElem"), "S" to PdfValue.Name(type), "P" to PdfValue.Reference(parent)) + rest)

        var listNumber: Int? = null
        val listKids = mutableListOf<PdfValue>()
        for (block in tree.blocks) {
            val holder = allocate()
            val content = listOf("Pg" to PdfValue.Reference(pages[block.pageIndex]), "K" to PdfValue.Array(block.mcids.map { PdfValue.Integer(it) }))
            for (id in block.mcids) parents[block.pageIndex][id] = PdfValue.Reference(holder)

            if (block.type != "LI") {
                listNumber = null
                objects[holder] = element(block.type, documentNumber, content + listOfNotNull(block.altText?.let { "Alt" to PdfValue.Text(it) }))
                documentKids += PdfValue.Reference(holder)
                continue
            }
            val list = listNumber ?: allocate().also {
                listNumber = it
                listKids.clear()
                documentKids += PdfValue.Reference(it)
            }
            val item = allocate()
            listKids += PdfValue.Reference(item)
            objects[item] = element("LI", list, listOf("K" to PdfValue.Array(listOf(PdfValue.Reference(holder)))))
            objects[holder] = element("LBody", item, content)
            objects[list] = element("L", documentNumber, listOf("K" to PdfValue.Array(listKids.toList())))
        }

        val parentTree = allocate()
        objects[parentTree] = PdfValue.Dictionary(listOf("Nums" to PdfValue.Array(
            parents.withIndex().flatMap { (pageIndex, row) -> listOf(PdfValue.Integer(pageIndex), PdfValue.Array(row)) })))
        objects[documentNumber] = element("Document", rootNumber, listOf("K" to PdfValue.Array(documentKids)))
        objects[rootNumber] = PdfValue.Dictionary(listOf(
            "Type" to PdfValue.Name("StructTreeRoot"), "K" to PdfValue.Reference(documentNumber),
            "ParentTree" to PdfValue.Reference(parentTree), "ParentTreeNextKey" to PdfValue.Integer(pages.size)))

        for ((pageIndex, number) in pages.withIndex()) {
            val entries = (PdfReader.obj(bytes, xref, number) as? PdfValue.Dictionary)?.entries
                ?: throw PdfError.SaveFailed("tagging: page $pageIndex is unreadable")
            objects[number] = PdfValue.Dictionary(entries.filter { it.first != "StructParents" && it.first != "Tabs" } +
                listOf("StructParents" to PdfValue.Integer(pageIndex), "Tabs" to PdfValue.Name("S")))
        }

        val xmp = xmpPacket(tree.title).toByteArray(Charsets.UTF_8)
        objects[metadataNumber] = PdfValue.Raw(
            "<</Type /Metadata /Subtype /XML /Length ${xmp.size}>>\nstream\n".toByteArray(Charsets.ISO_8859_1) + xmp +
                "\nendstream".toByteArray(Charsets.ISO_8859_1))

        val replaced = setOf("StructTreeRoot", "MarkInfo", "Metadata") + (if (tree.language != null) setOf("Lang") else emptySet())
        var entries = (catalog as PdfValue.Dictionary).entries.filter { it.first !in replaced } + listOf(
            "StructTreeRoot" to PdfValue.Reference(rootNumber),
            "MarkInfo" to PdfValue.Dictionary(listOf("Marked" to PdfValue.Bool(true))),
            "Metadata" to PdfValue.Reference(metadataNumber),
        ) + listOfNotNull(tree.language?.let { "Lang" to PdfValue.Text(it) })

        fun withDisplayTitle(value: PdfValue?): PdfValue = PdfValue.Dictionary(
            ((value as? PdfValue.Dictionary)?.entries ?: emptyList()).filter { it.first != "DisplayDocTitle" } +
                ("DisplayDocTitle" to PdfValue.Bool(true)))
        val preferences = PdfReader.reference(catalog, "ViewerPreferences")
        if (preferences != null) {
            objects[preferences] = withDisplayTitle(PdfReader.obj(bytes, xref, preferences))
        } else {
            entries = entries.filter { it.first != "ViewerPreferences" } +
                ("ViewerPreferences" to withDisplayTitle(PdfReader.entry(catalog, "ViewerPreferences")))
        }
        objects[catalogNumber] = PdfValue.Dictionary(entries)

        return PdfWriter.appendUpdate(bytes, objects)
    }

    fun xmpPacket(title: String): String {
        val escaped = title.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
        return """<?xpacket begin="${'﻿'}" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/">
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">
<dc:title><rdf:Alt><rdf:li xml:lang="x-default">$escaped</rdf:li></rdf:Alt></dc:title>
<pdfuaid:part>1</pdfuaid:part>
</rdf:Description>
</rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>"""
    }
}
