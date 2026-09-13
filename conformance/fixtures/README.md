# Test fixtures

`unh-iol-signer.der` is the signer certificate from `conformance/corpus/signed_unh_iol.pdf`,
extracted with OpenSSL rather than with this SDK:

```
pdfsig -dump conformance/corpus/signed_unh_iol.pdf
openssl pkcs7 -inform DER -in signed_unh_iol.pdf.sig0 -print_certs -outform PEM \
  | openssl x509 -outform DER -out conformance/fixtures/unh-iol-signer.der
```

It lives beside the corpus so all three platforms check against the same bytes.
It exists so the CMS reader's certificate boundaries are checked against a tool that
does not share its code. A bug in our parser cannot be confirmed by our own output.

## test-signer.p12, test-signer-cert.pem, test-signer-key.pem, test-signer.der

A self-signed identity used only to test signing. The password is `pdfiumkit`, and it is
committed deliberately: it signs nothing outside this repository's tests.

```
openssl req -x509 -newkey rsa:2048 -keyout test-signer-key.pem -out test-signer-cert.pem \
  -days 3650 -nodes -subj "/CN=PdfiumKit Test Signer/O=PdfiumKit/C=GB"
openssl pkcs12 -export -out test-signer.p12 \
  -inkey test-signer-key.pem -in test-signer-cert.pem -passout pass:pdfiumkit
openssl x509 -in test-signer-cert.pem -outform DER -out test-signer.der
```

Being self-signed, it exercises the same valid-but-untrusted case as the UNH-IOL fixture:
a document signed with it verifies cryptographically and is untrusted until
`test-signer.der` is supplied as an anchor.
