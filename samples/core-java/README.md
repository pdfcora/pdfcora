# Core — Java

The core API with no UI: open a PDF, read its facts, get page text, search, list form
fields, render a page to a PNG, save. Everything is in `src/main/java/Main.java`.

```bash
(cd ../.. && ./scripts/fetch-vendor.sh && ./scripts/build-jni.sh)   # the native engine
gradle run
```

`build-jni.sh` builds the engine for this platform into the jar; without it the first
call fails with a clear message. Nothing else to configure — the library is loaded from
inside the jar.

The document owns one thread, so this is a try-with-resources rather than a hope that
the collector gets to it. Calling from several threads is safe: the calls serialise.
