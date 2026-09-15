import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfLicense, PdfWorker } from '../dist/index.js';
/**
 * The worker checks the license itself, against the page's hostname, so the client must
 * send both. Node has no browser Worker: the client is driven against a stand-in that
 * records `init`, and the host module is driven directly through a stand-in `self`.
 */
const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));
class RecordingWorker {
    static init;
    onmessage = null;
    onerror = null;
    postMessage(message) {
        if (message.op === 'init')
            RecordingWorker.init = message;
        setTimeout(() => this.onmessage?.({ data: { id: message.id, ok: true, result: null } }), 0);
    }
    terminate() { }
}
const replies = [];
globalThis.self = {
    postMessage: (message) => replies.shift()?.(message),
    onmessage: null,
};
async function sendToHost(request) {
    const host = globalThis.self;
    const answered = new Promise((resolve) => replies.push(resolve));
    await host.onmessage({ data: request });
    return answered;
}
describe('license in the worker', () => {
    test('the client sends the key and the hostname with init', async () => {
        globalThis.Worker = RecordingWorker;
        const worker = new PdfWorker({ workerUrl: 'w.js', glueUrl: 'g.js', wasmUrl: 'p.wasm' });
        await new Promise((resolve) => setTimeout(resolve, 10));
        assert.deepEqual(RecordingWorker.init?.license, { key: FIXTURE.fullKey, host: null });
        worker.terminate();
    });
    test('the host checks the key it is sent against the hostname it is sent', async () => {
        await import('../dist/worker/host.js');
        const init = (license) => sendToHost({
            id: 1, op: 'init', license,
            // Nothing here opens a document, so the engine glue is a stand-in.
            glueUrl: 'data:text/javascript,export default async () => ({})', wasmUrl: 'p.wasm',
        });
        assert.deepEqual(await init({ key: null, host: 'app.example.com' }), { id: 1, ok: true, result: null });
        assert.equal(PdfLicense.status.kind, 'trial');
        await init({ key: FIXTURE.fullKey, host: 'other.com' });
        assert.equal(PdfLicense.status.kind, 'trial');
        await init({ key: FIXTURE.fullKey, host: 'app.example.com' });
        assert.equal(PdfLicense.status.kind, 'licensed');
    });
});
//# sourceMappingURL=license-worker.test.js.map