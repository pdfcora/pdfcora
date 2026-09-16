package com.pdfiumkit;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.Arrays;
import java.util.List;

/**
 * A digital signature already in the document.
 *
 * Reading one says what it claims; {@link #verify(byte[])} says whether the bytes still
 * match what was signed. The two are deliberately separate, because a signature can be
 * perfectly valid and still cover only part of the file.
 */
public record PdfSignature(int index, String reason, String subFilter, String signingTime,
                           List<Integer> byteRange, byte[] contents, int docMdpPermission,
                           boolean coversWholeDocument) {

  /** What a verification concluded, and why. */
  public record Verification(boolean digestMatches, String detail) {}

  /**
   * Recomputes the document's digest over the signed ranges and compares it with the one
   * inside the PKCS#7 blob.
   *
   * This answers "have the signed bytes changed since signing?", which is the question
   * that matters for a document that arrives from outside. It does **not** validate the
   * certificate chain or its trust: that needs a trust store and a policy, and belongs to
   * the application rather than to the SDK.
   */
  public Verification verify(byte[] document) {
    if (byteRange.size() < 4) return new Verification(false, "the signature has no usable ByteRange");

    byte[] expected = messageDigest(contents);
    if (expected == null) {
      return new Verification(false, "no messageDigest attribute in the signature");
    }

    String algorithm = expected.length == 32 ? "SHA-256" : expected.length == 48 ? "SHA-384"
        : expected.length == 64 ? "SHA-512" : expected.length == 20 ? "SHA-1" : null;
    if (algorithm == null) return new Verification(false, "unrecognised digest length " + expected.length);

    try {
      MessageDigest digest = MessageDigest.getInstance(algorithm);
      for (int i = 0; i + 1 < byteRange.size(); i += 2) {
        int offset = byteRange.get(i);
        int length = byteRange.get(i + 1);
        if (offset < 0 || length < 0 || offset + length > document.length) {
          return new Verification(false, "the ByteRange reaches past the file");
        }
        digest.update(document, offset, length);
      }
      byte[] actual = digest.digest();
      boolean matches = MessageDigest.isEqual(expected, actual);
      return new Verification(matches, matches
          ? "the signed bytes are unchanged (" + algorithm + ")"
          : "the signed bytes have changed since signing");
    } catch (NoSuchAlgorithmException e) {
      return new Verification(false, algorithm + " is not available on this JVM");
    }
  }

  /**
   * Finds the signed messageDigest attribute inside the PKCS#7 blob.
   *
   * A full CMS parser is not needed for this: the attribute is an OCTET STRING that
   * follows the messageDigest OID, and walking DER far enough to find it is a dozen
   * lines. Anything more — chain building, policy — is the application's.
   */
  private static byte[] messageDigest(byte[] cms) {
    // OID 1.2.840.113549.1.9.4 (messageDigest), DER-encoded.
    byte[] oid = { 0x06, 0x09, 0x2A, (byte) 0x86, 0x48, (byte) 0x86, (byte) 0xF7, 0x0D, 0x01, 0x09, 0x04 };
    for (int i = 0; i + oid.length < cms.length; i++) {
      if (!Arrays.equals(cms, i, i + oid.length, oid, 0, oid.length)) continue;
      // Followed by SET { OCTET STRING }.
      int at = i + oid.length;
      if (at + 1 >= cms.length || (cms[at] & 0xFF) != 0x31) continue;   // SET
      at += 2;
      if (at + 1 >= cms.length || (cms[at] & 0xFF) != 0x04) continue;   // OCTET STRING
      int length = cms[at + 1] & 0xFF;
      at += 2;
      if (at + length > cms.length) continue;
      return Arrays.copyOfRange(cms, at, at + length);
    }
    return null;
  }

  /** Records are value types, and these carry an array, so both are spelled out. */
  @Override
  public boolean equals(Object other) {
    return other instanceof PdfSignature s && s.index == index && Arrays.equals(s.contents, contents);
  }

  @Override
  public int hashCode() {
    return index * 31 + Arrays.hashCode(contents);
  }

  @Override
  public String toString() {
    return "PdfSignature[index=" + index + ", subFilter=" + subFilter
        + ", coversWholeDocument=" + coversWholeDocument + ", contents=" + contents.length + " bytes]";
  }
}
