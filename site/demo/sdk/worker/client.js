/**
 * Main-thread client for the PDFium worker.
 *
 * The returned document and page objects have the same shape as the in-process
 * {@link PdfDocument} and {@link PdfPage}, so calling code is identical. What you gain
 * is {@link PdfWorker.terminate}: PDFium can hang on a malformed page in a way no
 * cancellation can interrupt, and terminating the worker is the only way out.
 */
import { PdfError } from '../errors.js';
/** Owns the Worker and multiplexes calls onto it. */
export class PdfWorker {
    worker;
    pending = new Map();
    nextId = 1;
    terminated = false;
    ready;
    callTimeoutMs;
    watchdog;
    constructor(options) {
        this.callTimeoutMs = options.callTimeoutMs ?? 30_000;
        this.worker = new Worker(options.workerUrl, { type: 'module' });
        this.worker.onmessage = (event) => this.settle(event.data);
        this.worker.onerror = (event) => this.rejectAll(new Error(`worker error: ${event.message}`));
        this.ready = this.send({
            op: 'init',
            glueUrl: String(options.glueUrl),
            wasmUrl: String(options.wasmUrl),
        });
    }
    settle(response) {
        const entry = this.pending.get(response.id);
        if (!entry)
            return;
        this.pending.delete(response.id);
        // Any answer is progress, so the deadline restarts for whatever is still pending.
        this.armWatchdog();
        if (response.ok) {
            entry.resolve(response.result);
        }
        else {
            const { code, message, detail } = response.error;
            entry.reject(code ? new PdfError(code, message, detail) : new Error(message));
        }
    }
    rejectAll(error) {
        for (const entry of this.pending.values())
            entry.reject(error);
        this.pending.clear();
        this.armWatchdog();
    }
    /**
     * Restarts the deadline, or clears it when nothing is pending. Only answers restart
     * it, never new calls: calls queued behind a hung one must not keep it alive.
     */
    armWatchdog() {
        clearTimeout(this.watchdog);
        this.watchdog = undefined;
        if (this.terminated || this.pending.size === 0)
            return;
        this.watchdog = setTimeout(() => {
            this.terminated = true;
            this.worker.terminate();
            this.rejectAll(PdfError.engineUnresponsive());
        }, this.callTimeoutMs);
    }
    /** @internal */
    send(request, transfer) {
        if (this.terminated)
            return Promise.reject(PdfError.closed());
        const id = this.nextId++;
        return new Promise((resolve, reject) => {
            this.pending.set(id, { resolve, reject });
            if (this.pending.size === 1)
                this.armWatchdog();
            this.worker.postMessage({ ...request, id }, transfer ?? []);
        });
    }
    async open(bytes, password) {
        await this.ready;
        // Copy before transferring: the caller's array stays usable.
        const buffer = bytes.slice().buffer;
        const result = (await this.send({ op: 'open', bytes: buffer, password }, [buffer]));
        return new PdfWorkerDocument(this, result.docId, result.pageCount);
    }
    /**
     * Kills the worker. Every in-flight call rejects with a `cancelled` error.
     *
     * This is the only way to recover from a document that hangs PDFium's renderer, and
     * the reason this client exists. The worker cannot be reused afterwards; construct
     * a new {@link PdfWorker}.
     */
    terminate() {
        if (this.terminated)
            return;
        this.terminated = true;
        this.worker.terminate();
        this.rejectAll(PdfError.cancelled());
    }
    get isTerminated() {
        return this.terminated;
    }
}
/** Same surface as the in-process `PdfDocument`, executed in the worker. */
export class PdfWorkerDocument {
    worker;
    docId;
    knownPageCount;
    constructor(worker, docId, knownPageCount) {
        this.worker = worker;
        this.docId = docId;
        this.knownPageCount = knownPageCount;
    }
    call(method, args = [], pageIndex) {
        return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex });
    }
    pageCount() {
        return this.call('pageCount');
    }
    async page(index) {
        if (index < 0 || index >= this.knownPageCount) {
            throw PdfError.pageOutOfRange(index, this.knownPageCount);
        }
        return new PdfWorkerPage(this.worker, this.docId, index);
    }
    permissions() { return this.call('permissions'); }
    metadata() { return this.call('metadata'); }
    metadataValue(key) {
        return this.call('metadataValue', [key]);
    }
    attachments() { return this.call('attachments'); }
    outline() { return this.call('outline'); }
    pageSize(index) { return this.call('pageSize', [], index); }
    rotation(index) {
        return this.call('rotation', [], index);
    }
    setRotation(index, rotation) {
        return this.call('setRotation', [rotation], index);
    }
    async toBytes(mode = 'full') {
        return new Uint8Array((await this.call('toBytes', [mode])));
    }
    close() {
        return this.worker.send({ op: 'close', docId: this.docId });
    }
}
/** Same surface as the in-process `PdfPage`, executed in the worker. */
export class PdfWorkerPage {
    worker;
    docId;
    index;
    constructor(worker, docId, index) {
        this.worker = worker;
        this.docId = docId;
        this.index = index;
    }
    call(method, args = []) {
        return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex: this.index });
    }
    size() { return this.call('pageSize'); }
    async render(options = {}) {
        const result = (await this.call('page.render', [options]));
        return { width: result.width, height: result.height, data: new Uint8ClampedArray(result.data) };
    }
    annotations() { return this.call('page.annotations'); }
    formFields() { return this.call('page.formFields'); }
    addInk(strokes, color, lineWidth) {
        return this.call('page.addInk', [strokes, color, lineWidth]);
    }
    addNote(rect, contents, color) {
        return this.call('page.addNote', [rect, contents, color]);
    }
    removeAnnotation(annotationIndex) {
        return this.call('page.removeAnnotation', [annotationIndex]);
    }
    setText(value, fieldAt) {
        return this.call('page.setText', [value, fieldAt]);
    }
    setChecked(checked, fieldAt) {
        return this.call('page.setChecked', [checked, fieldAt]);
    }
    setOption(optionIndex, selected, fieldAt) {
        return this.call('page.setOption', [optionIndex, selected, fieldAt]);
    }
    get text() {
        return new PdfWorkerTextPage(this.worker, this.docId, this.index);
    }
}
export class PdfWorkerTextPage {
    worker;
    docId;
    pageIndex;
    constructor(worker, docId, pageIndex) {
        this.worker = worker;
        this.docId = docId;
        this.pageIndex = pageIndex;
    }
    call(method, args = []) {
        return this.worker.send({ op: 'call', docId: this.docId, method, args, pageIndex: this.pageIndex });
    }
    string() { return this.call('page.text.string'); }
    characterCount() { return this.call('page.text.characterCount'); }
    search(query, options) {
        return this.call('page.text.search', [query, options]);
    }
}
//# sourceMappingURL=client.js.map