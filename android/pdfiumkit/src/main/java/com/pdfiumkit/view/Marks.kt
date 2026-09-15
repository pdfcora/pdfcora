package com.pdfiumkit.view

import com.pdfiumkit.PdfRect

enum class PdfMarkState { PENDING, ACCEPTED, REJECTED }

/** A reviewable region drawn over a page, such as a redaction suggestion. */
data class PdfMark(
    val id: String,
    val pageIndex: Int,
    val rects: List<PdfRect>,
    val state: PdfMarkState = PdfMarkState.PENDING,
)
