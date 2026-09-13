# Conformance corpus attribution

The PDF files in `corpus/` are copied from the PDFium project's test resources
(`testing/resources`) at revision `chromium/7243`.

PDFium is Copyright 2014 The PDFium Authors, licensed BSD-3-Clause.
See https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE

These files are used unmodified, as test inputs only.

## signed_unh_iol.pdf

Not from PDFium. Downloaded unmodified from the University of New Hampshire
InterOperability Laboratory, which publishes it as a digital-signature test
document:

  https://www.iol.unh.edu/sites/default/files/certifydoc/UNH-IOL_Signature_Test_Doc_2026.pdf

Used as a test input only. It carries a real `adbe.pkcs7.detached` signature
over the whole file, signed by UNH-IOL on 2026-01-05, whose certificate chains
to an issuer this project does not trust — which is precisely the shape needed
to test that a valid signature and an untrusted chain are reported separately.
