import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfcora/web';
import { PdfAI, type PdfAiRequest } from '../dist/index.js';

const DIR = new URL('../../conformance/forms/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('forms-expected.json', DIR), 'utf8'));
const forms = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('forms.pdf', DIR))));
const PROFILE = {
  givenName: 'Anna', familyName: 'Schmidt', fullName: 'Anna Schmidt', dateOfBirth: '1985-03-14',
  email: 'anna.schmidt@example.com', phone: '+44 20 7946 0958', street: '221B Baker Street', postalCode: 'NW1 6XE',
  city: 'London', country: 'United Kingdom', iban: 'GB29 NWBK 6016 1331 9268 19', company: 'Example Holdings Ltd',
};
const field = async (document: PdfDocument, pageIndex: number, name: string) =>
  (await (await document.page(pageIndex)).formFields()).find((f) => f.name === name)!;

describe('form proposals', () => {
  test('without a model, the synonym list proposes exactly the expected values', async () => {
    const proposals = await new PdfAI(await forms()).forms.propose(PROFILE);
    assert.equal(proposals.modelUsed, false);
    assert.match(proposals.notice, /Check every value before filling in the form\./);
    assert.deepEqual(proposals.items.map((p) => ({ pageIndex: p.pageIndex, fieldName: p.fieldName, key: p.key, value: p.value })), EXPECTED);
    for (const p of proposals.items) {
      assert.equal(p.source, 'rules');
      assert.equal(p.id, `${p.pageIndex}:${p.annotationIndex}:${p.key}`);
    }
  });

  test('a model fills a field the synonyms cannot, and cannot override or invent', async () => {
    const provider = {
      requests: [] as PdfAiRequest[],
      async generate(request: PdfAiRequest) {
        this.requests.push(request);
        const colour = request.prompt.match(/id (\S+): name "Colour"/)?.[1];
        const newsletter = request.prompt.match(/id (\S+): name "Newsletter"/)?.[1];
        return { text: '', structured: { fields: [
          { id: colour, key: 'company' }, { id: newsletter, key: 'bogus' }, { id: '0:0', key: 'familyName' },
        ] } };
      },
    };
    const proposals = await new PdfAI(await forms(), { provider }).forms.propose(PROFILE, { pages: { from: 0, to: 0 } });
    assert.equal(proposals.modelUsed, true);
    const byName = Object.fromEntries(proposals.items.map((p) => [p.fieldName, p]));
    assert.equal(byName.Colour?.key, 'company');
    assert.equal(byName.Colour?.source, 'customProvider');
    assert.equal(byName.fname?.key, 'givenName');
    assert.equal(byName.Newsletter, undefined);
    assert.ok(!provider.requests[0]!.prompt.includes('name "fname"'), 'matched fields are not sent');
  });

  test('apply writes only the accepted values, and undo restores the form', async () => {
    const document = await forms();
    const proposals = await new PdfAI(document).forms.propose(PROFILE, { pages: { from: 0, to: 0 } });
    const accept = proposals.items.filter((p) => p.fieldName === 'fname' || p.fieldName === 'Country').map((p) => p.id);
    const applied = await proposals.apply(accept);

    const fname = await field(document, 0, 'fname');
    const country = await field(document, 0, 'Country');
    const surname = await field(document, 0, 'Surname_1');
    assert.equal(fname.kind === 'text' && fname.value, 'Anna');
    assert.deepEqual(country.kind === 'comboBox' && country.selectedIndices, [1]);
    assert.equal(surname.kind === 'text' && surname.value, '');

    const restored = await applied.undo();
    const back = await field(restored, 0, 'fname');
    assert.equal(back.kind === 'text' && back.value, '');
  });

  test('an unknown id writes nothing', async () => {
    const document = await forms();
    const proposals = await new PdfAI(document).forms.propose(PROFILE);
    await assert.rejects(proposals.apply([proposals.items[0]!.id, 'nope']), /unknown proposal: nope/);
    const fname = await field(document, 0, 'fname');
    assert.equal(fname.kind === 'text' && fname.value, '');
  });
});
