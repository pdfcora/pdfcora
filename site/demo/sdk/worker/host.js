/**
 * Runs inside the Worker. Owns the real PdfDocument instances and answers RPC calls.
 *
 * A page that hangs PDFium hangs this worker — which is the point: the main thread can
 * `terminate()` it and stay responsive. See "Known limits" in the README.
 */
import { PdfDocument } from '../document.js';
import { PdfError } from '../errors.js';
import { configureEngine } from '../engine.js';
import { setKeyForHost } from '../license/state.js';
const documents = new Map();
let nextDocId = 1;
function reply(response, transfer) {
    self.postMessage(response, transfer);
}
function fail(id, error) {
    if (error instanceof PdfError) {
        reply({ id, ok: false, error: { code: error.code, message: error.message, detail: error.detail } });
    }
    else {
        reply({ id, ok: false, error: { message: String(error?.message ?? error) } });
    }
}
function requireDocument(docId) {
    const document = documents.get(docId);
    if (!document)
        throw PdfError.closed();
    return document;
}
/** Dispatches a dotted method name onto a document or one of its pages. */
async function dispatch(request) {
    const document = requireDocument(request.docId);
    const { method, args, pageIndex } = request;
    switch (method) {
        case 'pageCount': return { result: await document.pageCount() };
        case 'permissions': return { result: await document.permissions() };
        case 'metadata': return { result: await document.metadata() };
        case 'metadataValue': return { result: await document.metadataValue(args[0]) };
        case 'attachments': return { result: await document.attachments() };
        case 'outline': return { result: await document.outline() };
        case 'pageSize': return { result: await document.pageSize(pageIndex) };
        case 'rotation': return { result: await document.rotation(pageIndex) };
        case 'setRotation': return { result: await document.setRotation(pageIndex, args[0]) };
        case 'toBytes': {
            const bytes = await document.toBytes(args[0]);
            // Copy into a standalone buffer so it can be transferred without detaching
            // anything the engine still owns.
            const copy = bytes.slice().buffer;
            return { result: copy, transfer: [copy] };
        }
    }
    const page = await document.page(pageIndex);
    switch (method) {
        case 'page.render': {
            const image = await page.render(args[0]);
            const buffer = image.data.buffer;
            const result = { width: image.width, height: image.height, data: buffer };
            return { result, transfer: [buffer] };
        }
        case 'page.annotations': return { result: await page.annotations() };
        case 'page.formFields': return { result: await page.formFields() };
        case 'page.addInk': return { result: await page.addInk(args[0], args[1], args[2]) };
        case 'page.addNote': return { result: await page.addNote(args[0], args[1], args[2]) };
        case 'page.removeAnnotation': return { result: await page.removeAnnotation(args[0]) };
        case 'page.setText': return { result: await page.setText(args[0], args[1]) };
        case 'page.setChecked': return { result: await page.setChecked(args[0], args[1]) };
        case 'page.setOption': return { result: await page.setOption(args[0], args[1], args[2]) };
        case 'page.text.string': return { result: await page.text.string() };
        case 'page.text.characterCount': return { result: await page.text.characterCount() };
        case 'page.text.search': return { result: await page.text.search(args[0], args[1]) };
        default:
            throw PdfError.invalidOperation(`unknown worker method ${method}`);
    }
}
self.onmessage = async (event) => {
    const request = event.data;
    try {
        switch (request.op) {
            case 'init': {
                if (request.license)
                    await setKeyForHost(request.license.key, request.license.host);
                // A module worker cannot use importScripts, so this needs the ESM build of the
                // glue (`pdfium.esm.js`), which default-exports the factory.
                const glue = (await import(/* @vite-ignore */ request.glueUrl));
                const factory = glue.default;
                if (!factory)
                    throw new Error(`${request.glueUrl} has no default export; use the ESM build`);
                configureEngine({
                    factory: factory,
                    locateFile: (path) => (path.endsWith('.wasm') ? request.wasmUrl : path),
                });
                reply({ id: request.id, ok: true, result: null });
                return;
            }
            case 'open': {
                const document = await PdfDocument.open(new Uint8Array(request.bytes), request.password);
                const docId = nextDocId++;
                documents.set(docId, document);
                reply({ id: request.id, ok: true, result: { docId, pageCount: await document.pageCount() } });
                return;
            }
            case 'call': {
                const { result, transfer } = await dispatch(request);
                reply({ id: request.id, ok: true, result }, transfer);
                return;
            }
            case 'close': {
                const document = documents.get(request.docId);
                documents.delete(request.docId);
                await document?.close();
                reply({ id: request.id, ok: true, result: null });
                return;
            }
        }
    }
    catch (error) {
        fail(request.id, error);
    }
};
//# sourceMappingURL=host.js.map