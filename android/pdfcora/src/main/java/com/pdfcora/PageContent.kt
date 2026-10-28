package com.pdfcora

// PDFium annotation subtypes (fpdf_annot.h)
private const val SUBTYPE_TEXT = 1
private const val SUBTYPE_LINK = 2
private const val SUBTYPE_FREETEXT = 3
private const val SUBTYPE_LINE = 4
private const val SUBTYPE_SQUARE = 5
private const val SUBTYPE_CIRCLE = 6
private const val SUBTYPE_HIGHLIGHT = 9
private const val SUBTYPE_UNDERLINE = 10
private const val SUBTYPE_SQUIGGLY = 11
private const val SUBTYPE_STRIKEOUT = 12
private const val SUBTYPE_STAMP = 13
private const val SUBTYPE_INK = 15
private const val SUBTYPE_FILEATTACHMENT = 17
private const val SUBTYPE_WIDGET = 20

// PDFium form field types (fpdf_formfill.h)
private const val FIELD_PUSHBUTTON = 1
private const val FIELD_CHECKBOX = 2
private const val FIELD_RADIOBUTTON = 3
private const val FIELD_COMBOBOX = 4
private const val FIELD_LISTBOX = 5
private const val FIELD_TEXTFIELD = 6
private const val FIELD_SIGNATURE = 7

private const val STRING_NAME = 0
private const val STRING_ALTERNATE_NAME = 1
private const val STRING_VALUE = 2
private const val STRING_EXPORT_VALUE = 3

/** All annotations on the page, in document order. */
suspend fun PdfPage.annotations(): List<PdfAnnotation> = document.onDocument { h ->
    (0 until Native.annotationCount(h, index)).map { annotIndex ->
        val info = Native.annotationInfo(h, index, annotIndex)
        val base = PdfAnnotationBase(
            pageIndex = index,
            index = annotIndex,
            rect = PdfRect(info[6], info[7], info[8], info[9]),
            color = if (info[5] < 0) null
                    else PdfColor(info[2].toInt(), info[3].toInt(), info[4].toInt(), info[5].toInt()),
            flags = info[1].toInt(),
            contents = Native.annotationString(h, index, annotIndex, "Contents").ifEmpty { null },
        )

        when (val subtype = info[0].toInt()) {
            SUBTYPE_HIGHLIGHT -> PdfAnnotation.Highlight(base, emptyList())
            SUBTYPE_UNDERLINE -> PdfAnnotation.Underline(base, emptyList())
            SUBTYPE_STRIKEOUT -> PdfAnnotation.Strikeout(base, emptyList())
            SUBTYPE_SQUIGGLY -> PdfAnnotation.Squiggly(base, emptyList())
            SUBTYPE_INK -> PdfAnnotation.Ink(base, readInkStrokes(h, index, annotIndex, info[10].toInt()))
            SUBTYPE_FREETEXT -> PdfAnnotation.FreeText(base)
            SUBTYPE_SQUARE -> PdfAnnotation.Square(base)
            SUBTYPE_CIRCLE -> PdfAnnotation.Circle(base)
            SUBTYPE_LINE -> PdfAnnotation.Line(base)
            SUBTYPE_TEXT -> PdfAnnotation.Note(base)
            SUBTYPE_LINK -> PdfAnnotation.Link(base)
            SUBTYPE_STAMP -> PdfAnnotation.Stamp(base)
            SUBTYPE_FILEATTACHMENT -> PdfAnnotation.FileAttachment(base)
            SUBTYPE_WIDGET -> PdfAnnotation.Widget(
                base, Native.formFieldString(h, index, annotIndex, STRING_NAME).ifEmpty { null }
            )
            else -> PdfAnnotation.Unknown(base, subtype)
        }
    }
}

private fun readInkStrokes(handle: Long, pageIndex: Int, annotIndex: Int, count: Int): List<List<PdfPoint>> =
    (0 until count).map { strokeIndex ->
        val flat = Native.inkStroke(handle, pageIndex, annotIndex, strokeIndex)
        (flat.indices step 2).mapNotNull { i ->
            if (i + 1 < flat.size) PdfPoint(flat[i], flat[i + 1]) else null
        }
    }

/** Adds one freehand ink annotation made of [strokes]. Returns the new annotation's index. */
suspend fun PdfPage.addInk(
    strokes: List<List<PdfPoint>>,
    color: PdfColor = PdfColor.BLACK,
    lineWidth: Float = 2f,
): Int {
    return document.onDocument { h ->
        val points = strokes.flatten()
        val flat = FloatArray(points.size * 2)
        points.forEachIndexed { i, point ->
            flat[i * 2] = point.x
            flat[i * 2 + 1] = point.y
        }
        val lengths = strokes.map { it.size }.toIntArray()
        val result = Native.addInk(h, index, flat, lengths, color.red, color.green, color.blue, color.alpha, lineWidth)
        if (result < 0) throw PdfError.InvalidOperation("ink annotation could not be created")
        result
    }
}

/** Adds a highlight covering [quads]. Returns the new annotation's index. */
suspend fun PdfPage.addHighlight(quads: List<PdfQuad>, color: PdfColor = PdfColor.YELLOW): Int =
    addMarkup(SUBTYPE_HIGHLIGHT, quads, color)

suspend fun PdfPage.addUnderline(quads: List<PdfQuad>, color: PdfColor = PdfColor(0, 0, 255)): Int =
    addMarkup(SUBTYPE_UNDERLINE, quads, color)

suspend fun PdfPage.addStrikeout(quads: List<PdfQuad>, color: PdfColor = PdfColor(255, 0, 0)): Int =
    addMarkup(SUBTYPE_STRIKEOUT, quads, color)

private suspend fun PdfPage.addMarkup(subtype: Int, quads: List<PdfQuad>, color: PdfColor): Int {
    return document.onDocument { h ->
        val flat = FloatArray(quads.size * 8)
        quads.forEachIndexed { i, q ->
            val o = i * 8
            flat[o] = q.p1.x; flat[o + 1] = q.p1.y
            flat[o + 2] = q.p2.x; flat[o + 3] = q.p2.y
            flat[o + 4] = q.p3.x; flat[o + 5] = q.p3.y
            flat[o + 6] = q.p4.x; flat[o + 7] = q.p4.y
        }
        val result = Native.addMarkup(h, index, subtype, flat,
            color.red, color.green, color.blue, color.alpha)
        if (result < 0) throw PdfError.InvalidOperation("markup annotation could not be created")
        result
    }
}

/** Adds a sticky note. Returns the new annotation's index. */
suspend fun PdfPage.addNote(
    rect: PdfRect,
    contents: String,
    color: PdfColor = PdfColor.YELLOW,
): Int {
    return document.onDocument { h ->
        val result = Native.addNote(
            h, index, rect.left, rect.bottom, rect.right, rect.top,
            contents, color.red, color.green, color.blue, color.alpha
        )
        if (result < 0) throw PdfError.InvalidOperation("note annotation could not be created")
        result
    }
}

suspend fun PdfPage.removeAnnotation(annotationIndex: Int) {
    document.onDocument { h ->
        if (!Native.removeAnnotation(h, index, annotationIndex)) {
            throw PdfError.PageOutOfRange(annotationIndex, Native.annotationCount(h, index))
        }
    }
}

/** Link regions on this page, with their resolved targets. */
suspend fun PdfPage.links(): List<PdfLink> = document.onDocument { h ->
    val packed = Native.links(h, index)
    (packed.indices step 5).mapNotNull { i ->
        if (i + 4 >= packed.size) return@mapNotNull null
        val linkIndex = i / 5
        val targetPage = packed[i + 4].toInt()
        val target = when {
            targetPage >= 0 -> PdfLink.Target.Page(targetPage)
            else -> Native.linkUri(h, index, linkIndex)
                .takeIf { it.isNotEmpty() }
                ?.let { PdfLink.Target.Uri(it) }
                ?: PdfLink.Target.Unresolved
        }
        PdfLink(PdfRect(packed[i], packed[i + 1], packed[i + 2], packed[i + 3]), target)
    }
}

/** The bounding box of one character, in page space. */
suspend fun PdfTextPage.boundingBox(charIndex: Int): PdfRect = boxInternal(charIndex)

/** Every interactive form field on this page. */
suspend fun PdfPage.formFields(): List<PdfFormField> = document.onDocument { h ->
    (0 until Native.annotationCount(h, index)).mapNotNull { annotIndex ->
        val info = Native.formFieldInfo(h, index, annotIndex)
        val fieldType = info[0].toInt()
        if (fieldType < 0) return@mapNotNull null

        val flags = info[1].toInt()
        val base = PdfFormFieldBase(
            pageIndex = index,
            annotationIndex = annotIndex,
            name = Native.formFieldString(h, index, annotIndex, STRING_NAME).ifEmpty { null },
            alternateName = Native.formFieldString(h, index, annotIndex, STRING_ALTERNATE_NAME).ifEmpty { null },
            rect = PdfRect(info[4], info[5], info[6], info[7]),
            flags = flags,
        )
        val value = Native.formFieldString(h, index, annotIndex, STRING_VALUE)
        val isChecked = info[2] != 0f
        val exportValue = Native.formFieldString(h, index, annotIndex, STRING_EXPORT_VALUE).ifEmpty { null }

        when (fieldType) {
            FIELD_TEXTFIELD -> PdfFormField.Text(
                base, value,
                isMultiline = flags and (1 shl 12) != 0,
                isPassword = flags and (1 shl 13) != 0,
            )
            FIELD_CHECKBOX -> PdfFormField.CheckBox(base, isChecked, exportValue)
            FIELD_RADIOBUTTON -> PdfFormField.RadioButton(base, isChecked, exportValue)
            FIELD_COMBOBOX -> {
                val (options, selected) = readChoices(h, index, annotIndex, info[3].toInt())
                PdfFormField.ComboBox(base, value, options, selected)
            }
            FIELD_LISTBOX -> {
                val (options, selected) = readChoices(h, index, annotIndex, info[3].toInt())
                PdfFormField.ListBox(base, value, options, selected)
            }
            FIELD_PUSHBUTTON -> PdfFormField.PushButton(base)
            FIELD_SIGNATURE -> PdfFormField.Signature(base)
            else -> PdfFormField.Unknown(base, fieldType)
        }
    }
}

private fun readChoices(
    handle: Long, pageIndex: Int, annotIndex: Int, count: Int,
): Pair<List<String>, List<Int>> {
    val options = mutableListOf<String>()
    val selected = mutableListOf<Int>()
    for (i in 0 until count) {
        options += Native.formOptionLabel(handle, pageIndex, annotIndex, i)
        if (Native.isOptionSelected(handle, pageIndex, annotIndex, i)) selected += i
    }
    return options to selected
}

/** Sets a text field's value. */
suspend fun PdfPage.setText(value: String, fieldAt: Int) {
    document.onDocument { h ->
        if (!Native.setFormText(h, index, fieldAt, value)) {
            throw PdfError.InvalidOperation("field could not take focus")
        }
    }
}

/** Sets a checkbox or radio button to an explicit state. */
suspend fun PdfPage.setChecked(checked: Boolean, fieldAt: Int) {
    document.onDocument { h ->
        if (!Native.setFormChecked(h, index, fieldAt, checked)) {
            throw PdfError.InvalidOperation("field state could not be set")
        }
    }
}

/** Selects or deselects one option of a combo or list box. */
suspend fun PdfPage.setOption(optionIndex: Int, selected: Boolean, fieldAt: Int) {
    document.onDocument { h ->
        if (!Native.setFormOption(h, index, fieldAt, optionIndex, selected)) {
            throw PdfError.InvalidOperation("option $optionIndex could not be selected")
        }
    }
}
