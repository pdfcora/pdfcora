package com.pdfiumkit;

import static org.junit.jupiter.api.Assertions.*;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Reading and verifying signatures already in a document. */
class PdfSignatureTest {
  private static final Path ROOT = Path.of(System.getProperty("pdfiumkit.conformance")).getParent();
  private static final Path SIGNED = ROOT.resolve("android/demo/src/main/assets/signed.pdf");
  private static final Path CONTRACT =
      Path.of(System.getProperty("pdfiumkit.conformance")).resolve("fixtures/contract.pdf");

  @Test
  void readsASignatureAndWhatItCovers() throws IOException {
    try (PdfDocument document = PdfDocument.open(SIGNED)) {
      List<PdfSignature> signatures = document.signatures();
      assertEquals(1, signatures.size());

      PdfSignature signature = signatures.get(0);
      assertFalse(signature.subFilter().isEmpty(), "a sub-filter names the signature's flavour");
      assertEquals(4, signature.byteRange().size(), "two signed spans, around the blob");
      assertTrue(signature.contents().length > 0, "the PKCS#7 blob is there");
      assertTrue(signature.coversWholeDocument());
    }
  }

  @Test
  void verifyingAnUntouchedDocumentSucceeds() throws IOException {
    byte[] bytes = Files.readAllBytes(SIGNED);
    try (PdfDocument document = PdfDocument.open(bytes)) {
      PdfSignature.Verification result = document.signatures().get(0).verify(bytes);
      assertTrue(result.digestMatches(), result.detail());
      assertTrue(result.detail().contains("unchanged"));
    }
  }

  @Test
  void verifyingDetectsAChangeToTheSignedBytes() throws IOException {
    byte[] bytes = Files.readAllBytes(SIGNED);
    PdfSignature signature;
    try (PdfDocument document = PdfDocument.open(bytes)) {
      signature = document.signatures().get(0);
    }

    // Flip a byte inside the first signed span. Nothing else about the file changes.
    byte[] tampered = bytes.clone();
    int inside = signature.byteRange().get(0) + Math.min(64, signature.byteRange().get(1) - 1);
    tampered[inside] = (byte) (tampered[inside] ^ 0x01);

    PdfSignature.Verification result = signature.verify(tampered);
    assertFalse(result.digestMatches(), result.detail());
    assertTrue(result.detail().contains("changed"));
  }

  @Test
  void aDocumentWithNoSignaturesHasNone() throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      assertEquals(List.of(), document.signatures());
    }
  }
}
