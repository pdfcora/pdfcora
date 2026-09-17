package com.pdfcora

import kotlinx.coroutines.asCoroutineDispatcher
import java.util.concurrent.Executor
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * The one thread every PDFium call in the process runs on.
 *
 * Not one thread per document: PDFium's global state is not thread-safe, so two
 * documents working at once race it. That is not theoretical — it kills the process with
 * a fatal signal, reproducibly, which is what `CrossDocumentStressTest` exists to prove.
 *
 * The cost is that one stuck call would block every document. PDFium can hang inside a
 * single call — `hang-probe.pdf` never returns from its render — and a thread stuck in
 * native code cannot be killed. So there is a watchdog: work is fed to the engine thread
 * one item at a time, and when an item outlives [timeoutMillis] everything behind it runs
 * on a rescue thread instead, where [ensureResponsive] throws
 * [PdfError.EngineUnresponsive]. If the stuck call ever returns, the engine takes work
 * again.
 *
 * Code dispatched here must call [ensureResponsive] before touching PDFium, because on
 * the rescue thread it runs alongside the stuck call.
 */
internal object EngineExecutor : Executor {
    @Volatile
    var timeoutMillis: Long = 30_000

    private val lock = Any()
    private val pending = ArrayDeque<Runnable>()
    private var feeding = false
    private var running = 0L
    private var generation = 0L
    private var stuck = false

    private val engine = Executors.newSingleThreadExecutor { Thread(it, "pdfcora-engine").apply { isDaemon = true } }
    @Volatile
    private var rescueThread: Thread? = null
    private val rescue = Executors.newSingleThreadExecutor { runnable ->
        Thread(runnable, "pdfcora-engine-rescue").apply { isDaemon = true }.also { rescueThread = it }
    }
    private val watchdog = Executors.newSingleThreadScheduledExecutor {
        Thread(it, "pdfcora-engine-watchdog").apply { isDaemon = true }
    }

    val dispatcher = asCoroutineDispatcher()

    /** False on the rescue thread, where PDFium must not be touched. */
    val isResponsive: Boolean get() = Thread.currentThread() !== rescueThread

    fun ensureResponsive() {
        if (!isResponsive) throw PdfError.EngineUnresponsive
    }

    override fun execute(command: Runnable) {
        synchronized(lock) {
            if (!stuck) {
                pending.addLast(command)
                if (feeding) return
                feeding = true
                engine.execute(::feed)
                return
            }
        }
        rescue.execute(command)
    }

    /**
     * Runs [command] on the engine thread without a deadline.
     *
     * For freeing handles, which must happen on the engine thread even while it is stuck,
     * whenever it comes back.
     */
    fun executeUnwatched(command: Runnable) {
        engine.execute(command)
    }

    /** Runs one queued item under a deadline, then yields so unwatched frees interleave. */
    private fun feed() {
        val command: Runnable
        val current: Long
        synchronized(lock) {
            command = pending.removeFirstOrNull() ?: run {
                feeding = false
                return
            }
            current = ++generation
            running = current
        }

        watchdog.schedule({ expire(current) }, timeoutMillis, TimeUnit.MILLISECONDS)
        try {
            command.run()
        } finally {
            synchronized(lock) {
                running = 0
                stuck = false
            }
            engine.execute(::feed)
        }
    }

    private fun expire(generation: Long) {
        val abandoned: List<Runnable>
        synchronized(lock) {
            if (running != generation || stuck) return
            stuck = true
            abandoned = pending.toList()
            pending.clear()
        }
        abandoned.forEach(rescue::execute)
    }
}
