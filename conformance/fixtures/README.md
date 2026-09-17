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

A self-signed identity used only to test signing. The password is `pdfcora`, and it is
committed deliberately: it signs nothing outside this repository's tests.

```
openssl req -x509 -newkey rsa:2048 -keyout test-signer-key.pem -out test-signer-cert.pem \
  -days 3650 -nodes -subj "/CN=PDFCora Test Signer/O=PDFCora/C=GB"
openssl pkcs12 -export -out test-signer.p12 \
  -inkey test-signer-key.pem -in test-signer-cert.pem -passout pass:pdfcora
openssl x509 -in test-signer-cert.pem -outform DER -out test-signer.der
```

Being self-signed, it exercises the same valid-but-untrusted case as the UNH-IOL fixture:
a document signed with it verifies cryptographically and is untrusted until
`test-signer.der` is supplied as an anchor.

## tsa/

A stubbed RFC 3161 timestamp authority, used only by the signing tests. `openssl ts`
signs genuine tokens with it, so the tests exercise real timestamping rather than a
canned reply — and, unlike a public authority, it makes the refusal paths testable and
keeps CI off the network.

```
openssl req -x509 -newkey rsa:2048 -keyout tsa/tsa-key.pem -out tsa/tsa-cert.pem \
  -days 3650 -nodes -config tsa/tsa.cnf
```

The certificate carries the `timeStamping` extended key usage, without which `openssl ts`
refuses to act as an authority.
