/** The distinguishable ways a PDF operation can fail. Identical on iOS and Android. */
export type PdfErrorCode =
  | 'passwordRequired'
  | 'wrongPassword'
  | 'corrupt'
  | 'unsupportedSecurity'
  | 'pageOutOfRange'
  | 'closed'
  | 'cancelled'
  | 'saveFailed'
  | 'invalidOperation'
  | 'engine'
  | 'engineUnresponsive';

/**
 * Every failure this SDK raises. `code` is the stable, switchable discriminator;
 * `message` is for humans.
 */
export class PdfError extends Error {
  readonly code: PdfErrorCode;
  readonly detail?: string;

  constructor(code: PdfErrorCode, message: string, detail?: string) {
    super(message);
    this.name = 'PdfError';
    this.code = code;
    this.detail = detail;
  }

  static passwordRequired() {
    return new PdfError('passwordRequired', 'a password is required to open this document');
  }
  static wrongPassword() {
    return new PdfError('wrongPassword', 'the supplied password is incorrect');
  }
  static corrupt(detail: string) {
    return new PdfError('corrupt', `the document is corrupt: ${detail}`, detail);
  }
  static unsupportedSecurity() {
    return new PdfError('unsupportedSecurity', 'the document uses an unsupported security handler');
  }
  static pageOutOfRange(index: number, count: number) {
    return new PdfError('pageOutOfRange', `page ${index} is out of range (document has ${count})`);
  }
  static closed() {
    return new PdfError('closed', 'the document has been closed');
  }
  static cancelled() {
    return new PdfError('cancelled', 'the operation was cancelled');
  }
  static saveFailed(reason: string) {
    return new PdfError('saveFailed', `saving failed: ${reason}`, reason);
  }
  static invalidOperation(reason: string) {
    return new PdfError('invalidOperation', `invalid operation: ${reason}`, reason);
  }
  static engine(code: number) {
    return new PdfError('engine', `PDFium error ${code}`);
  }
  /** A PDFium call never returned, so nothing behind it can run. */
  static engineUnresponsive() {
    return new PdfError('engineUnresponsive', 'the PDF engine is stuck on an earlier call and cannot take work');
  }

  /** Maps FPDF_GetLastError, using whether a password was supplied to disambiguate. */
  static fromEngine(lastError: number, passwordSupplied: boolean): PdfError {
    switch (lastError) {
      case 2: return PdfError.corrupt('file could not be read');
      case 3: return PdfError.corrupt('malformed PDF structure');
      case 4: return passwordSupplied ? PdfError.wrongPassword() : PdfError.passwordRequired();
      case 5: return PdfError.unsupportedSecurity();
      default: return PdfError.engine(lastError);
    }
  }
}
