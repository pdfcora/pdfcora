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
  /**
   * How long the file was when it was opened. A signature's ByteRange indexes *those*
   * bytes, and re-saving the document changes its length, so the original is what says
   * whether a signature reaches the end of the file.
   */
  private final long openedLength;
  private volatile long handle;

  private PdfDocument(long handle, ExecutorService engine, long openedLength) {
    this.handle = handle;
    this.engine = engine;
    this.openedLength = openedLength;
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
    return new PdfDocument(handle, engine, bytes.length);
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

  /** Whether the document already carries a structure tree. */
  public boolean isTagged() {
    return call(handle -> Native.isTagged(handle));
  }

  /** How many drawing objects a page has; {@link PdfTagBlock} addresses them by index. */
  public int objectCount(int pageIndex) {
    int count = call(handle -> Native.objectCount(handle, pageIndex));
    if (count < 0) throw PdfError.fromNative(count);
    return count;
  }

  /**
   * Writes a structure tree over the content, returning a new document; this one is
   * untouched.
   *
   * PDFium marks the objects, and the tree that points at those marks is appended by the
   * writer, because PDFium cannot create those dictionaries. Objects in no block become
   * artifacts — content a screen reader skips — which is what makes the result
   * conformant rather than merely tagged.
   */
  public PdfDocument tagContent(java.util.List<PdfTagBlock> blocks, String title, String language) {
    if (isTagged()) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "the document is tagged already");
    }
    if (title == null || title.isBlank()) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION, "a title is needed: PDF/UA requires one");
    }

    java.util.List<String> types = new java.util.ArrayList<>();
    for (PdfTagBlock block : blocks) types.add(block.type());
    String[] typeArray = types.toArray(new String[0]);

    java.util.List<Integer> mcidCounts = new java.util.ArrayList<>();
    java.util.List<PdfTagBlock> ordered = new java.util.ArrayList<>();
    java.util.List<java.util.List<Integer>> assignedIds = new java.util.ArrayList<>();

    for (int pageIndex = 0; pageIndex < pageCount(); pageIndex++) {
      int objects = objectCount(pageIndex);
      int[] assignment = new int[objects];
      java.util.Arrays.fill(assignment, -1);
      for (int b = 0; b < blocks.size(); b++) {
        PdfTagBlock block = blocks.get(b);
        if (block.pageIndex() != pageIndex) continue;
        for (int object : block.objectIndices()) {
          if (object < 0 || object >= objects) {
            throw new PdfError(PdfError.Code.INVALID_OPERATION,
                "object " + object + " is not on page " + pageIndex);
          }
          if (assignment[object] != -1) {
            throw new PdfError(PdfError.Code.INVALID_OPERATION,
                "object " + object + " is in two blocks");
          }
          assignment[object] = b;
        }
      }

      final int page = pageIndex;
      int used = call(handle -> Native.markPage(handle, page, typeArray, assignment));
      if (used < 0) throw PdfError.fromNative(used);
      mcidCounts.add(used);

      // Ids are handed out in object order, so the block's ids are recovered the same way.
      int nextId = 0;
      java.util.Map<Integer, java.util.List<Integer>> idsByBlock = new java.util.LinkedHashMap<>();
      for (int object = 0; object < objects; object++) {
        if (assignment[object] < 0) continue;
        idsByBlock.computeIfAbsent(assignment[object], k -> new java.util.ArrayList<>()).add(nextId++);
      }
      for (java.util.Map.Entry<Integer, java.util.List<Integer>> entry : idsByBlock.entrySet()) {
        ordered.add(blocks.get(entry.getKey()));
        assignedIds.add(entry.getValue());
      }
    }

    java.util.List<com.pdfiumkit.writer.PdfTagging.Block> tree = new java.util.ArrayList<>();
    for (int i = 0; i < ordered.size(); i++) {
      PdfTagBlock block = ordered.get(i);
      if (block.type().equals("Artifact")) continue;
      tree.add(new com.pdfiumkit.writer.PdfTagging.Block(
          block.pageIndex(), block.type(), assignedIds.get(i), block.altText()));
    }

    byte[] tagged = com.pdfiumkit.writer.PdfTagging.write(toByteArray(), tree, mcidCounts, title, language);
    return PdfDocument.open(tagged);
  }

  /**
   * Every signature in the document, in order.
   *
   * Reading one costs nothing and tells you what it claims; {@link PdfSignature#verify}
   * checks the bytes against it.
   */
  public java.util.List<PdfSignature> signatures() {
    int count = call(handle -> Native.signatureCount(handle));
    java.util.List<PdfSignature> signatures = new java.util.ArrayList<>(count);
    long fileLength = openedLength;

    for (int at = 0; at < count; at++) {
      final int index = at;
      int[] range = new int[16];
      int written = call(handle -> Native.signatureByteRange(handle, index, range));
      java.util.List<Integer> byteRange = new java.util.ArrayList<>(written);
      for (int i = 0; i < written; i++) byteRange.add(range[i]);

      int[] permission = new int[1];
      String info = call(handle -> Native.signatureInfo(handle, index, permission));
      String[] parts = (info == null ? "\n\n" : info).split("\n", -1);
      byte[] contents = call(handle -> Native.signatureContents(handle, index));

      // A signature can be valid and still cover only part of the file; anything
      // appended afterwards is unprotected, so this is worth stating separately.
      boolean whole = byteRange.size() >= 4
          && byteRange.get(byteRange.size() - 2) + byteRange.get(byteRange.size() - 1) >= fileLength;

      signatures.add(new PdfSignature(at,
          parts.length > 0 ? parts[0] : "", parts.length > 1 ? parts[1] : "",
          parts.length > 2 ? parts[2] : "", byteRange,
          contents == null ? new byte[0] : contents, permission[0], whole));
    }
    return signatures;
  }

  /**
   * Removes content, permanently. The returned report says what went.
   *
   * The content leaves the saved bytes rather than being covered, so the result must be
   * saved — {@link #toByteArray()} always saves in full, which is what redaction needs.
   */
  public PdfRedaction.Report redact(java.util.List<PdfRedaction.Target> targets) {
    return PdfRedaction.apply(this, targets);
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
