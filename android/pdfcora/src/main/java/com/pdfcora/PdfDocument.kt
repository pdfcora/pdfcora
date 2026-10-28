package com.pdfcora

import android.graphics.Bitmap
import kotlinx.coroutines.withContext
import java.io.Closeable
import java.io.File
import java.util.concurrent.atomic.AtomicBoolean

/**
 * An open PDF document.
 *
 * Every PDFium call for this document and anything reached through it runs on this
 * document's single-threaded dispatcher, which is what makes the SDK safe to use from
 * any coroutine. Separate documents get separate dispatchers, so unrelated documents
 * render in parallel.
 *
 * Close it with [close], or use `document.use { ... }`.
 */
class PdfDocument private constructor(
    private var handle: Long,
    /**
     * The bytes the document was opened from. A signature's byte range is measured
     * against them and verification re-hashes them; PDFium's own copy is not
     * byte-identical once edits have been made.
     */
    private val backing: ByteArray,
) : Closeable {

    internal fun originalBytes(): ByteArray = backing

    private var cachedFingerprint: String? = null

    /**
     * A stable identifier for the bytes this document was opened from.
     *
     * Two documents opened from identical bytes share it; any difference changes it.
     * Used to refuse replaying an edit against the wrong document — annotation and field
     * indices are positions in specific bytes, so a removal replayed elsewhere removes
     * the wrong thing, silently.
     *
     * FNV-1a rather than a cryptographic digest: this answers "are these the same
     * bytes", not "has someone tampered with them". The length is appended, since a hash
     * collision alone should not be enough.
     */
    val fingerprint: String
        get() = cachedFingerprint ?: run {
            var hash = -0x7ee3623b  // 0x811c9dc5 as a signed Int
            for (byte in backing) {
                hash = hash xor (byte.toInt() and 0xff)
                hash *= 16777619
            }
            "%08x-%d".format(hash, backing.size).also { cachedFingerprint = it }
        }

    private val closed = AtomicBoolean(false)

    companion object {
        /** The PDFium revision this SDK was built against. */
        const val ENGINE_VERSION: String = "chromium/7243"

        /**
         * How long one engine call may run before the calls queued behind it fail with
         * [PdfError.EngineUnresponsive]. Every document shares one engine thread, and
         * PDFium can hang inside a single call on a malformed page. The stuck call itself
         * cannot be interrupted. Defaults to 30 seconds.
         */
        var engineTimeoutMillis: Long
            get() = EngineExecutor.timeoutMillis
            set(value) { EngineExecutor.timeoutMillis = value }

        suspend fun open(bytes: ByteArray, password: String? = null): PdfDocument {
            // The error is read in the same hop as the load: PDFium's last error is one
            // global, and another document's failure could overwrite it between hops.
            val handle = withContext(EngineExecutor.dispatcher) {
                EngineExecutor.ensureResponsive()
                Native.openDocument(bytes, password).also {
                    if (it == 0L) throw PdfError.fromEngine(password != null)
                }
            }
            return PdfDocument(handle, bytes)
        }

        suspend fun open(file: File, password: String? = null): PdfDocument =
            open(file.readBytes(), password)
    }

    /** Runs [block] on this document's dispatcher, refusing once closed. */
    internal suspend fun <T> onDocument(block: (Long) -> T): T {
        // Checked before dispatching: the shared executor outlives this document, so
        // only this flag distinguishes a closed document from a live one.
        if (closed.get()) throw PdfError.Closed
        return withContext(EngineExecutor.dispatcher) {
            EngineExecutor.ensureResponsive()
            val current = handle
            if (closed.get() || current == 0L) throw PdfError.Closed
            block(current)
        }
    }

    val isClosed: Boolean get() = closed.get()

    suspend fun pageCount(): Int = onDocument { Native.pageCount(it) }

    suspend fun permissions(): PdfPermissions = onDocument { PdfPermissions(Native.permissions(it)) }

    /** A lightweight reference to a page; loading is deferred until the page is used. */
    suspend fun page(index: Int): PdfPage {
        val count = pageCount()
        if (index < 0 || index >= count) throw PdfError.PageOutOfRange(index, count)
        return PdfPage(this, index)
    }

    suspend fun metadata(): PdfMetadata = onDocument { h ->
        fun read(key: String) = Native.metaText(h, key).ifEmpty { null }
        PdfMetadata(
            title = read("Title"),
            author = read("Author"),
            subject = read("Subject"),
            keywords = read("Keywords"),
            creator = read("Creator"),
            producer = read("Producer"),
        )
    }

    /** Reads a metadata key that [PdfMetadata] does not model. */
    suspend fun metadata(key: String): String? = onDocument { Native.metaText(it, key).ifEmpty { null } }

    /** The document outline, or an empty list when there is none. */
    suspend fun outline(): List<PdfOutlineItem> = onDocument { h -> readBookmarks(h, intArrayOf()) }

    /** Guards against the cycles malformed documents can contain. */
    private fun readBookmarks(handle: Long, path: IntArray): List<PdfOutlineItem> {
        if (path.size >= 32) return emptyList()
        return (0 until Native.bookmarkChildCount(handle, path)).map { i ->
            val childPath = path + i
            PdfOutlineItem(
                title = Native.bookmarkTitle(handle, childPath),
                pageIndex = Native.bookmarkPageIndex(handle, childPath).takeIf { it >= 0 },
                children = readBookmarks(handle, childPath),
            )
        }
    }

    suspend fun attachments(): List<PdfAttachment> = onDocument { h ->
        (0 until Native.attachmentCount(h)).map { PdfAttachment(Native.attachmentName(h, it)) }
    }

    /** The bytes of one embedded attachment. */
    suspend fun attachmentData(index: Int): ByteArray = onDocument { h ->
        val count = Native.attachmentCount(h)
        if (index < 0 || index >= count) throw PdfError.PageOutOfRange(index, count)
        Native.attachmentData(h, index)
    }

    /** Serialises the document, including any edits made through this SDK. */
    suspend fun toByteArray(mode: PdfSaveMode = PdfSaveMode.FULL): ByteArray = onDocument { h ->
        Native.saveDocument(h, mode.flag).also {
            if (it.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
        }
    }

    suspend fun writeTo(file: File, mode: PdfSaveMode = PdfSaveMode.FULL) {
        val bytes = toByteArray(mode)
        try {
            file.writeBytes(bytes)
        } catch (e: Exception) {
            throw PdfError.SaveFailed(e.message ?: "write failed")
        }
    }

    /** Releases the document. Further use throws [PdfError.Closed]. */
    override fun close() {
        if (!closed.compareAndSet(false, true)) return
        val current = handle
        handle = 0
        // Must free on this document's own thread. PDFium is not thread-safe, and
        // closing from anywhere else races every other document's in-flight work —
        // which corrupts global engine state rather than failing loudly.
        // The executor is shared by every document, so it is never shut down here —
        // doing so would take every other open document down with it.
        if (current != 0L) EngineExecutor.executeUnwatched { Native.closeDocument(current) }
    }
}

/**
 * A page within a document.
 *
 * A lightweight reference holding the document and a page index, not a live PDFium
 * handle, so it can be passed between coroutines freely.
 */
class PdfPage internal constructor(
    val document: PdfDocument,
    val index: Int,
) {
    suspend fun size(): PdfSize = document.onDocument { h ->
        val values = Native.pageSize(h, index)
        PdfSize(values[0], values[1])
    }

    suspend fun rotation(): PdfPageRotation =
        document.onDocument { PdfPageRotation.fromRaw(Native.pageRotation(it, index)) }

    suspend fun setRotation(rotation: PdfPageRotation) {
        document.onDocument { Native.setPageRotation(it, index, rotation.raw) }
    }

    /** Text extraction and search for this page. */
    val text: PdfTextPage get() = PdfTextPage(document, index)

    /**
     * Renders the page at [width] pixels; height follows the page aspect ratio.
     *
     * Runs on the document's dispatcher, so it never blocks the caller's thread.
     */
    suspend fun render(
        width: Int,
        options: PdfRenderOptions = PdfRenderOptions.DEFAULT,
        background: PdfColor = PdfColor(255, 255, 255),
    ): Bitmap {
        val size = size()
        if (size.width <= 0f || size.height <= 0f) throw PdfError.Corrupt("page $index has zero size")
        val height = (width * size.height / size.width).toInt().coerceAtLeast(1)
        return render(width, height, options, background)
    }

    /** Renders at an explicit pixel size, ignoring the page aspect ratio. */
    suspend fun render(
        pixelWidth: Int,
        pixelHeight: Int,
        options: PdfRenderOptions = PdfRenderOptions.DEFAULT,
        background: PdfColor = PdfColor(255, 255, 255),
    ): Bitmap = document.onDocument { h ->
        val bitmap = Bitmap.createBitmap(
            pixelWidth.coerceAtLeast(1), pixelHeight.coerceAtLeast(1), Bitmap.Config.ARGB_8888
        )
        val ok = Native.renderPage(h, index, bitmap, options.toFlags(), background.toColorInt(),
            options.forms)
        if (!ok) {
            bitmap.recycle()
            throw PdfError.Corrupt("rendering page $index failed")
        }
        bitmap
    }
}

/** Text extraction and search for one page. */
class PdfTextPage internal constructor(
    private val document: PdfDocument,
    private val pageIndex: Int,
) {
    suspend fun characterCount(): Int = document.onDocument { Native.charCount(it, pageIndex) }

    /** The page's full text in reading order. */
    suspend fun string(): String = document.onDocument { Native.pageText(it, pageIndex) }

    suspend fun search(
        query: String,
        options: PdfSearchOptions = PdfSearchOptions.NONE,
    ): List<PdfTextMatch> {
        if (query.isEmpty()) return emptyList()
        val packed = document.onDocument { Native.search(it, pageIndex, query, options.toFlags()) }
        return decodeMatches(packed)
    }

    internal suspend fun boxInternal(charIndex: Int): PdfRect = document.onDocument { h ->
        val v = Native.charBox(h, pageIndex, charIndex)
        // PDFium returns left, right, bottom, top.
        PdfRect(left = v[0].toFloat(), bottom = v[2].toFloat(),
                right = v[1].toFloat(), top = v[3].toFloat())
    }

    /** Unpacks the flat (start, length, rectCount) + 4-floats-per-rect encoding from JNI. */
    private fun decodeMatches(packed: FloatArray): List<PdfTextMatch> {
        val matches = mutableListOf<PdfTextMatch>()
        var i = 0
        while (i + 2 < packed.size) {
            val start = packed[i].toInt()
            val length = packed[i + 1].toInt()
            val rectCount = packed[i + 2].toInt()
            i += 3
            val rects = mutableListOf<PdfRect>()
            repeat(rectCount) {
                if (i + 3 < packed.size) {
                    rects += PdfRect(packed[i], packed[i + 1], packed[i + 2], packed[i + 3])
                    i += 4
                }
            }
            matches += PdfTextMatch(start, length, rects)
        }
        return matches
    }
}
