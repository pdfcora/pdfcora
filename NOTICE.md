# Third-party notices

PDFCora is distributed as a compiled binary that statically links PDFium and the
third-party libraries PDFium bundles. The notices below cover everything verified to
be present in the shipped artifacts.

**How this list was produced:** the engine entries by inspecting the shipped
`libpdfium.a` — reading its exported symbols and constituent object files — rather than
from the build configuration alone, and each was confirmed to be compiled in. The Rust
entries of the Java SDK come from `cargo tree`. See "Verification" at the end for the
commands, and "Scope" for what this does not cover.

Engine revision: PDFium `chromium/7243`, built with
`pdf_enable_v8=false pdf_enable_xfa=false pdf_is_complete_lib=true`. The Android and
Linux builds also pass `pdf_bundle_freetype=true`; the iOS and macOS builds do not set
it, and FreeType is compiled into them all the same (see "Verification").
`vendor.manifest.json` records the flag list with `pdf_bundle_freetype=true`.

Full licence texts are in each project's repository or crate, at the links below.

---

## PDFium

Copyright 2014 The PDFium Authors. Licensed under BSD-3-Clause.

https://pdfium.googlesource.com/pdfium/+/refs/heads/main/LICENSE

---

## FreeType

PDFCora bundles FreeType (PDFium DEPS revision `320b72a2955a312f2a392bede8d6af900aec924d`,
copyright header 1996-2024). FreeType is dual-licensed under the FreeType License (FTL)
and GPLv2.

**PDFCora uses FreeType under the FreeType License (FTL).**

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

## Java SDK only: the DOCX converter

The Java SDK's native library (`libpdfcora_jni`) also statically links a Rust DOCX to PDF
converter built from `java/src/main/rust`. The iOS, Android and web binaries do not
contain it. Its main parts:

- **docxide-pdf** 0.19.1 — Copyright the docxide-pdf authors
  (github.com/sverrejb/docxide-pdf). Licensed under Apache-2.0.
- **Zstandard** (C, through `zstd-sys` 2.1.2+zstd.1.5.7) — Copyright Meta Platforms, Inc.
  and affiliates. Licensed under BSD-3-Clause.
- **libbzip2-rs** (`libbz2-rs-sys` 0.2.5, a Rust port of bzip2 1.0.6) — under the
  bzip2-1.0.6 licence (BSD-style).

Every Rust crate linked in, with the licence its manifest declares (where a crate offers a
choice, PDFCora takes the permissive option listed first):

- **MIT OR Apache-2.0**: aes@0.9.3, arrayvec@0.7.8, bitflags@2.13.2, block-buffer@0.12.1, bumpalo@3.20.3, bzip2@0.6.1, cfg-if@1.0.5, cipher@0.5.2, cpubits@0.1.1, cpufeatures@0.3.1, crc32fast@1.5.3, crypto-common@0.2.2, deranged@0.5.9, digest@0.11.3, fdeflate@0.3.7, flate2@1.1.10, font-types@0.11.3, getrandom@0.4.3, gif@0.14.2, half@2.7.1, hashbrown@0.17.1, hmac@0.13.0, hybrid-array@0.4.15, image@0.25.10, inout@0.2.5, itoa@1.0.18, libc@0.2.191, log@0.4.34, memmap2@0.9.12, num-conv@0.2.2, num-traits@0.2.19, pbkdf2@0.13.0, pdf-writer@0.14.0, png@0.18.1, polycool@0.4.0, powerfmt@0.2.1, proc-macro2@1.0.107, quote@1.0.47, read-fonts@0.39.2, roxmltree@0.21.2, sha1@0.11.0, sha2@0.11.1, skrifa@0.42.1, smallvec@1.16.4, subsetter@0.2.6, syn@2.0.119, syn@3.0.9, time-core@0.1.9, time@0.3.55, ttf-parser@0.25.1, typed-path@0.12.4, typenum@1.20.1, weezl@0.1.12, write-fonts@0.48.1
- **Apache-2.0 OR MIT**: cmov@0.5.4, const-oid@0.10.2, ctutils@0.4.6, equivalent@1.0.3, indexmap@2.14.2, kurbo@0.13.1, rustc-hash@2.1.3, zeroize@1.9.1
- **MIT**: color_quant@1.1.0, deflate64@0.1.12, fax@0.2.7, simd-adler32@0.3.10, tiff@0.11.3, zip@8.6.0, zstd@0.13.3
- **Apache-2.0**: docxide-pdf@0.19.1, lzma-rust2@0.16.5, unicode-linebreak@0.1.5, zopfli@0.8.4
- **BSD-2-Clause OR Apache-2.0 OR MIT**: zerocopy-derive@0.8.63, zerocopy@0.8.63
- **BSD-3-Clause**: zstd-safe@7.3.0, zstd-sys@2.1.2+zstd.1.5.7
- **BSD-3-Clause OR Apache-2.0**: moxcms@0.8.1, pxfm@0.1.30
- **MIT OR Apache-2.0 OR Zlib**: zune-core@0.5.3, zune-jpeg@0.5.15
- **MIT OR Zlib OR Apache-2.0**: miniz_oxide@0.8.9, miniz_oxide@0.9.1
- **Unlicense OR MIT**: byteorder-lite@0.1.0, memchr@2.8.3
- **Zlib OR Apache-2.0 OR MIT**: bytemuck@1.25.2, bytemuck_derive@1.12.1
- **(MIT OR Apache-2.0) AND Unicode-3.0**: unicode-ident@1.0.27
- **0BSD OR MIT OR Apache-2.0**: adler2@2.0.1
- **Apache-2.0 OR BSL-1.0**: ryu@1.0.23
- **CC0-1.0 OR MIT-0**: ppmd-rust@1.5.2
- **CC0-1.0 OR MIT-0 OR Apache-2.0**: constant_time_eq@0.4.2
- **MIT/Apache-2.0**: quick-error@2.0.1
- **Zlib**: zlib-rs@0.6.8
- **bzip2-1.0.6**: libbz2-rs-sys@0.2.5

Produced from the build, not by hand:

```bash
cd java/src/main/rust
cargo +1.92 tree -e normal --target aarch64-apple-darwin --prefix none --format '{p}|{l}' | sort -u
```

The Linux targets resolve the same set.

## Verification

The bundled set was confirmed against the shipped binary:

```bash
A=vendor/ios/pdfium.xcframework/ios-arm64/libpdfium.a
nm -gjU "$A" | grep -cE '^_FT_'      # FreeType:  217 symbols
ar t "$A" | grep -E '^(agg|ft|cms|opj|jpeg)'   # object files by origin
strings -a "$A" | grep -oE '(in|de)flate 1\.[0-9.]+'   # zlib 1.3.1
```

libpng is **not** linked (zero `png_*` symbols), so no libpng notice is required.

## Scope and limits

This list covers the libraries in the distributed binaries: the engine libraries were
verified by binary inspection, and the Rust crates are those `cargo tree` resolves for the
converter's build. In particular:

- For the engine libraries, version numbers were taken from embedded strings and
  PDFium's `DEPS` where available; of those, only zlib (1.3.1) and FreeType (revision
  pin) are pinned precisely here. Every Rust crate is listed at its exact version.
- Symbols that are statically dead-stripped from a consumer's final application may
  mean some of these are not present in an end product, but the notices are retained
  because PDFCora itself ships them.
- A licence that requires shipping full licence text with **source** redistribution —
  the FTL does — applies if you redistribute PDFium or FreeType sources, which
  PDFCora does not.

This file is not legal advice; review it with counsel for your own distribution.
