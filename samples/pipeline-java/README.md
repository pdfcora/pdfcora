# Pipeline — Java

What a server does to a document nobody will open by hand: tag it for accessibility,
sign it, then sign it again and show the first signature still verifies. Everything is
in `src/main/java/Main.java`.

```bash
(cd ../.. && ./scripts/fetch-vendor.sh && ./scripts/build-jni.sh)
gradle run
```

The three steps, and why each is worth seeing:

1. **Tag.** `sample.pdf` has no structure tree, so a screen reader hears one run of text.
   Every drawing object goes into a block in reading order; anything left out becomes an
   artifact, which is what makes the result conformant rather than merely tagged. The
   output passes veraPDF's PDF/UA-1 check — `./scripts/verapdf-ua1.sh out.pdf` says so.
2. **Sign.** The CMS is built by the JDK through JCA, with no Bouncy Castle, and carries
   the CAdES `signingCertificateV2` attribute. Poppler agrees: `pdfsig out.pdf`.
3. **Countersign.** The second signature is appended as an incremental update, so the
   bytes the first one covered are untouched and it keeps verifying — it simply no longer
   reaches the end of the file, which the sample prints.

`identity.p12` is the repository's self-signed test identity, password `pdfiumkit`. It
signs nothing outside these samples; a real service holds its key in an HSM or a signing
service and implements `CmsSigner` instead.
