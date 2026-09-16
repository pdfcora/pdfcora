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
}
