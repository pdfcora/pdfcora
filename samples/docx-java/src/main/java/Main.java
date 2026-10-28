import com.pdfcora.PdfDocument;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

/**
 * A Word file opened as a PDF: the SDK converts the DOCX on open, and from there it is an
 * ordinary document — text, render, save.
 *
 *   gradle run
 */
public final class Main {
  public static void main(String[] args) throws Exception {
    // The same call as for a PDF. The bytes say it is a DOCX, so it is converted first.
    try (PdfDocument document = PdfDocument.open(Path.of("sample.docx"))) {
      System.out.println("Pages           " + document.pageCount());
      System.out.println("First line      " + document.page(0).text().split("\n")[0]);

      BufferedImage image = document.page(0).render(900);
      ImageIO.write(image, "png", new File("page-1.png"));
      System.out.println("Wrote           page-1.png (" + image.getWidth()
          + "×" + image.getHeight() + ")");

      // Saving gives a PDF, not a DOCX.
      byte[] saved = document.toByteArray();
      Files.write(Path.of("out.pdf"), saved);
      System.out.println("Saved           " + saved.length + " bytes to out.pdf");
    }
  }
}
