#!/usr/bin/env bash
# Builds developer documentation for every SDK into one directory.
#
#   ./scripts/make-docs.sh [outdir]          builds, then serves and opens a browser
#   ./scripts/make-docs.sh --no-serve        builds only (CI)
#
# Each SDK gets a quickstart page and a full API reference, generated from the source by
# that platform's own tool — DocC, Dokka, TypeDoc and Javadoc — so the reference never
# drifts from the code.
#
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
# Serving is the default: the iOS reference is a DocC single-page app that fetches its
# content, so file:// shows a blank page. --no-serve is for CI, which only wants files.
SERVE=1
args=()
for arg in "$@"; do
    case "$arg" in
        --no-serve) SERVE=0 ;;
        --serve|--open) SERVE=1 ;;
        *) args+=("$arg") ;;
    esac
done
TARGET="${args[0]:-$ROOT/build/docs}"
mkdir -p "$TARGET"
OUT="$(cd "$TARGET" && pwd)"
WORK="$OUT/.work"
IOS_DESTINATION="${PDFIUMKIT_DOC_DESTINATION:-generic/platform=iOS}"
VERSION="$(python3 -c "import json;print(json.load(open('$ROOT/web/package.json'))['version'])")"

[ -d "$ROOT/vendor/ios" ] || { echo "missing vendor/ — run ./scripts/fetch-vendor.sh" >&2; exit 1; }

rm -rf "$OUT"/{ios,android,web,node,java,index.html,.work}
mkdir -p "$WORK"

# --- iOS: DocC ------------------------------------------------------------------
# docbuild rather than the SwiftPM docc plugin: the plugin builds for the host, and
# these sources import UIKit.
echo "==> iOS (DocC)"
xcodebuild docbuild -scheme PdfiumKit -destination "$IOS_DESTINATION" \
    -derivedDataPath "$WORK/ios-dd" > "$WORK/ios.log" 2>&1 \
    || { echo "docbuild failed — see $WORK/ios.log" >&2; exit 1; }
ARCHIVE="$(find "$WORK/ios-dd" -name "PdfiumKit.doccarchive" | head -1)"
[ -n "$ARCHIVE" ] || { echo "no doccarchive produced — see $WORK/ios.log" >&2; exit 1; }
mkdir -p "$OUT/ios"   # docc will not create a nested output parent
xcrun docc process-archive transform-for-static-hosting "$ARCHIVE" \
    --output-path "$OUT/ios/api" --hosting-base-path /ios/api > "$WORK/ios-transform.log" 2>&1 \
    || { echo "docc transform failed — see $WORK/ios-transform.log" >&2; exit 1; }
# transform-for-static-hosting rewrites every page except the archive root, which keeps
# baseUrl "/" and so 404s its own assets. Redirect it to the entry point.
cat > "$OUT/ios/api/index.html" <<'HTML'
<!doctype html><meta charset="utf-8">
<meta http-equiv="refresh" content="0; url=documentation/pdfiumkit/">
<a href="documentation/pdfiumkit/">PdfiumKit API reference</a>
HTML

# --- Android: Dokka -------------------------------------------------------------
echo "==> Android (Dokka)"
( cd "$ROOT/android" && gradle :pdfiumkit:dokkaHtml --console=plain ) > "$WORK/android.log" 2>&1 \
    || { echo "dokka failed — see $WORK/android.log" >&2; exit 1; }
mkdir -p "$OUT/android"
cp -R "$ROOT/android/pdfiumkit/build/dokka/html" "$OUT/android/api"

# --- Web: TypeDoc ---------------------------------------------------------------
echo "==> Web (TypeDoc)"
( cd "$ROOT/web" && npx --no-install typedoc --entryPoints src/index.ts \
    --tsconfig tsconfig.json --out "$OUT/web/api" --readme none \
    --excludePrivate --excludeInternal --skipErrorChecking \
    --name "PdfiumKit for Web" ) > "$WORK/web.log" 2>&1 \
    || { echo "typedoc failed — see $WORK/web.log (npm install in web/ first?)" >&2; exit 1; }

# --- Node: TypeDoc --------------------------------------------------------------
# Uses web's typedoc: the Node package is a thin layer over it and carries no doc tool
# of its own.
echo "==> Node (TypeDoc)"
( cd "$ROOT/node" && "$ROOT/web/node_modules/.bin/typedoc" --entryPoints src/index.ts \
    --tsconfig tsconfig.json --out "$OUT/node/api" --readme none \
    --excludePrivate --excludeInternal --skipErrorChecking \
    --name "PdfiumKit for Node" ) > "$WORK/node.log" 2>&1 \
    || { echo "typedoc failed — see $WORK/node.log (npm install in web/ first?)" >&2; exit 1; }

# --- Java: Javadoc --------------------------------------------------------------
echo "==> Java (Javadoc)"
( cd "$ROOT/java" && gradle javadoc --console=plain ) > "$WORK/java.log" 2>&1 \
    || { echo "javadoc failed — see $WORK/java.log" >&2; exit 1; }
mkdir -p "$OUT/java"
cp -R "$ROOT/java/build/docs/javadoc" "$OUT/java/api"

# --- Quickstarts and landing page -----------------------------------------------
page() {  # page <file> <title> <body>
    cat > "$1" <<HTML
<!doctype html>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>$2</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 16px/1.6 -apple-system, system-ui, sans-serif; max-width: 46rem;
         margin: 0 auto; padding: 2rem 1.25rem 4rem; }
  h1 { font-size: 1.7rem; margin-bottom: .25rem; }
  h2 { font-size: 1.15rem; margin-top: 2.25rem; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .87em; }
  pre { background: color-mix(in srgb, currentColor 7%, transparent); padding: .85rem 1rem;
        border-radius: 7px; overflow-x: auto; }
  a.card { display: block; padding: .9rem 1.1rem; margin: .5rem 0; border-radius: 8px;
           text-decoration: none; border: 1px solid color-mix(in srgb, currentColor 20%, transparent); }
  a.card b { display: block; font-size: 1.05rem; }
  a.card span { opacity: .7; font-size: .9rem; }
  .meta { opacity: .6; font-size: .85rem; }
  #file-warning { display: none; background: #fff3cd; color: #663c00; padding: .8rem 1rem;
                  border-radius: 7px; margin-bottom: 1.5rem; font-size: .92rem; }
</style>
<div id="file-warning">
  Opened from the filesystem. The iOS API reference will be blank — it fetches its
  content and needs a real origin. Run <code>./serve.sh</code> in this directory.
</div>
<script>if (location.protocol === 'file:') document.getElementById('file-warning').style.display = 'block';</script>
$3
HTML
}

page "$OUT/index.html" "PdfiumKit documentation" "
<h1>PdfiumKit</h1>
<p>One PDF engine — PDFium — behind five SDKs that share an object model, an error type
and a conformance suite.</p>
<a class='card' href='ios/index.html'><b>iOS</b><span>Swift 5.9, iOS 15+, async/await</span></a>
<a class='card' href='android/index.html'><b>Android</b><span>Kotlin, minSdk 23, coroutines</span></a>
<a class='card' href='web/index.html'><b>Web</b><span>TypeScript, WebAssembly, ESM</span></a>
<a class='card' href='node/index.html'><b>Node</b><span>The web SDK on the server, plus file and PNG helpers</span></a>
<a class='card' href='java/index.html'><b>Java</b><span>JNI over the native engine, Java 17+, macOS and Linux</span></a>
<h2>Shared guarantees</h2>
<ul>
  <li>Every document owns a serial executor; concurrent use is safe across documents.</li>
  <li>Errors are a closed set with the same cases on every platform.</li>
  <li>Coordinates are PDF space (bottom-left origin); <code>PdfViewTransform</code> converts.</li>
  <li>Redaction removes content from the file rather than covering it, and reports what
      it removed.</li>
  <li>Signatures are read, verified and created (PAdES, optionally timestamped).
      Integrity and trust are separate answers, and a signature reports whether it
      covers the whole file.</li>
</ul>
<h2>AI, separately</h2>
<p><code>pdfiumkit-ai</code> is an optional package. The core has no AI dependency and
never gains one &mdash; a CI check fails the build if it does. Today the package ships no
feature: it provides the availability model, the custom-provider interface and the
proposal/apply API that later features are built on.</p>
<p>Three things worth knowing before you design around it. A feature reports availability
<em>per feature</em> and re-checks on every call, because the user can turn the platform's
AI off mid-session. Availability alone does not mean a model can be prompted &mdash; a
device can report available with a prompt budget of zero &mdash; so the two are read
together. And anything that would change a document returns <em>proposals</em>; nothing is
written until your app applies the ones the user accepted.</p>
<p class='meta'>Version $VERSION · built $(date -u +%Y-%m-%d) · $(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo untracked).
Third-party licences: <a href='notice.html'>NOTICE</a>.</p>"

page "$OUT/ios/index.html" "PdfiumKit for iOS" "
<h1>PdfiumKit for iOS</h1>
<a class='card' href='api/documentation/pdfiumkit/'><b>API reference</b><span>Every public type, generated by DocC</span></a>
<p class='meta'>DocC is a single-page app: this reference only works over http, not file://.
Run <code>./serve.sh</code> in the documentation directory.</p>
<h2>Install</h2>
<p>Embed <code>PdfiumKit.xcframework</code> from a release, or add the package:</p>
<pre>.package(url: \"https://github.com/&lt;owner&gt;/PdfiumKit\", from: \"$VERSION\")</pre>
<h2>Open and render</h2>
<pre>import PdfiumKit

let document = try await PdfDocument(data: data)
let page = try await document.page(0)
let image = try await page.render(width: 1024, options: [.annotations, .forms])</pre>
<h2>Place a control over a form field</h2>
<pre>let transform = PdfViewTransform(page: try await page.size, fittingWidth: view.bounds.width)
for field in try await page.formFields() {
    let box = transform.toView(field.base.rect)   // top-left origin, ready for UIKit
}</pre>
<h2>Read a signature</h2>
<pre>for signature in try await document.signatures() {
    print(signature.subFilter ?? \"?\", signature.signingTime ?? \"?\")
    if !signature.coversWholeDocument {
        // Valid, but content was appended after signing and is not protected.
    }
}</pre>
<h2>Verify it</h2>
<pre>switch try await document.verify(signature, options: .init(trustAnchors: roots)) {
case .valid(let signer, _):     print(\"signed by\", signer.commonName ?? \"?\")
case .digestMismatch:           print(\"the bytes changed after signing\")
case .untrusted(let chain, _):  print(\"intact, but not trusted\", chain.count)
default: break
}</pre>
<p class='meta'>Integrity and trust are separate answers, and revocation is not checked.</p>
<h2>Redact it</h2>
<pre>let report = try await document.redact([
    .region(rect, pageIndex: 0),
    .textMatches(\"account number\"),
])
let clean = try await document.data(mode: .full)   // full, always</pre>
<p class='meta'>Content is removed and the page's content stream regenerated, so the
words leave the file — a black box drawn over text would leave every one of them in it.
<b>Save with full</b>; an incremental save does not write the regenerated stream at all.
Images overlapping the region are removed whole rather than repainted, and a signed
document cannot be redacted without breaking its signature.</p>
<h2>Sign it</h2>
<pre>let signer = try Pkcs12Signer(pkcs12: p12, password: password)
let signed = try await document.sign(PdfSignOptions(
    signer: signer,
    reason: \"Approved\",
    timestampUrl: URL(string: \"https://your-tsa.example/tsr\")))   // optional, PAdES B-T</pre>
<p class='meta'>Signing appends an incremental update, so a signature already on the
document keeps verifying. The first release signs invisibly: a signature is valid
without a visible appearance.</p>
<h2>Errors</h2>
<pre>do { _ = try await PdfDocument(data: data) }
catch PdfError.passwordRequired { /* prompt */ }
catch let error as PdfError { print(error.description) }</pre>
<p class='meta'><a href='../index.html'>All platforms</a></p>"

page "$OUT/android/index.html" "PdfiumKit for Android" "
<h1>PdfiumKit for Android</h1>
<a class='card' href='api/pdfiumkit/com.pdfiumkit/'><b>API reference</b><span>Every public type, generated by Dokka</span></a>
<h2>Install</h2>
<pre>dependencies { implementation(\"com.pdfiumkit:pdfiumkit:$VERSION\") }</pre>
<p>Or drop <code>pdfiumkit-release.aar</code> into <code>libs/</code>. All four ABIs are included.</p>
<h2>Open and render</h2>
<pre>val document = PdfDocument.open(bytes)
val page = document.page(0)
val bitmap = page.render(width = 1024, options = PdfRenderOptions(annotations = true, forms = true))</pre>
<p>Every call is <code>suspend</code> and runs on the document's own thread. Close it when done —
<code>PdfDocument</code> is <code>Closeable</code>.</p>
<h2>Read a signature</h2>
<pre>for (signature in document.signatures()) {
    if (!signature.coversWholeDocument) {
        // Valid, but content was appended after signing and is not protected.
    }
}</pre>
<h2>Verify it</h2>
<pre>when (val verdict = document.verify(signature, PdfVerifyOptions(trustAnchors = roots))) {
    is PdfSignatureValidity.Valid -&gt; println(verdict.signer.commonName)
    is PdfSignatureValidity.DigestMismatch -&gt; println(\"the bytes changed after signing\")
    is PdfSignatureValidity.Untrusted -&gt; println(\"intact, but not trusted\")
    else -&gt; Unit
}</pre>
<p class='meta'>Integrity and trust are separate answers, and revocation is not checked.</p>
<h2>Redact it</h2>
<pre>val report = document.redact(
    listOf(
        PdfRedactionTarget.Region(rect, pageIndex = 0),
        PdfRedactionTarget.TextMatches(\"account number\"),
    ),
)
val clean = document.toByteArray(PdfSaveMode.FULL)   // full, always</pre>
<p class='meta'>Content is removed and the page's content stream regenerated, so the
words leave the file — a black box drawn over text would leave every one of them in it.
<b>Save with full</b>; an incremental save does not write the regenerated stream at all.
Images overlapping the region are removed whole rather than repainted, and a signed
document cannot be redacted without breaking its signature.</p>
<h2>Sign it</h2>
<pre>val signed = document.sign(
    PdfSignOptions(
        signer = Pkcs12Signer(p12, password),
        reason = \"Approved\",
        timestampUrl = \"https://your-tsa.example/tsr\",   // optional, PAdES B-T
    ),
)</pre>
<p class='meta'>Signing appends an incremental update, so a signature already on the
document keeps verifying. The first release signs invisibly: a signature is valid
without a visible appearance.</p>
<h2>Place a control over a form field</h2>
<pre>val transform = PdfViewTransform.fittingWidth(page.size(), viewportPx)
page.formFields().forEach { field -> val box = transform.toView(field.base.rect) }</pre>
<p class='meta'><a href='../index.html'>All platforms</a></p>"

page "$OUT/web/index.html" "PdfiumKit for Web" "
<h1>PdfiumKit for Web</h1>
<a class='card' href='api/'><b>API reference</b><span>Every public type, generated by TypeDoc</span></a>
<h2>Install</h2>
<pre>npm install @pdfiumkit/web</pre>
<p>The <code>.wasm</code> ships inside the package and must be served from the same origin.</p>
<h2>Open and render</h2>
<pre>import { PdfDocument } from '@pdfiumkit/web';

const doc = await PdfDocument.open(bytes);
const page = await doc.page(0);
const image = await page.render({ width: 1024, annotations: true, forms: true });</pre>
<h2>Survive a hung render</h2>
<p>A malformed page can hang PDFium in native code, where it cannot be cancelled.
Run it in a worker so the page can recover by terminating it:</p>
<pre>import { PdfWorker } from '@pdfiumkit/web/worker';</pre>
<h2>Read a signature</h2>
<pre>for (const signature of await doc.signatures()) {
  if (!signature.coversWholeDocument) {
    // Valid, but content was appended after signing and is not protected.
  }
}</pre>
<h2>Verify it</h2>
<pre>const verdict = await doc.verify(signature, { trustAnchors: roots });
if (verdict.kind === 'digestMismatch') {       // the bytes changed after signing
} else if (verdict.kind === 'untrusted') {     // intact, but the issuer is unknown
} else if (verdict.kind === 'valid') {         // both
}</pre>
<p class='meta'>Integrity and trust are separate answers, and revocation is not checked.</p>
<h2>Redact it</h2>
<pre>const report = await doc.redact([
  { kind: 'region', rect, pageIndex: 0 },
  { kind: 'textMatches', query: 'account number' },
]);
const clean = await doc.toBytes('full');   // full, always</pre>
<p class='meta'>Content is removed and the page's content stream regenerated, so the
words leave the file — a black box drawn over text would leave every one of them in it.
<b>Save with full</b>; an incremental save does not write the regenerated stream at all.
Images overlapping the region are removed whole rather than repainted, and a signed
document cannot be redacted without breaking its signature.</p>
<h2>Sign it</h2>
<p>The browser has no CMS API — WebCrypto provides the primitives but not the
container — so signing takes an implementation you supply. iOS and Android sign
natively and need nothing extra.</p>
<pre>const signed = await doc.sign({
  signer: { async sign(data) { /* return a detached DER PKCS#7 */ } },
  reason: 'Approved',
});</pre>
<p class='meta'>Signing appends an incremental update, so a signature already on the
document keeps verifying. The first release signs invisibly.</p>
<h2>Place a control over a form field</h2>
<pre>const t = PdfViewTransform.fittingWidth(await page.size(), canvas.clientWidth);
for (const field of await page.formFields()) { const box = t.toViewRect(field.rect); }</pre>
<p class='meta'><a href='../index.html'>All platforms</a></p>"

page "$OUT/node/index.html" "PdfiumKit for Node" "
<h1>PdfiumKit for Node</h1>
<a class='card' href='api/'><b>API reference</b><span>Every public type, generated by TypeDoc</span></a>
<h2>Install</h2>
<pre>npm install @pdfiumkit/node</pre>
<p>A thin layer over <code>@pdfiumkit/web</code> rather than a second implementation: the
whole web API is re-exported, so anything the web SDK does &mdash; annotations, form
filling, redaction, tagging, signatures, viewer state, the AI package, the agent tools
&mdash; works unchanged on the server. The same WebAssembly engine, so nothing to compile.</p>
<h2>Open and render</h2>
<pre>import { writeFile } from 'node:fs/promises';
import { openFile, renderPng, useLicenseFromEnvironment } from '@pdfiumkit/node';

await useLicenseFromEnvironment();            // PDFIUMKIT_LICENSE_KEY
const doc = await openFile('contract.pdf');
await writeFile('page-1.png', await renderPng(await doc.page(0), { width: 1024 }));</pre>
<p class='meta'>The PNG encoder uses <code>node:zlib</code>; there is no image dependency.</p>
<h2>What Node adds</h2>
<pre>openFile(path, password?)       // read and open in one call
saveFile(doc, path, mode?)      // save straight to disk
renderPng(page, options?)       // encoded PNG bytes
renderRaw(page, options?)       // the raw RGBA buffer, for sharp or canvas
useLicenseFromEnvironment(name?) // a key from the environment, not the source</pre>
<h2>Sign it</h2>
<p>The web SDK takes a CMS implementation you supply; on Node that can be a JCA-style
library, an HSM client or a remote signing service.</p>
<pre>const signed = await doc.sign({
  signer: { async sign(data) { /* return a detached DER PKCS#7 */ } },
  reason: 'Approved',
});</pre>
<h2>Tools for AI agents</h2>
<p>The MCP server in <code>mcp/</code> runs over stdio and exposes reading, proposals and
an apply that takes only the ids a person accepted.</p>
<p class='meta'><a href='../index.html'>All platforms</a></p>"

page "$OUT/java/index.html" "PdfiumKit for Java" "
<h1>PdfiumKit for Java</h1>
<a class='card' href='api/'><b>API reference</b><span>Every public type, generated by Javadoc</span></a>
<h2>Install</h2>
<pre>implementation(\"com.pdfiumkit:pdfiumkit:$VERSION\")</pre>
<p>Java 17 or newer, macOS and Linux on x86-64 and arm64. The engine is a native library
inside the jar, reached through <b>JNI, not the Foreign Function API</b>, so it runs on the
JDK most teams already have rather than requiring 22+.</p>
<h2>Open and render</h2>
<pre>try (PdfDocument document = PdfDocument.open(Path.of(\"contract.pdf\"))) {
    BufferedImage image = document.page(0).render(1024);
    ImageIO.write(image, \"png\", new File(\"page-1.png\"));
}</pre>
<p>Every document owns one thread and every call runs on it, so calling from several
threads is safe &mdash; the calls serialise rather than corrupting memory.</p>
<h2>Read a signature</h2>
<pre>for (PdfSignature signature : document.signatures()) {
    if (!signature.coversWholeDocument()) {
        // Valid, but content was appended after signing and is not protected.
    }
    PdfSignature.Verification result = signature.verify(bytes);
}</pre>
<p class='meta'>Integrity and trust are separate answers: <code>verify</code> says whether
the signed bytes changed, not whether the certificate is trusted.</p>
<h2>Redact it</h2>
<pre>PdfRedaction.Report report = document.redact(List.of(
    new PdfRedaction.Target.Region(0, rect),
    new PdfRedaction.Target.TextMatches(\"account number\")));
byte[] clean = document.toByteArray();   // always a full save</pre>
<p class='meta'>Content is removed and the page's content stream regenerated, so the words
leave the file &mdash; a black box drawn over text would leave every one of them in it.</p>
<h2>Sign it</h2>
<pre>Pkcs12Signer signer = new Pkcs12Signer(Files.readAllBytes(identity), password);
byte[] signed = document.sign(PdfSignOptions.with(signer).reason(\"Approved\"));</pre>
<p class='meta'>The CMS is built with JCA &mdash; no Bouncy Castle &mdash; and carries the
CAdES <code>signingCertificateV2</code> attribute, so the default
<code>ETSI.CAdES.detached</code> sub-filter is honest about what it contains. Signing
appends an incremental update; <code>PdfSigning.sign(bytes, options)</code> signs bytes as
they are, which is how a second signature leaves the first one verifying.</p>
<h2>Tag an untagged document</h2>
<pre>PdfDocument tagged = document.tagContent(blocks, \"Quarterly report\", \"en\");</pre>
<p class='meta'>Objects in no block become artifacts, which is what makes the result
conformant rather than merely tagged. veraPDF judges the output in the gates.</p>
<p class='meta'><a href='../index.html'>All platforms</a></p>"

python3 - "$ROOT/NOTICE.md" "$OUT/notice.html" <<'PY'
import html, sys
src, dst = sys.argv[1], sys.argv[2]
body = html.escape(open(src).read())
open(dst, 'w').write(
    '<!doctype html><meta charset="utf-8"><title>PdfiumKit — third-party notices</title>'
    '<style>body{font:15px/1.6 -apple-system,system-ui,sans-serif;max-width:46rem;'
    'margin:0 auto;padding:2rem 1.25rem}pre{white-space:pre-wrap}</style>'
    f'<p><a href="./">Back</a></p><pre>{body}</pre>')
PY

cat > "$OUT/serve.sh" <<'HTML'
#!/usr/bin/env bash
# Serves this documentation. DocC needs a real origin; file:// will not work.
cd "$(dirname "$0")"
PORT="${1:-8080}"
echo "http://localhost:$PORT/"
python3 -m http.server "$PORT"
HTML
chmod +x "$OUT/serve.sh"

rm -rf "$WORK"
echo
echo "documentation: $OUT"

if [ "$SERVE" -eq 1 ]; then
    PORT="${PDFIUMKIT_DOC_PORT:-8080}"
    ( cd "$OUT" && python3 -m http.server "$PORT" > /dev/null 2>&1 ) &
    sleep 1
    echo "serving:       http://localhost:$PORT/  (ctrl-c to stop)"
    command -v open > /dev/null && open "http://localhost:$PORT/"
    wait
else
    echo "serve it:      $OUT/serve.sh"
fi
