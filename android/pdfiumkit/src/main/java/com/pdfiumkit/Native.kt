package com.pdfiumkit

/// Thin JNI surface. Everything here is primitives and arrays; the typed object model
/// is assembled in Kotlin.
internal object Native {
    init {
        System.loadLibrary("pdfiumkit")
        init()
    }

    @JvmStatic external fun init()
    @JvmStatic external fun openDocument(data: ByteArray, password: String?): Long
    @JvmStatic external fun lastError(): Int
    @JvmStatic external fun closeDocument(handle: Long)
    @JvmStatic external fun pageCount(handle: Long): Int
    @JvmStatic external fun permissions(handle: Long): Int
    @JvmStatic external fun pageSize(handle: Long, index: Int): FloatArray
    @JvmStatic external fun pageRotation(handle: Long, index: Int): Int
    @JvmStatic external fun setPageRotation(handle: Long, index: Int, rotation: Int)
    @JvmStatic external fun renderPage(
        handle: Long, index: Int, bitmap: android.graphics.Bitmap, flags: Int, background: Int
    ): Boolean
    @JvmStatic external fun pageText(handle: Long, index: Int): String
    @JvmStatic external fun charCount(handle: Long, index: Int): Int
    @JvmStatic external fun search(handle: Long, index: Int, query: String, flags: Int): FloatArray
    @JvmStatic external fun metaText(handle: Long, key: String): String

    @JvmStatic external fun annotationCount(handle: Long, pageIndex: Int): Int
    @JvmStatic external fun annotationInfo(handle: Long, pageIndex: Int, annotIndex: Int): FloatArray
    @JvmStatic external fun annotationString(handle: Long, pageIndex: Int, annotIndex: Int, key: String): String
    @JvmStatic external fun inkStroke(handle: Long, pageIndex: Int, annotIndex: Int, strokeIndex: Int): FloatArray
    @JvmStatic external fun addInk(
        handle: Long, pageIndex: Int, points: FloatArray, r: Int, g: Int, b: Int, a: Int, width: Float
    ): Int
    @JvmStatic external fun addNote(
        handle: Long, pageIndex: Int, left: Float, bottom: Float, right: Float, top: Float,
        contents: String, r: Int, g: Int, b: Int, a: Int
    ): Int
    @JvmStatic external fun removeAnnotation(handle: Long, pageIndex: Int, annotIndex: Int): Boolean

    @JvmStatic external fun formFieldInfo(handle: Long, pageIndex: Int, annotIndex: Int): FloatArray
    @JvmStatic external fun formFieldString(handle: Long, pageIndex: Int, annotIndex: Int, which: Int): String
    @JvmStatic external fun formOptionLabel(handle: Long, pageIndex: Int, annotIndex: Int, optionIndex: Int): String
    @JvmStatic external fun isOptionSelected(handle: Long, pageIndex: Int, annotIndex: Int, optionIndex: Int): Boolean
    @JvmStatic external fun setFormText(handle: Long, pageIndex: Int, annotIndex: Int, value: String): Boolean
    @JvmStatic external fun setFormChecked(handle: Long, pageIndex: Int, annotIndex: Int, checked: Boolean): Boolean
    @JvmStatic external fun setFormOption(
        handle: Long, pageIndex: Int, annotIndex: Int, optionIndex: Int, selected: Boolean
    ): Boolean

    @JvmStatic external fun links(handle: Long, pageIndex: Int): FloatArray
    @JvmStatic external fun linkUri(handle: Long, pageIndex: Int, linkIndex: Int): String
    @JvmStatic external fun charBox(handle: Long, pageIndex: Int, charIndex: Int): DoubleArray

    @JvmStatic external fun bookmarkChildCount(handle: Long, path: IntArray): Int
    @JvmStatic external fun bookmarkTitle(handle: Long, path: IntArray): String
    @JvmStatic external fun bookmarkPageIndex(handle: Long, path: IntArray): Int

    @JvmStatic external fun attachmentCount(handle: Long): Int
    @JvmStatic external fun attachmentName(handle: Long, index: Int): String
    @JvmStatic external fun attachmentData(handle: Long, index: Int): ByteArray
    @JvmStatic external fun saveDocument(handle: Long, flags: Int): ByteArray
}
