package com.pdfcora;

/**
 * The one exception this SDK throws. The cases are the same on iOS, Android, the web and
 * here, so error handling ports between platforms unchanged.
 */
public final class PdfError extends RuntimeException {
  public enum Code {
    /** The document is encrypted and no password was given. */
    PASSWORD_REQUIRED,
    /** A password was given and the document refused it. */
    WRONG_PASSWORD,
    /** The file, or one page of it, cannot be parsed. */
    CORRUPT,
    /** A page index outside the document. */
    PAGE_OUT_OF_RANGE,
    /** The document was used after {@link PdfDocument#close()}. */
    CLOSED,
    /** The call cannot apply to this document in its current state. */
    INVALID_OPERATION,
    /** Writing failed. */
    SAVE_FAILED,
  }

  private final Code code;

  public PdfError(Code code, String message) {
    super(message);
    this.code = code;
  }

  public Code code() {
    return code;
  }

  /** Maps the negative codes the native layer returns. Anything unknown is corrupt. */
  static PdfError fromNative(int value) {
    return switch (value) {
      case -1 -> new PdfError(Code.PASSWORD_REQUIRED, "the document is encrypted and needs a password");
      case -2 -> new PdfError(Code.WRONG_PASSWORD, "the password was refused");
      case -4 -> new PdfError(Code.PAGE_OUT_OF_RANGE, "no such page");
      case -5 -> new PdfError(Code.SAVE_FAILED, "the document could not be saved");
      default -> new PdfError(Code.CORRUPT, "the document could not be read");
    };
  }
}
