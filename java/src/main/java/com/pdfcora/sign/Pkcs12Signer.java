package com.pdfcora.sign;

import com.pdfcora.PdfError;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.GeneralSecurityException;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.security.Signature;
import java.security.cert.X509Certificate;
import java.util.Enumeration;

/**
 * Signs with a PKCS#12 identity, using JCA.
 *
 * Unlike web, the JVM needs no application-supplied CMS: the platform can build one. The
 * CAdES signingCertificateV2 attribute is added so the default ETSI.CAdES.detached
 * sub-filter is honest about what the CMS contains. No Bouncy Castle.
 */
public final class Pkcs12Signer implements CmsSigner {
  private static final String OID_RSA = "1.2.840.113549.1.1.1";
  private static final String OID_ECDSA_SHA256 = "1.2.840.10045.4.3.2";

  private final PrivateKey key;
  private final X509Certificate certificate;
  private final String algorithm;
  private final String signatureOid;

  public Pkcs12Signer(byte[] pkcs12, String password) {
    char[] secret = password == null ? new char[0] : password.toCharArray();
    try {
      KeyStore store = KeyStore.getInstance("PKCS12");
      store.load(new ByteArrayInputStream(pkcs12), secret);

      String found = null;
      for (Enumeration<String> aliases = store.aliases(); aliases.hasMoreElements(); ) {
        String alias = aliases.nextElement();
        if (store.isKeyEntry(alias)) { found = alias; break; }
      }
      if (found == null) {
        throw new PdfError(PdfError.Code.INVALID_OPERATION, "sign: the PKCS#12 has no key entry");
      }

      key = (PrivateKey) store.getKey(found, secret);
      certificate = (X509Certificate) store.getCertificate(found);
    } catch (GeneralSecurityException | IOException e) {
      throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "sign: the PKCS#12 could not be read (" + e.getMessage() + ")");
    }

    // Only the two key types PDF signing meets in practice; anything else is refused
    // here rather than producing a CMS that names an algorithm it did not use.
    switch (key.getAlgorithm()) {
      case "RSA" -> { algorithm = "SHA256withRSA"; signatureOid = OID_RSA; }
      case "EC" -> { algorithm = "SHA256withECDSA"; signatureOid = OID_ECDSA_SHA256; }
      default -> throw new PdfError(PdfError.Code.INVALID_OPERATION,
          "sign: " + key.getAlgorithm() + " keys are not supported; use RSA or EC");
    }
  }

  public static Pkcs12Signer of(Path pkcs12, String password) throws IOException {
    return new Pkcs12Signer(Files.readAllBytes(pkcs12), password);
  }

  /** The certificate the signature will name, for an application that wants to show it. */
  public X509Certificate certificate() {
    return certificate;
  }

  @Override
  public byte[] sign(byte[] data) {
    return CmsBuilder.signedData(data, certificate, signatureOid, attributes -> {
      try {
        Signature signature = Signature.getInstance(algorithm);
        signature.initSign(key);
        signature.update(attributes);
        return signature.sign();
      } catch (GeneralSecurityException e) {
        throw new PdfError(PdfError.Code.SAVE_FAILED, "sign: " + e.getMessage());
      }
    });
  }
}
