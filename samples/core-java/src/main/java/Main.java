import com.pdfcora.PdfDocument;
import com.pdfcora.PdfPage;
import java.awt.image.BufferedImage;
import java.io.File;
import java.nio.file.Files;
import java.nio.file.Path;
import javax.imageio.ImageIO;

/**
 * The core API on the JVM: open a PDF, read its facts, get page text, search, list form
 * fields, render a page to a PNG, save.
 *
 *   gradle run
 */
public final class Main {
  public static void main(String[] args) throws Exception {
    // Nothing to configure: the engine is a native library inside the jar, loaded for
    // this platform on the first call.
    try (PdfDocument pdf = PdfDocument.open(Path.of("sample.pdf"))) {
      System.out.println("Pages           " + pdf.pageCount());
      System.out.println("Title           " + pdf.metadata().getOrDefault("Title", "(none)"));
      System.out.println("Signatures      " + pdf.signatures().size());

      PdfPage page = pdf.page(0);

      // Text, search and form fields all come from the page.
      System.out.println("First line      " + page.text().split("\n")[0]);
      System.out.println("Matches \"the\"   " + page.search("the").size());
      System.out.println("Form fields     " + page.formFields().size());

      // render hands back a BufferedImage, which ImageIO writes without any other
      // dependency.
      BufferedImage image = page.render(900);
      ImageIO.write(image, "png", new File("page-1.png"));
      System.out.println("Wrote           page-1.png (" + image.getWidth()
          + "×" + image.getHeight() + ")");

      // Saving returns the bytes; an app writes, uploads or streams them.
      byte[] saved = pdf.toByteArray();
      Files.write(Path.of("out.pdf"), saved);
      System.out.println("Saved           " + saved.length + " bytes to out.pdf");
    }
    // The document owns one thread and closing releases it, which is why this is a
    // try-with-resources rather than a hope that the collector gets to it.
  }
}
