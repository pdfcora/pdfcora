import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PdfDocument } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';
const ROOT = new URL('../../', import.meta.url).pathname;
const FIXTURE = JSON.parse(readFileSync(`${ROOT}conformance/license/cases.json`, 'utf8'));
const PARTIAL = JSON.parse(readFileSync(`${ROOT}conformance/license/partial-keys.json`, 'utf8'));
const read = (file) => new Uint8Array(readFileSync(`${ROOT}conformance/corpus/${file}`));
const MARK = 'PDFCora trial';
const useKey = (key) => configureLicenseForTesting({ key, host: null });
const keyWith = (modules) => PARTIAL[modules.join(',')];
afterEach(() => useKey(FIXTURE.fullKey));
/** Grey pixels the white hello_world page does not otherwise contain. */
function greyPixels(data) {
    let count = 0;
    for (let i = 0; i < data.length; i += 4) {
        const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
        if (r < 250 && Math.abs(r - g) < 8 && Math.abs(g - b) < 8 && r > 150)
            count++;
    }
    return count;
}
async function textOfEveryPage(bytes) {
    const document = await PdfDocument.open(bytes);
    const texts = [];
    for (let i = 0; i < await document.pageCount(); i++)
        texts.push(await (await document.page(i)).text.string());
    await document.close();
    return texts;
}
describe('watermark', () => {
    test('trial render is watermarked; licensed render is not', async () => {
        await useKey(FIXTURE.fullKey);
        const licensed = await (await (await PdfDocument.open(read('hello_world.pdf'))).page(0)).render({ width: 400 });
        await useKey(null);
        const trial = await (await (await PdfDocument.open(read('hello_world.pdf'))).page(0)).render({ width: 400 });
        assert.ok(greyPixels(trial.data) > greyPixels(licensed.data) + 500, `trial ${greyPixels(trial.data)} vs licensed ${greyPixels(licensed.data)}`);
    });
    test('trial save carries the watermark on every page; licensed save does not', async () => {
        await useKey(null);
        const trialBytes = await (await PdfDocument.open(read('hello_world_2_pages_split_streams.pdf'))).toBytes();
        for (const text of await textOfEveryPage(trialBytes))
            assert.ok(text.includes(MARK));
        await useKey(FIXTURE.fullKey);
        const licensedBytes = await (await PdfDocument.open(read('hello_world_2_pages_split_streams.pdf'))).toBytes();
        for (const text of await textOfEveryPage(licensedBytes))
            assert.ok(!text.includes(MARK));
    });
    test('saving twice stamps once each time', async () => {
        await useKey(null);
        const document = await PdfDocument.open(read('hello_world.pdf'));
        await document.toBytes();
        const [text] = await textOfEveryPage(await document.toBytes());
        assert.equal(text.split(MARK).length - 1, 1);
    });
    test('an incremental save of a marked document comes back full and watermarked', async () => {
        await useKey(null);
        const original = read('hello_world.pdf');
        const bytes = await (await PdfDocument.open(original)).toBytes('incremental');
        assert.notDeepEqual(bytes.subarray(0, original.length), original);
        assert.ok((await textOfEveryPage(bytes))[0].includes(MARK));
    });
    test('an unlicensed module marks the document; a licensed one does not', async () => {
        await useKey(keyWith(['forms']));
        const document = await PdfDocument.open(read('hello_world.pdf'));
        assert.equal(document.needsWatermark, false);
        await (await document.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'x');
        assert.equal(document.needsWatermark, true);
        await useKey(keyWith(['editing']));
        const licensed = await PdfDocument.open(read('hello_world.pdf'));
        await (await licensed.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'x');
        assert.equal(licensed.needsWatermark, false);
    });
    test('unlicensed redaction still removes the text', async () => {
        await useKey(keyWith([]));
        const document = await PdfDocument.open(read('hello_world.pdf'));
        await document.redact([{ kind: 'textMatches', query: 'Hello' }]);
        const [text] = await textOfEveryPage(await document.toBytes());
        assert.ok(!text.includes('Hello'));
        assert.ok(text.includes(MARK));
    });
    test('unlicensed signing verifies in pdfsig and contains the watermark', async () => {
        await useKey(keyWith([]));
        const scratch = mkdtempSync(join(tmpdir(), 'pdfcora-license-'));
        const FIXTURES = `${ROOT}conformance/fixtures/`;
        const signer = {
            async sign(data) {
                const input = join(scratch, 'data.bin');
                writeFileSync(input, data);
                execFileSync('openssl', ['cms', '-sign', '-binary', '-nosmimecap', '-cades', '-md', 'sha256',
                    '-signer', `${FIXTURES}test-signer-cert.pem`, '-inkey', `${FIXTURES}test-signer-key.pem`,
                    '-outform', 'DER', '-in', input, '-out', `${input}.der`]);
                return new Uint8Array(readFileSync(`${input}.der`));
            },
        };
        const signed = await (await PdfDocument.open(read('hello_world.pdf'))).sign({ signer });
        assert.ok((await textOfEveryPage(signed))[0].includes(MARK));
        const path = join(scratch, 'signed.pdf');
        writeFileSync(path, signed);
        let report = '';
        try {
            report = execFileSync('pdfsig', [path], { encoding: 'utf8' });
        }
        catch (error) {
            report = String(error.stdout ?? '');
        }
        assert.match(report, /Signature is Valid/);
        assert.match(report, /Total document signed/);
    });
});
//# sourceMappingURL=license-watermark.test.js.map