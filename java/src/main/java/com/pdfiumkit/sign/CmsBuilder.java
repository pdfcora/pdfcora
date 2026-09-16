package com.pdfiumkit.sign;

import com.pdfiumkit.PdfError;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.CertificateEncodingException;
import java.security.cert.X509Certificate;
import java.util.Arrays;
import java.util.function.UnaryOperator;

/**
 * Building a detached CMS SignedData.
 *
 * The signature covers the signed attributes, which carry the digest of the content
 * rather than the content itself; that is what makes the CMS detached.
 */
final class CmsBuilder {
  private static final String OID_SIGNED_DATA = "1.2.840.113549.1.7.2";
  private static final String OID_DATA = "1.2.840.113549.1.7.1";
  private static final String OID_SHA256 = "2.16.840.1.101.3.4.2.1";
  private static final String OID_CONTENT_TYPE = "1.2.840.113549.1.9.3";
  private static final String OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4";
  /** id-aa-signingCertificateV2, which CAdES-BES requires. */
  private static final String OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47";

  private CmsBuilder() {}

  /**
   * @param signatureOid the algorithm the signature was produced with, named in the
   *                     SignerInfo so a verifier knows how to check it
   * @param sign         given the DER of the signed attributes, returns the signature
   */
  static byte[] signedData(byte[] content, X509Certificate certificate,
                           String signatureOid, UnaryOperator<byte[]> sign) {
    byte[] encoded;
    try {
      encoded = certificate.getEncoded();
    } catch (CertificateEncodingException e) {
      throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the certificate could not be encoded");
    }

    byte[] contentDigest = sha256(content);
    byte[] certificateDigest = sha256(encoded);

    byte[] attributes = Der.set(
        attribute(OID_CONTENT_TYPE, Der.oid(OID_DATA)),
        attribute(OID_MESSAGE_DIGEST, Der.octetString(contentDigest)),
        // ESSCertIDv2 with the default SHA-256 hash algorithm omitted, as allowed.
        attribute(OID_SIGNING_CERTIFICATE_V2,
            Der.sequence(Der.sequence(Der.sequence(Der.octetString(certificateDigest))))));

    // The signature covers the SET encoding, which is why the attributes are built once
    // here and reused rather than re-encoded.
    byte[] signature = sign.apply(attributes);
    if (signature == null || signature.length == 0) {
      throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: the signer returned nothing");
    }

    byte[] signerInfo = Der.sequence(
        Der.integer(1),
        Der.sequence(certificate.getIssuerX500Principal().getEncoded(),
            Der.integer(certificate.getSerialNumber())),
        Der.sequence(Der.oid(OID_SHA256)),
        // [0] IMPLICIT in the file, though the signature covered the SET form.
        Der.tlv(Der.CONTEXT_0, Arrays.copyOfRange(attributes, Der.headerLength(attributes), attributes.length)),
        Der.sequence(Der.oid(signatureOid)),
        Der.octetString(signature));

    byte[] body = Der.sequence(
        Der.integer(1),
        Der.set(Der.sequence(Der.oid(OID_SHA256))),
        Der.sequence(Der.oid(OID_DATA)),          // detached: no eContent
        Der.tlv(Der.CONTEXT_0, encoded),
        Der.set(signerInfo));

    return Der.sequence(Der.oid(OID_SIGNED_DATA), Der.tlv(Der.CONTEXT_0, body));
  }

  private static byte[] attribute(String oid, byte[] value) {
    return Der.sequence(Der.oid(oid), Der.set(value));
  }

  private static byte[] sha256(byte[] bytes) {
    try {
      return MessageDigest.getInstance("SHA-256").digest(bytes);
    } catch (NoSuchAlgorithmException e) {
      throw new PdfError(PdfError.Code.SAVE_FAILED, "SHA-256 is not available on this JVM");
    }
  }
}
