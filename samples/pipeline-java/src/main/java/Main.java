import com.pdfcora.PdfDocument;
import com.pdfcora.PdfSignature;
import com.pdfcora.PdfTagBlock;
import com.pdfcora.sign.PdfSignOptions;
import com.pdfcora.sign.PdfSigning;
import com.pdfcora.sign.Pkcs12Signer;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;

/**
 * What a server does to a document nobody will ever open by hand: make it accessible,
 * then sign it, then check the signature is what it claims.
 *
 *   gradle run
 */
public final class Main {
  public static void main(String[] args) throws Exception {
    Pkcs12Signer signer = new Pkcs12Signer(Files.readAllBytes(Path.of("identity.p12")), "pdfcora");

    byte[] tagged = tag();
    byte[] signed = sign(tagged, signer);
    byte[] countersigned = countersign(signed, signer);

    Files.write(Path.of("out.pdf"), countersigned);
    System.out.println("\nWrote out.pdf (" + countersigned.length + " bytes).");
  }

  /** Step 1: give an untagged document a structure tree, so a screen reader can read it. */
  private static byte[] tag() throws Exception {
    try (PdfDocument pdf = PdfDocument.open(Path.of("sample.pdf"))) {
      System.out.println("Tagged before   " + pdf.isTagged());

      // Every drawing object goes into a block, in reading order. Anything left out
      // becomes an artifact — content a screen reader skips — which is what makes the
      // result conformant rather than merely tagged.
      List<PdfTagBlock> blocks = new ArrayList<>();
      for (int page = 0; page < pdf.pageCount(); page++) {
        for (int object = 0; object < pdf.objectCount(page); object++) {
          String type = page == 0 && object == 0 ? "H1" : "P";
          blocks.add(new PdfTagBlock(page, type, List.of(object)));
        }
      }

      // A title is required: PDF/UA is what this claims, and a reader announces it.
      try (PdfDocument tagged = pdf.tagContent(blocks, "Quarterly newsletter", "en")) {
        System.out.println("Tagged after    " + tagged.isTagged()
            + " (" + blocks.size() + " blocks)");
        return tagged.toByteArray();
      }
    }
  }

  /** Step 2: sign it. The CMS is built by the JDK — no Bouncy Castle. */
  private static byte[] sign(byte[] tagged, Pkcs12Signer signer) {
    // Signing bytes rather than a document appends to exactly these bytes, which is
    // what keeps the signature's byte range naming what it signed.
    byte[] signed = PdfSigning.sign(tagged, PdfSignOptions.with(signer)
        .reason("Published by the newsletter service")
        .fieldName("Publisher"));

    try (PdfDocument pdf = PdfDocument.open(signed)) {
      report(pdf, signed);
    }
    return signed;
  }

  /**
   * Step 3: sign it a second time. The signature is appended as an incremental update,
   * so the first one still verifies — the bytes it covered were never rewritten.
   */
  private static byte[] countersign(byte[] signed, Pkcs12Signer signer) {
    byte[] twice = PdfSigning.sign(signed, PdfSignOptions.with(signer)
        .reason("Approved by the reviewer")
        .fieldName("Reviewer"));

    System.out.println();
    try (PdfDocument pdf = PdfDocument.open(twice)) {
      report(pdf, twice);
    }
    return twice;
  }

  private static void report(PdfDocument pdf, byte[] bytes) {
    for (PdfSignature signature : pdf.signatures()) {
      PdfSignature.Verification result = signature.verify(bytes);
      System.out.printf("Signature %d     %s%n", signature.index(), signature.reason());
      System.out.printf("                %s%n", result.detail());
      // A signature can be sound and still cover only part of the file: anything
      // appended afterwards — such as the second signature — is outside its range.
      System.out.printf("                covers the whole file: %s%n",
          signature.coversWholeDocument());
    }
  }
}
