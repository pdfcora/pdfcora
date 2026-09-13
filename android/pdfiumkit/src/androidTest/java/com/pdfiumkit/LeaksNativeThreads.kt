package com.pdfiumkit

/**
 * Marks a test that leaves native PDFium threads spinning for the life of the process.
 *
 * A hung render cannot be cancelled — the thread never returns from PDFium — so every
 * test scheduled after one shares the process with permanently concurrent renders.
 * PDFium's global state does not survive that: form-fill drawing, in particular, stops
 * producing output while the page itself still renders. Excluded from the default run
 * and executed on its own; see `scripts/test-android.sh`.
 */
annotation class LeaksNativeThreads
