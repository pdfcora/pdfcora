package com.pdfcora

/// Fields every annotation carries.
data class PdfAnnotationBase(
    val pageIndex: Int,
    val index: Int,
    val rect: PdfRect,
    val color: PdfColor?,
    val flags: Int,
    val contents: String?,
)

/// An annotation, as a snapshot. Reading gives values rather than live PDFium handles.
sealed class PdfAnnotation {
    abstract val base: PdfAnnotationBase

    data class Highlight(override val base: PdfAnnotationBase, val quads: List<PdfQuad>) : PdfAnnotation()
    data class Underline(override val base: PdfAnnotationBase, val quads: List<PdfQuad>) : PdfAnnotation()
    data class Strikeout(override val base: PdfAnnotationBase, val quads: List<PdfQuad>) : PdfAnnotation()
    data class Squiggly(override val base: PdfAnnotationBase, val quads: List<PdfQuad>) : PdfAnnotation()
    data class Ink(override val base: PdfAnnotationBase, val strokes: List<List<PdfPoint>>) : PdfAnnotation()
    data class FreeText(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Square(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Circle(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Line(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Note(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Link(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Stamp(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class FileAttachment(override val base: PdfAnnotationBase) : PdfAnnotation()
    data class Widget(override val base: PdfAnnotationBase, val fieldName: String?) : PdfAnnotation()

    /// A subtype this SDK does not model. Never dropped silently.
    data class Unknown(override val base: PdfAnnotationBase, val subtypeCode: Int) : PdfAnnotation()
}

/// Fields every form field carries.
data class PdfFormFieldBase(
    val pageIndex: Int,
    val annotationIndex: Int,
    val name: String?,
    val alternateName: String?,
    val rect: PdfRect,
    val flags: Int,
) {
    val isReadOnly: Boolean get() = flags and 1 != 0
    val isRequired: Boolean get() = flags and 2 != 0
}

/// An interactive form field, as a snapshot.
sealed class PdfFormField {
    abstract val base: PdfFormFieldBase

    data class Text(
        override val base: PdfFormFieldBase,
        val value: String,
        val isMultiline: Boolean,
        val isPassword: Boolean,
    ) : PdfFormField()

    data class CheckBox(
        override val base: PdfFormFieldBase,
        val isChecked: Boolean,
        val exportValue: String?,
    ) : PdfFormField()

    data class RadioButton(
        override val base: PdfFormFieldBase,
        val isChecked: Boolean,
        val exportValue: String?,
    ) : PdfFormField()

    data class ComboBox(
        override val base: PdfFormFieldBase,
        val value: String,
        val options: List<String>,
        val selectedIndices: List<Int>,
    ) : PdfFormField()

    data class ListBox(
        override val base: PdfFormFieldBase,
        val value: String,
        val options: List<String>,
        val selectedIndices: List<Int>,
    ) : PdfFormField()

    data class PushButton(override val base: PdfFormFieldBase) : PdfFormField()
    data class Signature(override val base: PdfFormFieldBase) : PdfFormField()

    /// A field type this SDK does not model.
    data class Unknown(override val base: PdfFormFieldBase, val typeCode: Int) : PdfFormField()
}
