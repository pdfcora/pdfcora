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
