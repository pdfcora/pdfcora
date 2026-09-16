package com.pdfiumkit.sign;

/**
 * Produces a detached CMS SignedData over `data`.
 *
 * Given the data rather than a digest: every CMS API wants the content, computes the
 * digest itself and puts it in the signed attributes. Passing only a digest would force
 * each implementation to hand-build them.
 *
 * {@link Pkcs12Signer} is the one the SDK ships; an application holding its key in an
 * HSM, a smart card or a remote service implements this instead.
 */
public interface CmsSigner {
  byte[] sign(byte[] data);
}
