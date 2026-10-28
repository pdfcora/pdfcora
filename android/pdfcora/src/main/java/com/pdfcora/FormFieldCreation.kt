package com.pdfcora

import com.pdfcora.writer.FormFieldWriter

/** A form field to create, for [addFormFields]. [name] must be unique; [tooltip] is `/TU`. */
data class PdfNewFormField(
    val pageIndex: Int,
    val kind: Kind,
    val rect: PdfRect,
    val name: String,
    val tooltip: String? = null,
) {
    enum class Kind { TEXT, CHECK_BOX }
}

/**
 * Creates text fields and checkboxes, returning a new document; this document is unchanged.
 * Throws [PdfError.InvalidOperation], writing nothing, when a name is empty or already used.
 * Appended as an incremental update.
 */
suspend fun PdfDocument.addFormFields(fields: List<PdfNewFormField>): PdfDocument {
    val pageCount = pageCount()
    val names = mutableSetOf<String>()
    for (pageIndex in 0 until pageCount) page(pageIndex).formFields().mapNotNullTo(names) { it.base.name }
    for (field in fields) {
        if (field.pageIndex !in 0 until pageCount) throw PdfError.PageOutOfRange(field.pageIndex, pageCount)
        if (field.name.isBlank()) throw PdfError.InvalidOperation("a form field needs a name")
        if (!names.add(field.name)) throw PdfError.InvalidOperation("a field named \"${field.name}\" already exists")
    }
    val base = onDocument { Native.saveDocument(it, PdfSaveMode.INCREMENTAL.flag) }
    if (base.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
    return PdfDocument.open(FormFieldWriter.write(base, fields))
}
