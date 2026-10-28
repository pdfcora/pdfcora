package com.pdfcora

/** What a page object is, as PDFium classifies it. */
enum class PdfPageObjectKind { TEXT, PATH, IMAGE, SHADING, FORM, UNKNOWN }

/**
 * One object a page is drawn from.
 *
 * Redaction resolves a region to the objects it touches and removes or rewrites them,
 * which is what makes the content actually leave the file.
 */
data class PdfPageObject(
    /** Position in the page's object list, which is how it is addressed for removal. */
    val index: Int,
    val kind: PdfPageObjectKind,
    /** In PDF space, normalised so left <= right and bottom <= top. */
    val bounds: PdfRect,
    /** Present for text objects only. */
    val text: String? = null,
    val fontSize: Float? = null,
)

/** What to remove. */
sealed class PdfRedactionTarget {
    data class Region(val rect: PdfRect, val pageIndex: Int) : PdfRedactionTarget()
    data class TextMatches(
        val query: String,
        val options: PdfSearchOptions = PdfSearchOptions(),
    ) : PdfRedactionTarget()
}

/**
 * What redaction actually removed.
 *
 * Not decoration: redaction is a compliance action, and "what did it remove" is the
 * question every reviewer asks.
 */
data class PdfRedactionReport(
    val pages: List<Int>,
    /** Removed outright. */
    val textObjects: Int,
    /** Partially covered, so rewritten with the covered characters dropped. */
    val textObjectsSplit: Int,
    /** Images are removed whole, never repainted with a hole. */
    val images: Int,
    val paths: Int,
    val annotations: Int,
    val formFields: List<String>,
    val attachments: List<String>,
)

/** The objects a page is drawn from, in drawing order. */
suspend fun PdfDocument.pageObjects(pageIndex: Int): List<PdfPageObject> = onDocument { handle ->
    val count = Native.pageObjectCount(handle, pageIndex)
    (0 until count).map { index ->
        val bounds = Native.pageObjectBounds(handle, pageIndex, index)
        PdfPageObject(
            index = index,
            kind = when (Native.pageObjectType(handle, pageIndex, index)) {
                1 -> PdfPageObjectKind.TEXT
                2 -> PdfPageObjectKind.PATH
                3 -> PdfPageObjectKind.IMAGE
                4 -> PdfPageObjectKind.SHADING
                5 -> PdfPageObjectKind.FORM
                else -> PdfPageObjectKind.UNKNOWN
            },
            // PDFium returns whichever corners it holds, so they are normalised here and
            // every intersection test downstream can assume the usual ordering.
            bounds = PdfRect(
                left = minOf(bounds[0], bounds[2]),
                bottom = minOf(bounds[1], bounds[3]),
                right = maxOf(bounds[0], bounds[2]),
                top = maxOf(bounds[1], bounds[3]),
            ),
            text = Native.pageObjectText(handle, pageIndex, index).ifEmpty { null },
            fontSize = Native.pageObjectFontSize(handle, pageIndex, index).takeIf { it > 0f },
        )
    }
}

/**
 * Removes content, so that it cannot be recovered.
 *
 * **Save with [PdfSaveMode.FULL] afterwards.** An incremental save does not write the
 * regenerated content stream at all, so the removed content stays in the file.
 */
suspend fun PdfDocument.redact(targets: List<PdfRedactionTarget>): PdfRedactionReport {
    val pages = pageCount()
    targets.filterIsInstance<PdfRedactionTarget.Region>().forEach {
        if (it.pageIndex < 0 || it.pageIndex >= pages) {
            throw PdfError.PageOutOfRange(it.pageIndex, pages)
        }
    }

    val touched = mutableListOf<Int>()
    var textObjects = 0
    var split = 0
    var images = 0
    var paths = 0
    var annotations = 0
    val formFields = mutableListOf<String>()
    val attachments = mutableListOf<String>()

    for (pageIndex in 0 until pages) {
        val regions = mutableListOf<PdfRect>()
        targets.filterIsInstance<PdfRedactionTarget.Region>()
            .filter { it.pageIndex == pageIndex }
            .forEach { regions += it.rect }

        // A search target becomes regions: every match's rects on this page. Reusing the
        // SDK's own search avoids a second implementation that could drift from it.
        targets.filterIsInstance<PdfRedactionTarget.TextMatches>().forEach { target ->
            if (target.query.isNotEmpty()) {
                page(pageIndex).text.search(target.query, target.options)
                    .forEach { regions += it.rects }
            }
        }
        if (regions.isEmpty()) continue

        val flat = FloatArray(regions.size * 4)
        regions.forEachIndexed { i, r ->
            flat[i * 4] = r.left; flat[i * 4 + 1] = r.bottom
            flat[i * 4 + 2] = r.right; flat[i * 4 + 3] = r.top
        }

        val counts = onDocument { handle -> Native.redactPage(handle, pageIndex, flat) }
        if (counts.isEmpty()) continue

        // [textObjects, split, images, paths, annotations, changed]
        textObjects += counts[0]
        split += counts[1]
        images += counts[2]
        paths += counts[3]
        annotations += counts[4]
        if (counts[5] != 0) touched += pageIndex

        onDocument { handle ->
            Native.redactedFieldNames(handle, pageIndex)
        }.filter { it.isNotEmpty() }.forEach { formFields += it }
    }

    val needles = targets.filterIsInstance<PdfRedactionTarget.TextMatches>()
        .map { it.query }.filter { it.isNotEmpty() }
    if (needles.isNotEmpty()) {
        onDocument { handle ->
            Native.scrubAttachments(handle, needles.toTypedArray())
        }.forEach { attachments += it }
    }

    return PdfRedactionReport(
        pages = touched.sorted(),
        textObjects = textObjects,
        textObjectsSplit = split,
        images = images,
        paths = paths,
        annotations = annotations,
        formFields = formFields,
        attachments = attachments,
    )
}
