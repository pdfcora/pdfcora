# Third-party notices

PdfiumKit is distributed as a compiled binary that statically links PDFium and the
third-party libraries PDFium bundles. The notices below cover everything verified to
be present in the shipped artifacts.

**How this list was produced:** by inspecting the shipped `libpdfium.a` — reading its
exported symbols and constituent object files — rather than from the build
configuration alone. Each entry below was confirmed to be compiled in. See
"Verification" at the end for the commands, and "Scope" for what this does not cover.

Engine revision: PDFium `chromium/7243`, built with
`pdf_enable_v8=false pdf_enable_xfa=false pdf_bundle_freetype=true pdf_is_complete_lib=true`.

---

## PDFium

Copyright 2014 The PDFium Authors. Licensed under BSD-3-Clause.

https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE

---

## FreeType

PdfiumKit bundles FreeType (PDFium DEPS revision `320b72a2955a312f2a392bede8d6af900aec924d`,
copyright header 1996-2024). FreeType is dual-licensed under the FreeType License (FTL)
and GPLv2.

**PdfiumKit uses FreeType under the FreeType License (FTL).**

The FTL requires the following credit, which must appear in the documentation of any
product that uses this software:

> Portions of this software are copyright © 2024 The FreeType Project
> (https://freetype.org). All rights reserved.

The FTL also restricts advertising use: the names of the FreeType authors and the
FreeType Project may not be used to endorse or promote products derived from this
software without specific prior written permission. Neutral references — "FreeType
Project", "FreeType library" — are permitted.

https://gitlab.freedesktop.org/freetype/freetype/-/blob/master/docs/FTL.TXT

---

## Little CMS (lcms2)

Colour management. MIT License.
Copyright © Marti Maria Saguer.

https://github.com/mm2/Little-CMS/blob/master/COPYING

---

## OpenJPEG

JPEG 2000 codec. BSD-2-Clause License.
Copyright © the OpenJPEG contributors.

https://github.com/uclouvain/openjpeg/blob/master/LICENSE

---

## libjpeg-turbo

JPEG codec. BSD-3-Clause and IJG licenses.
Copyright © the libjpeg-turbo contributors.

https://github.com/libjpeg-turbo/libjpeg-turbo/blob/main/LICENSE.md

---

## zlib

Compression (version 1.3.1). zlib License.
Copyright © Jean-loup Gailly and Mark Adler.

https://zlib.net/zlib_license.html

---

## Anti-Grain Geometry (AGG) 2.3

Rasteriser, as vendored by PDFium in `third_party/agg23`. Permissive
"free to use in any purpose" licence with copyright-notice retention.
Copyright © Maxim Shemanarev.

https://pdfium.googlesource.com/pdfium/+/refs/heads/main/third_party/agg23/

---

## ICU

A small number of ICU symbols are linked. Unicode License.
Copyright © Unicode, Inc.

https://github.com/unicode-org/icu/blob/main/LICENSE

---

## Verification

The bundled set was confirmed against the shipped binary:

```bash
A=vendor/ios/pdfium.xcframework/ios-arm64/libpdfium.a
nm -gjU "$A" | grep -cE '^_FT_'      # FreeType:  258 symbols
ar t "$A" | grep -E '^(agg|ft|cms|opj|jpeg)'   # object files by origin
strings -a "$A" | grep -oE '(in|de)flate 1\.[0-9.]+'   # zlib 1.3.1
```

libpng is **not** linked (zero `png_*` symbols), so no libpng notice is required.

## Scope and limits

This list covers libraries verified to be compiled into the distributed binary. It was
assembled by binary inspection, which is good evidence of what is actually shipped but
is not a substitute for legal review before public distribution. In particular:

- Version numbers were taken from embedded strings and PDFium's `DEPS` where available;
  only zlib (1.3.1) and FreeType (revision pin) are pinned precisely here.
- Symbols that are statically dead-stripped from a consumer's final application may
  mean some of these are not present in an end product, but the notices are retained
  because PdfiumKit itself ships them.
- A licence that requires shipping full licence text with **source** redistribution —
  the FTL does — applies if you redistribute PDFium or FreeType sources, which
  PdfiumKit does not.

Confirm this file with counsel before the first public release.
