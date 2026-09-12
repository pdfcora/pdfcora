package com.pdfiumkit

/// Errors raised by PdfiumKit. The cases match the iOS and Web SDKs exactly.
sealed class PdfError(message: String) : Exception(message) {
    object PasswordRequired : PdfError("a password is required to open this document")
    object WrongPassword : PdfError("the supplied password is incorrect")
    class Corrupt(val detail: String) : PdfError("the document is corrupt: $detail")
    object UnsupportedSecurity : PdfError("the document uses an unsupported security handler")
    class PageOutOfRange(val index: Int, val count: Int) :
        PdfError("page $index is out of range (document has $count)")
    object Closed : PdfError("the document has been closed")
    object Cancelled : PdfError("the operation was cancelled")
    class SaveFailed(val reason: String) : PdfError("saving failed: $reason")
    class InvalidOperation(val reason: String) : PdfError("invalid operation: $reason")
    class Engine(val code: Int) : PdfError("PDFium error $code")

    internal companion object {
        fun fromEngine(passwordSupplied: Boolean): PdfError = when (Native.lastError()) {
            2 -> Corrupt("file could not be read")
            3 -> Corrupt("malformed PDF structure")
            4 -> if (passwordSupplied) WrongPassword else PasswordRequired
            5 -> UnsupportedSecurity
            else -> Engine(Native.lastError())
        }
    }
}
