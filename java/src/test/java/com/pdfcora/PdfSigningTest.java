package com.pdfcora;

import static org.junit.jupiter.api.Assertions.*;

import com.pdfcora.sign.PdfSignOptions;
import com.pdfcora.sign.PdfSigning;
import com.pdfcora.sign.Pkcs12Signer;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import org.junit.jupiter.api.Test;

/** Creating a signature, and what a verifier makes of it afterwards. */
class PdfSigningTest {
  private static final Path CONFORMANCE = Path.of(System.getProperty("pdfcora.conformance"));
  private static final Path CONTRACT = CONFORMANCE.resolve("fixtures/contract.pdf");
  private static final Path PKCS12 = CONFORMANCE.resolve("fixtures/test-signer.p12");

  private static Pkcs12Signer signer() throws IOException {
    return new Pkcs12Signer(Files.readAllBytes(PKCS12), "pdfcora");
  }

  @Test
  void aSignedDocumentCarriesASignatureThatVerifies() throws IOException {
    byte[] signed = sign(PdfSignOptions.with(signer()));

    try (PdfDocument document = PdfDocument.open(signed)) {
      List<PdfSignature> signatures = document.signatures();
      assertEquals(1, signatures.size());

      PdfSignature signature = signatures.get(0);
      assertEquals("ETSI.CAdES.detached", signature.subFilter());
      assertEquals(4, signature.byteRange().size(), "two signed spans, around the blob");
      assertTrue(signature.coversWholeDocument(), "nothing follows the signature");

      PdfSignature.Verification result = signature.verify(signed);
      assertTrue(result.digestMatches(), result.detail());
    }
  }

  @Test
  void theReasonAndContactAreRecordedInTheDocument() throws IOException {
    byte[] signed = sign(PdfSignOptions.with(signer())
        .reason("I approve this contract")
        .contactInfo("signer@example.com")
        .fieldName("Approval"));

    try (PdfDocument document = PdfDocument.open(signed)) {
      assertEquals("I approve this contract", document.signatures().get(0).reason());
    }
    assertTrue(new String(signed, java.nio.charset.StandardCharsets.ISO_8859_1)
        .contains("signer@example.com"), "the contact goes into the signature dictionary");
  }

  @Test
  void touchingTheSignedBytesBreaksVerification() throws IOException {
    byte[] signed = sign(PdfSignOptions.with(signer()));

    try (PdfDocument document = PdfDocument.open(signed)) {
      PdfSignature signature = document.signatures().get(0);
      byte[] tampered = signed.clone();
      // The first signed span starts at the header, so any byte in it is covered.
      tampered[20] = (byte) (tampered[20] ^ 0x01);

      PdfSignature.Verification result = signature.verify(tampered);
      assertFalse(result.digestMatches());
      assertTrue(result.detail().contains("changed"), result.detail());
    }
  }

  @Test
  void aSecondSignatureLeavesTheFirstOneVerifying() throws IOException {
    byte[] once = sign(PdfSignOptions.with(signer()).fieldName("First"));
    // Appended rather than re-saved, which is the whole point of an incremental update.
    byte[] twice = PdfSigning.sign(once, PdfSignOptions.with(signer()).fieldName("Second"));

    try (PdfDocument document = PdfDocument.open(twice)) {
      List<PdfSignature> signatures = document.signatures();
      assertEquals(2, signatures.size());
      for (PdfSignature signature : signatures) {
        assertTrue(signature.verify(twice).digestMatches(),
            "signature " + signature.index() + ": " + signature.verify(twice).detail());
      }
      assertFalse(signatures.get(0).coversWholeDocument(),
          "the first signature no longer reaches the end of the file");
      assertTrue(signatures.get(1).coversWholeDocument());
    }
  }

  @Test
  void aSignatureTooLargeForItsReserveIsRefused() throws IOException {
    PdfError error = assertThrows(PdfError.class,
        () -> sign(PdfSignOptions.with(signer()).reservedBytes(512)));
    assertTrue(error.getMessage().contains("reservedBytes"), error.getMessage());
  }

  @Test
  void theSignedRangesLeaveOnlyThePlaceholderOut() throws IOException {
    byte[] signed = sign(PdfSignOptions.with(signer()));

    try (PdfDocument document = PdfDocument.open(signed)) {
      List<Integer> range = document.signatures().get(0).byteRange();
      int gapStart = range.get(0) + range.get(1);
      int gapEnd = range.get(2);

      assertEquals('<', signed[gapStart], "the gap opens at the hex string");
      assertEquals('>', signed[gapEnd - 1], "and closes at its end");
      assertEquals(signed.length, range.get(2) + range.get(3), "the second span runs to the end");
    }
  }

  @Test
  void signingDoesNotDisturbTheDocumentItSigned() throws IOException {
    byte[] original = Files.readAllBytes(CONTRACT);
    byte[] signed = PdfSigning.sign(original, PdfSignOptions.with(signer()));

    assertArrayEquals(Files.readAllBytes(CONTRACT), original, "the caller's bytes are untouched");
    assertTrue(signed.length > original.length);
    assertArrayEquals(original, java.util.Arrays.copyOf(signed, original.length),
        "the original file is still there, byte for byte, underneath");
  }

  /** Written out so a tool that shares none of this code — pdfsig — can judge it. */
  @Test
  void theResultIsWrittenForAnOutsideVerifierToJudge() throws IOException {
    byte[] signed = sign(PdfSignOptions.with(signer()).reason("Cross-checked outside this SDK"));
    Path out = CONFORMANCE.getParent().resolve("build/sign");
    Files.createDirectories(out);
    Files.write(out.resolve("signed-java.pdf"), signed);
    assertTrue(Files.size(out.resolve("signed-java.pdf")) > 0);
  }

  private static byte[] sign(PdfSignOptions options) throws IOException {
    try (PdfDocument document = PdfDocument.open(CONTRACT)) {
      return document.sign(options);
    }
  }
}
