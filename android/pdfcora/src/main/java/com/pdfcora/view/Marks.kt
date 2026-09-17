package com.pdfcora.view

import com.pdfcora.PdfRect

enum class PdfMarkState { PENDING, ACCEPTED, REJECTED }

/** A reviewable region drawn over a page, such as a redaction suggestion. */
data class PdfMark(
    val id: String,
    val pageIndex: Int,
    val rects: List<PdfRect>,
    val state: PdfMarkState = PdfMarkState.PENDING,
    /** Shown inside the mark, such as the value a form proposal would fill in. */
    val label: String? = null,
)
