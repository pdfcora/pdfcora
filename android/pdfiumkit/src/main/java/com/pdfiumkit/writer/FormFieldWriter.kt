package com.pdfiumkit.writer

import com.pdfiumkit.PdfError
import com.pdfiumkit.PdfNewFormField

/**
 * Creating form fields. PDFium can fill fields but cannot create widgets, so new fields are
 * written here as an incremental update: widget dictionaries, the page's /Annots and the
 * Catalog's /AcroForm, merged with whatever is already there. Mirrors `web/src/writer/formFields.ts`.
 */
internal object FormFieldWriter {
    private const val DA = "/Helv 0 Tf 0 g"

    private fun format(value: Float): String {
        val rounded = Math.round(value * 100) / 100.0
        return if (rounded == Math.floor(rounded)) rounded.toInt().toString() else rounded.toString()
    }

    private fun appearance(width: Float, height: Float, body: String) = PdfValue.Raw(
        "<</Type /XObject /Subtype /Form /BBox [0 0 ${format(width)} ${format(height)}] /Length ${body.length}>>\nstream\n$body\nendstream"
            .toByteArray(Charsets.ISO_8859_1))

    private val HELVETICA = PdfValue.Dictionary(listOf(
        "Type" to PdfValue.Name("Font"), "Subtype" to PdfValue.Name("Type1"),
        "BaseFont" to PdfValue.Name("Helvetica"), "Encoding" to PdfValue.Name("WinAnsiEncoding")))

    /** /DR with /Helv, which /DA names, added to an inline font dictionary when missing. */
    private fun resources(existing: PdfValue?): PdfValue {
        if (existing == null) return PdfValue.Dictionary(listOf("Font" to PdfValue.Dictionary(listOf("Helv" to HELVETICA))))
        val dr = (existing as? PdfValue.Dictionary)?.entries ?: return existing
        return when (val font = dr.firstOrNull { it.first == "Font" }?.second) {
            null -> PdfValue.Dictionary(dr + ("Font" to PdfValue.Dictionary(listOf("Helv" to HELVETICA))))
            is PdfValue.Dictionary -> if (font.entries.any { it.first == "Helv" }) existing
                else PdfValue.Dictionary(dr.filter { it.first != "Font" } + ("Font" to PdfValue.Dictionary(font.entries + ("Helv" to HELVETICA))))
            else -> existing
        }
    }

    fun write(bytes: ByteArray, fields: List<PdfNewFormField>): ByteArray {
        val info = TrailerInfo.scan(bytes)
        val xref = Xref.build(bytes)
        val (catalogNumber, catalog) = PdfReader.catalog(bytes)
        val pages = PdfReader.pages(bytes, xref, catalog)

        var next = info.nextObjectNumber
        val objects = mutableMapOf<Int, PdfValue>()
        val widgetsByPage = linkedMapOf<Int, MutableList<PdfValue>>()
        val fieldRefs = mutableListOf<PdfValue>()

        for (field in fields) {
            val widget = next++
            val r = field.rect
            val entries = mutableListOf<Pair<String, PdfValue>>(
                "Type" to PdfValue.Name("Annot"), "Subtype" to PdfValue.Name("Widget"), "T" to PdfValue.Text(field.name))
            field.tooltip?.let { entries += "TU" to PdfValue.Text(it) }
            entries += listOf("Rect" to PdfValue.Array(listOf(r.left, r.bottom, r.right, r.top).map { PdfValue.Real(it.toDouble()) }),
                "F" to PdfValue.Integer(4), "P" to PdfValue.Reference(pages[field.pageIndex]), "DA" to PdfValue.Text(DA))
            when (field.kind) {
                PdfNewFormField.Kind.TEXT -> entries += "FT" to PdfValue.Name("Tx")
                PdfNewFormField.Kind.CHECK_BOX -> {
                    val w = r.width
                    val h = r.height
                    val on = next++
                    val off = next++
                    // A tick drawn as a path, so the appearance needs no font.
                    objects[on] = appearance(w, h, "q 0 g 1.5 w ${format(w * 0.2f)} ${format(h * 0.5f)} m ${format(w * 0.42f)} ${format(h * 0.22f)} l ${format(w * 0.8f)} ${format(h * 0.8f)} l S Q")
                    objects[off] = appearance(w, h, "")
                    entries += listOf("FT" to PdfValue.Name("Btn"), "V" to PdfValue.Name("Off"), "AS" to PdfValue.Name("Off"),
                        "AP" to PdfValue.Dictionary(listOf("N" to PdfValue.Dictionary(listOf("Yes" to PdfValue.Reference(on), "Off" to PdfValue.Reference(off))))))
                }
            }
            objects[widget] = PdfValue.Dictionary(entries)
            fieldRefs += PdfValue.Reference(widget)
            widgetsByPage.getOrPut(field.pageIndex) { mutableListOf() } += PdfValue.Reference(widget)
        }

        for ((pageIndex, widgets) in widgetsByPage) {
            val number = pages[pageIndex]
            val page = PdfReader.obj(bytes, xref, number) as? PdfValue.Dictionary
                ?: throw PdfError.SaveFailed("fields: page $pageIndex is unreadable")
            val annotsNumber = PdfReader.reference(page, "Annots")
            if (annotsNumber != null) {
                val existing = (PdfReader.obj(bytes, xref, annotsNumber) as? PdfValue.Array)?.items
                    ?: throw PdfError.SaveFailed("fields: page $pageIndex annotations are unreadable")
                objects[annotsNumber] = PdfValue.Array(existing + widgets)
            } else {
                val existing = (PdfReader.entry(page, "Annots") as? PdfValue.Array)?.items ?: emptyList()
                objects[number] = PdfValue.Dictionary(page.entries.filter { it.first != "Annots" } + ("Annots" to PdfValue.Array(existing + widgets)))
            }
        }

        val acroFormNumber = PdfReader.reference(catalog, "AcroForm")
        val acroForm = ((acroFormNumber?.let { PdfReader.obj(bytes, xref, it) } ?: PdfReader.entry(catalog, "AcroForm")) as? PdfValue.Dictionary)
            ?: PdfValue.Dictionary(emptyList())
        var merged = acroForm.entries.filter { it.first !in setOf("NeedAppearances", "DA", "DR") }
        val fieldsNumber = PdfReader.reference(acroForm, "Fields")
        if (fieldsNumber != null) {
            val listed = (PdfReader.obj(bytes, xref, fieldsNumber) as? PdfValue.Array)?.items ?: emptyList()
            objects[fieldsNumber] = PdfValue.Array(listed + fieldRefs)
        } else {
            val listed = (PdfReader.entry(acroForm, "Fields") as? PdfValue.Array)?.items ?: emptyList()
            merged = merged.filter { it.first != "Fields" } + ("Fields" to PdfValue.Array(listed + fieldRefs))
        }
        merged = merged + listOf("NeedAppearances" to PdfValue.Bool(true),
            "DA" to (PdfReader.entry(acroForm, "DA") ?: PdfValue.Text(DA)), "DR" to resources(PdfReader.entry(acroForm, "DR")))

        if (acroFormNumber != null) {
            objects[acroFormNumber] = PdfValue.Dictionary(merged)
        } else {
            objects[catalogNumber] = PdfValue.Dictionary((catalog as PdfValue.Dictionary).entries.filter { it.first != "AcroForm" } +
                ("AcroForm" to PdfValue.Dictionary(merged)))
        }
        return PdfWriter.appendUpdate(bytes, objects)
    }
}
