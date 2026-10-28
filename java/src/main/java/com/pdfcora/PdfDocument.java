package com.pdfcora;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.LinkedHashMap;

/**
 * An open PDF.
 *
 * PDFium's state is global, not per document, so every call on every document runs on one
 * engine thread for the whole process — the same rule iOS and Android keep. Calling from
 * several threads, on one document or several, is therefore safe: the calls serialise
 * instead of corrupting memory. They do not run in parallel.
 *
 * Closing releases native memory. Using a closed document raises {@link PdfError.Code#CLOSED}
 * rather than touching freed memory, and closing twice is harmless.
 */
public final class PdfDocument implements AutoCloseable {
  private static final ExecutorService ENGINE = Executors.newSingleThreadExecutor(runnable -> {
    Thread thread = new Thread(runnable, "pdfcora-engine");
    thread.setDaemon(true);
    return thread;
  });

  /**
   * How long the file was when it was opened. A signature's ByteRange indexes *those*
   * bytes, and re-saving the document changes its length, so the original is what says
   * whether a signature reaches the end of the file.
   */
  private final long openedLength;
  private volatile long handle;

  private PdfDocument(long handle, long openedLength) {
    this.handle = handle;
    this.openedLength = openedLength;
  }

  /**
   * Opens a document from bytes the caller owns; they are copied into the engine.
   *
   * <p>A DOCX is accepted too: it is converted to PDF first, and the document is that PDF
   * from then on, so saving gives a PDF. An encrypted DOCX, or one that cannot be
   * converted, raises {@link PdfError.Code#CORRUPT}.
   */
  public static PdfDocument open(byte[] bytes) {
    return open(bytes, null);
  }

  /** As {@link #open(byte[])}; the password applies to a PDF and is ignored for a DOCX. */
  public static PdfDocument open(byte[] bytes, String password) {
    // The DOCX converter does not touch PDFium, so it runs here rather than holding up the
    // engine thread every document shares.
    byte[] pdf = asPdf(bytes);
    // A password belongs to a PDF; a DOCX that arrives with one opens without it.
    long handle = await(() -> Native.open(pdf, pdf == bytes ? password : null));
    if (handle < 0) throw PdfError.fromNative((int) handle);
    return new PdfDocument(handle, pdf.length);
  }

  private static final byte[] CFB = {(byte) 0xD0, (byte) 0xCF, 0x11, (byte) 0xE0, (byte) 0xA1, (byte) 0xB1, 0x1A, (byte) 0xE1};
  private static final byte[] ZIP = {'P', 'K', 3, 4};
  private static final byte[] ENCRYPTED_PACKAGE = "EncryptedPackage".getBytes(StandardCharsets.UTF_16LE);

  /** The bytes themselves for a PDF, the converted PDF for a DOCX. */
  private static byte[] asPdf(byte[] bytes) {
    // An encrypted DOCX is not a ZIP but an OLE container holding an EncryptedPackage stream.
    if (startsWith(bytes, CFB) && indexOf(bytes, ENCRYPTED_PACKAGE) >= 0) {
      throw new PdfError(PdfError.Code.CORRUPT, "encrypted DOCX is not supported");
    }
    if (!startsWith(bytes, ZIP)) return bytes;
    String[] error = new String[1];
    byte[] converted = Native.convertDocx(bytes, error);
    if (error[0] != null) throw new PdfError(PdfError.Code.CORRUPT, error[0]);
    return converted != null ? converted : bytes;
  }

  private static boolean startsWith(byte[] bytes, byte[] prefix) {
    return bytes.length >= prefix.length && Arrays.equals(bytes, 0, prefix.length, prefix, 0, prefix.length);
  }

  private static int indexOf(byte[] bytes, byte[] pattern) {
    outer:
    for (int i = 0; i <= bytes.length - pattern.length; i++) {
      for (int j = 0; j < pattern.length; j++) {
        if (bytes[i + j] != pattern[j]) continue outer;
      }
      return i;
    }
    return -1;
  }

  /** Opens a PDF or DOCX file; see {@link #open(byte[])}. */
  public static PdfDocument open(Path file) throws IOException {
    return open(Files.readAllBytes(file), null);
  }

  /** As {@link #open(byte[], String)}, from a file. */
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

    java.util.List<com.pdfcora.writer.PdfTagging.Block> tree = new java.util.ArrayList<>();
    for (int i = 0; i < ordered.size(); i++) {
      PdfTagBlock block = ordered.get(i);
      if (block.type().equals("Artifact")) continue;
      tree.add(new com.pdfcora.writer.PdfTagging.Block(
          block.pageIndex(), block.type(), assignedIds.get(i), block.altText()));
    }

    byte[] tagged = com.pdfcora.writer.PdfTagging.write(toByteArray(), tree, mcidCounts, title, language);
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

  /**
   * Signs the document, returning the signed bytes; this document is untouched.
   *
   * The signature is appended to a full save, so everything done to the document in
   * memory is inside it. That save rewrites the file, so a signature that was already
   * there does not survive — to add a second signature to a signed file, sign its
   * original bytes with {@link com.pdfcora.sign.PdfSigning#sign} instead, which
   * appends without rewriting.
   */
  public byte[] sign(com.pdfcora.sign.PdfSignOptions options) {
    return com.pdfcora.sign.PdfSigning.sign(toByteArray(), options);
  }

  public boolean isClosed() {
    return handle == 0;
  }

  @Override
  public void close() {
    if (handle == 0) return;
    long closing = handle;
    handle = 0;
    await(() -> { Native.close(closing); return null; });
  }

  // ---- internals ------------------------------------------------------------------

  interface Work<T> { T run(long handle); }

  /** Runs on the engine thread, with the handle checked first. */
  <T> T call(Work<T> work) {
    long current = handle;
    if (current == 0) throw new PdfError(PdfError.Code.CLOSED, "the document is closed");
    return await(() -> work.run(current));
  }

  private static <T> T await(Callable<T> work) {
    try {
      return ENGINE.submit(work).get();
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
