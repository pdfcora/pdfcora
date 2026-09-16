package com.pdfiumkit.sign;

/**
 * What to sign with, and what to record in the signature.
 *
 * Fluent rather than a constructor with seven arguments: only the signer is required and
 * the rest are rarely all set at once.
 */
public final class PdfSignOptions {
  private final CmsSigner signer;
  private String reason;
  private String contactInfo;
  private String fieldName;
  private int pageIndex = 0;
  private int reservedBytes = 8192;
  private String subFilter = "ETSI.CAdES.detached";

  private PdfSignOptions(CmsSigner signer) {
    this.signer = signer;
  }

  public static PdfSignOptions with(CmsSigner signer) {
    if (signer == null) throw new IllegalArgumentException("a signer is required");
    return new PdfSignOptions(signer);
  }

  public PdfSignOptions reason(String value) { this.reason = value; return this; }

  public PdfSignOptions contactInfo(String value) { this.contactInfo = value; return this; }

  /** The field's name. Defaults to one derived from the clock, which is always unique. */
  public PdfSignOptions fieldName(String value) { this.fieldName = value; return this; }

  /** The page the invisible widget is attached to. */
  public PdfSignOptions pageIndex(int value) { this.pageIndex = value; return this; }

  /** Bytes reserved for the signature. 8192 fits RSA-2048 with a timestamp. */
  public PdfSignOptions reservedBytes(int value) { this.reservedBytes = value; return this; }

  /**
   * Declared up front because it is written into the signed bytes before the CMS exists,
   * so it must match what the signer produces.
   *
   * `ETSI.CAdES.detached` is PAdES and requires CAdES-BES — a CMS carrying the
   * signingCertificateV2 signed attribute, which {@link Pkcs12Signer} adds. A plain
   * PKCS#7 under this sub-filter is rejected by strict verifiers even though the
   * signature itself is sound; pass `adbe.pkcs7.detached` for such a signer.
   */
  public PdfSignOptions subFilter(String value) { this.subFilter = value; return this; }

  public CmsSigner signer() { return signer; }

  public String reason() { return reason; }

  public String contactInfo() { return contactInfo; }

  public String fieldName() { return fieldName; }

  public int pageIndex() { return pageIndex; }

  public int reservedBytes() { return reservedBytes; }

  public String subFilter() { return subFilter; }
}
