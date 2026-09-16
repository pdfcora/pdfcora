package com.pdfiumkit;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.LinkedHashMap;

/**
 * An open PDF.
 *
 * PDFium is not thread-safe, so every document owns one thread and every call runs on it
 * — the same rule the other platforms keep with an actor on iOS and a single-threaded
 * dispatcher on Android. Calling from several threads is therefore safe: the calls
 * serialise instead of corrupting memory.
 *
 * Closing releases native memory. Using a closed document raises {@link PdfError.Code#CLOSED}
 * rather than touching freed memory, and closing twice is harmless.
 */
public final class PdfDocument implements AutoCloseable {
  private final ExecutorService engine;
  private volatile long handle;

  private PdfDocument(long handle, ExecutorService engine) {
    this.handle = handle;
    this.engine = engine;
  }

  /** Opens a document from bytes the caller owns; they are copied into the engine. */
  public static PdfDocument open(byte[] bytes) {
    return open(bytes, null);
  }

  public static PdfDocument open(byte[] bytes, String password) {
    ExecutorService engine = Executors.newSingleThreadExecutor(runnable -> {
      Thread thread = new Thread(runnable, "pdfiumkit-engine");
      thread.setDaemon(true);
      return thread;
    });
    long handle = await(engine, () -> Native.open(bytes, password));
    if (handle < 0) {
      engine.shutdown();
      throw PdfError.fromNative((int) handle);
    }
    return new PdfDocument(handle, engine);
  }

  public static PdfDocument open(Path file) throws IOException {
    return open(Files.readAllBytes(file), null);
  }

  public static PdfDocument open(Path file, String password) throws IOException {
    return open(Files.readAllBytes(file), password);
  }

  public int pageCount() {
    return call(handle -> Native.pageCount(handle));
  }

  /** A lightweight reference; the page itself is loaded when it is used. */
  public PdfPage page(int index) {
    if (index < 0 || index >= pageCount()) {
      throw new PdfError(PdfError.Code.PAGE_OUT_OF_RANGE, "no page " + index);
    }
    return new PdfPage(this, index);
  }

  /** Title, author, subject, keywords, creator and producer, omitting what is absent. */
  public Map<String, String> metadata() {
    return call(handle -> {
      Map<String, String> out = new LinkedHashMap<>();
      for (String key : new String[] { "Title", "Author", "Subject", "Keywords", "Creator", "Producer" }) {
        String value = Native.metadata(handle, key);
        if (value != null && !value.isEmpty()) out.put(key.toLowerCase(), value);
      }
      return out;
    });
  }

  /** The permission flags as the document declares them. */
  public int permissions() {
    return call(handle -> Native.permissions(handle));
  }

  /** The document as bytes. Always a full save; incremental saving is not exposed yet. */
  public byte[] toByteArray() {
    byte[] bytes = call(handle -> Native.save(handle));
    if (bytes == null) throw new PdfError(PdfError.Code.SAVE_FAILED, "the document could not be saved");
    return bytes;
  }

  public void writeTo(Path file) throws IOException {
    Files.write(file, toByteArray());
  }

  public boolean isClosed() {
    return handle == 0;
  }

  @Override
  public void close() {
    if (handle == 0) return;
    long closing = handle;
    handle = 0;
    try {
      await(engine, () -> { Native.close(closing); return null; });
    } finally {
      engine.shutdown();
    }
  }

  // ---- internals ------------------------------------------------------------------

  interface Work<T> { T run(long handle); }

  /** Runs on the document's own thread, with the handle checked first. */
  <T> T call(Work<T> work) {
    long current = handle;
    if (current == 0) throw new PdfError(PdfError.Code.CLOSED, "the document is closed");
    return await(engine, () -> work.run(current));
  }

  private static <T> T await(ExecutorService engine, Callable<T> work) {
    try {
      return engine.submit(work).get();
    } catch (InterruptedException e) {
      Thread.currentThread().interrupt();
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "interrupted while waiting for the engine");
    } catch (ExecutionException e) {
      Throwable cause = e.getCause();
      if (cause instanceof PdfError error) throw error;
      throw new PdfError(PdfError.Code.CORRUPT, String.valueOf(cause));
    }
  }
}
