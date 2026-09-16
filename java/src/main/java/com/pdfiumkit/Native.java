package com.pdfiumkit;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;

/**
 * The native calls, and the loader that finds the library for this platform.
 *
 * Package-private on purpose: everything about lifetime, threading and errors is decided
 * in {@link PdfDocument}, which is the only caller.
 */
final class Native {
  private Native() {}

  static {
    load();
    initLibrary();
  }

  /**
   * The library ships inside the jar, one per platform. It is copied out to a temporary
   * file because the JVM can only load a library from the filesystem, and deleted on exit.
   * {@code pdfiumkit.native.path} overrides the whole mechanism, for a build that keeps
   * its own copy.
   */
  private static void load() {
    String override = System.getProperty("pdfiumkit.native.path");
    if (override != null) {
      System.load(override);
      return;
    }

    String os = System.getProperty("os.name").toLowerCase();
    String arch = System.getProperty("os.arch").toLowerCase();
    String platform;
    String extension;
    if (os.contains("mac") || os.contains("darwin")) {
      platform = arch.contains("aarch64") || arch.contains("arm") ? "macos-arm64" : "macos-x86_64";
      extension = ".dylib";
    } else if (os.contains("linux")) {
      platform = arch.contains("aarch64") || arch.contains("arm") ? "linux-aarch64" : "linux-x86_64";
      extension = ".so";
    } else {
      throw new UnsupportedOperationException(
          "PdfiumKit has no engine for " + os + "/" + arch + "; macOS and Linux are supported");
    }

    String resource = "/native/" + platform + "/libpdfiumkit_jni" + extension;
    try (InputStream in = Native.class.getResourceAsStream(resource)) {
      if (in == null) {
        throw new UnsatisfiedLinkError(
            "no engine for " + platform + " in this jar (looked for " + resource + ")");
      }
      Path file = Files.createTempFile("libpdfiumkit_jni", extension);
      Files.copy(in, file, StandardCopyOption.REPLACE_EXISTING);
      file.toFile().deleteOnExit();
      System.load(file.toAbsolutePath().toString());
    } catch (IOException e) {
      throw new UnsatisfiedLinkError("could not unpack the engine: " + e.getMessage());
    }
  }

  static native void initLibrary();

  /** Returns a handle, or a negative {@link PdfError} code. */
  static native long open(byte[] data, String password);

  static native void close(long handle);

  static native int pageCount(long handle);

  static native int pageSize(long handle, int index, float[] out);

  static native int render(long handle, int index, int width, int height,
                           boolean withAnnotations, int[] out);

  static native String pageText(long handle, int index);

  static native int charCount(long handle, int index);

  static native int search(long handle, int index, String query, boolean caseSensitive, int[] out);

  static native String metadata(long handle, String key);

  static native byte[] save(long handle);

  static native int permissions(long handle);

  static native int annotationCount(long handle, int index);

  /** Fills `out` with subtype and rect; returns the annotation's contents. */
  static native String annotation(long handle, int index, int at, float[] out);

  static native int addInk(long handle, int index, float[] points, int[] lengths,
                           int red, int green, int blue, float lineWidth);

  static native int addMarkup(long handle, int index, int subtype, float[] quads,
                              int red, int green, int blue, int alpha);

  static native int addNote(long handle, int index, float x, float y, String contents);

  static native int removeAnnotation(long handle, int index, int at);

  /** Fills `out` with kind, flags and checked, and `rect`; returns "name\nvalue". */
  static native String formField(long handle, int index, int at, int[] out, float[] rect);

  static native int setFieldText(long handle, int index, int at, String value);

  static native int setFieldChecked(long handle, int index, int at, boolean checked);

  /** Redacts one page; fills `counts` with text, split, image, path and annotation totals. */
  static native int redactPage(long handle, int index, float[] regions, int[] counts);

  /** The rectangles a match covers; returns how many were written. */
  static native int matchRects(long handle, int index, int start, int count, float[] out);

  static native int signatureCount(long handle);

  static native byte[] signatureContents(long handle, int at);

  static native int signatureByteRange(long handle, int at, int[] out);

  /** Reason, sub-filter and time joined by newlines; the MDP permission goes in `out`. */
  static native String signatureInfo(long handle, int at, int[] out);

  static native int markPage(long handle, int index, String[] types, int[] assignments);

  static native boolean isTagged(long handle);

  static native int objectCount(long handle, int index);

  static native int objectInfo(long handle, int index, int at, float[] out);
}
