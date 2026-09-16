package com.pdfiumkit;

/** Version and engine information, for a host that wants to report what it is running. */
public final class PdfiumKit {
  private PdfiumKit() {}

  public static final String VERSION = "0.1.0";

  /** The PDFium revision this SDK is built against, matching every other platform. */
  public static final String ENGINE_REVISION = "chromium/7243";
}
