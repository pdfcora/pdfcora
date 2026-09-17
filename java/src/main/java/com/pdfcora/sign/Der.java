package com.pdfcora.sign;

import java.io.ByteArrayOutputStream;
import java.math.BigInteger;

/**
 * Writing DER.
 *
 * Only what building a CMS needs. Nothing here parses: the reading side of a signature
 * is {@link com.pdfcora.PdfSignature}, which scans for one attribute and no more.
 */
final class Der {
  static final int INTEGER = 0x02;
  static final int OCTET_STRING = 0x04;
  static final int OID = 0x06;
  static final int SEQUENCE = 0x30;
  static final int SET = 0x31;
  static final int CONTEXT_0 = 0xa0;

  private Der() {}

  /** One tag-length-value triple, using the shortest legal length form. */
  static byte[] tlv(int tag, byte[] content) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(tag);
    out.writeBytes(length(content.length));
    out.writeBytes(content);
    return out.toByteArray();
  }

  private static byte[] length(int value) {
    if (value < 0x80) return new byte[] { (byte) value };

    ByteArrayOutputStream octets = new ByteArrayOutputStream();
    int shift = 24;
    while (shift > 0 && (value >>> shift) == 0) shift -= 8;
    for (; shift >= 0; shift -= 8) octets.write((value >>> shift) & 0xff);

    byte[] body = octets.toByteArray();
    byte[] out = new byte[body.length + 1];
    out[0] = (byte) (0x80 | body.length);
    System.arraycopy(body, 0, out, 1, body.length);
    return out;
  }

  static byte[] sequence(byte[]... parts) {
    return tlv(SEQUENCE, concat(parts));
  }

  static byte[] set(byte[]... parts) {
    return tlv(SET, concat(parts));
  }

  static byte[] octetString(byte[] bytes) {
    return tlv(OCTET_STRING, bytes);
  }

  static byte[] integer(BigInteger value) {
    // BigInteger's two's-complement encoding is already what DER wants, leading zero
    // for a positive value with the top bit set included.
    return tlv(INTEGER, value.toByteArray());
  }

  static byte[] integer(int value) {
    return integer(BigInteger.valueOf(value));
  }

  /** A dotted OID, packing the first two arcs as `40 * first + second`. */
  static byte[] oid(String dotted) {
    String[] arcs = dotted.split("\\.");
    if (arcs.length < 2) throw new IllegalArgumentException("bad OID " + dotted);

    ByteArrayOutputStream out = new ByteArrayOutputStream();
    out.write(Integer.parseInt(arcs[0]) * 40 + Integer.parseInt(arcs[1]));
    for (int i = 2; i < arcs.length; i++) {
      int arc = Integer.parseInt(arcs[i]);
      int shift = 28;
      while (shift > 0 && (arc >>> shift) == 0) shift -= 7;
      for (; shift > 0; shift -= 7) out.write(0x80 | ((arc >>> shift) & 0x7f));
      out.write(arc & 0x7f);
    }
    return tlv(OID, out.toByteArray());
  }

  /** How many bytes the tag and length occupy, so a value can be re-tagged in place. */
  static int headerLength(byte[] encoded) {
    if (encoded.length < 2) return encoded.length;
    int first = encoded[1] & 0xff;
    return first < 0x80 ? 2 : 2 + (first & 0x7f);
  }

  private static byte[] concat(byte[][] parts) {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    for (byte[] part : parts) out.writeBytes(part);
    return out.toByteArray();
  }
}
