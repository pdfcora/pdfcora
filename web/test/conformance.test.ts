import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PdfDocument } from '../src/index.js';
import { PdfError } from '../src/errors.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/test -> repo root
const ROOT = join(HERE, '..', '..', '..');
const CORPUS = join(ROOT, 'conformance', 'corpus');

/** Must match conformance/generate.mjs exactly — see the note there on portability. */
const STRIPPED = new Set([0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x20, 0xa0, 0x2028, 0x2029, 0x202f, 0x3000]);

function normalizeText(text: string): string {
  let out = '';
  for (const ch of text) if (!STRIPPED.has(ch.codePointAt(0)!)) out += ch;
  return out;
}

function textHash(text: string): string {
  return createHash('sha256').update(normalizeText(text), 'utf8').digest('hex');
}

interface Expectations {
  engine: string;
  documents: Record<string, {
    category: string;
    opens: boolean;
    openError?: string;
    pageCount?: number;
    pages?: {
      width: number; height: number;
      charCount?: number; textSha256?: string; textContains?: string[];
    }[];
  }>;
}

const expectations: Expectations = JSON.parse(
  readFileSync(join(ROOT, 'conformance', 'expectations.json'), 'utf8'),
);

function corpus(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CORPUS, name)));
}

describe('conformance', () => {
  test('engine revision matches expectations', () => {
    assert.equal(PdfDocument.engineVersion, expectations.engine);
  });

  test('expectations file is present and non-empty', () => {
    assert.ok(Object.keys(expectations.documents).length > 0);
  });

  test('all corpus documents match expectations', async () => {
    for (const [name, expected] of Object.entries(expectations.documents)) {
      const bytes = corpus(name);

      if (!expected.opens) {
        await assert.rejects(
          () => PdfDocument.open(bytes),
          (error: unknown) => {
            assert.ok(error instanceof PdfError, `${name}: not a PdfError`);
            const matches =
              (expected.openError === 'password' &&
                (error.code === 'passwordRequired' || error.code === 'wrongPassword')) ||
              (expected.openError === 'format' && error.code === 'corrupt') ||
              (expected.openError === 'file' && error.code === 'corrupt') ||
              (expected.openError === 'security' && error.code === 'unsupportedSecurity');
            assert.ok(matches, `${name}: ${error.code} does not match ${expected.openError}`);
            return true;
          },
        );
        continue;
      }

      const document = await PdfDocument.open(bytes);
      try {
        assert.equal(await document.pageCount(), expected.pageCount, `${name}: page count`);

        for (const [i, expectedPage] of (expected.pages ?? []).entries()) {
          const page = await document.page(i);
          const size = await page.size();
          assert.ok(Math.abs(size.width - expectedPage.width) < 0.01, `${name} page ${i} width`);
          assert.ok(Math.abs(size.height - expectedPage.height) < 0.01, `${name} page ${i} height`);

          if (expectedPage.charCount !== undefined) {
            assert.equal(await page.text.characterCount(), expectedPage.charCount,
              `${name} page ${i} character count`);
          }
          if (expectedPage.textSha256) {
            const text = await page.text.string();
            assert.equal(textHash(text), expectedPage.textSha256,
              `${name} page ${i} text differs from the reference engine; got ${JSON.stringify(text.slice(0, 60))}`);
            for (const anchor of expectedPage.textContains ?? []) {
              assert.ok(text.replace(/\s+/g, ' ').trim().includes(anchor),
                `${name} page ${i} missing expected text ${JSON.stringify(anchor)}`);
            }
          }
        }
      } finally {
        await document.close();
      }
    }
  });

  /**
   * The same positional check the Android suite runs, against the same reference
   * coordinates — so both platforms are proven to place colours identically.
   */
  test('rendered channel order puts colours in the right place', async () => {
    const document = await PdfDocument.open(corpus('rectangles.pdf'));
    try {
      const image = await (await document.page(0)).render({ width: 200, height: 300 });
      const pixel = (x: number, y: number) => {
        const i = (y * image.width + x) * 4;
        return [image.data[i], image.data[i + 1], image.data[i + 2]];
      };
      assert.deepEqual(pixel(99, 50), [0, 0, 255], 'blue region');
      assert.deepEqual(pixel(156, 142), [0, 255, 0], 'green region');
      assert.deepEqual(pixel(90, 221), [255, 0, 0], 'red region');
    } finally {
      await document.close();
    }
  });

  test('render honours aspect ratio', async () => {
    const document = await PdfDocument.open(corpus('combobox_form.pdf'));
    try {
      const image = await (await document.page(0)).render({ width: 300 });
      assert.equal(image.width, 300);
      assert.equal(image.height, 600);   // page is 300x600 points
    } finally {
      await document.close();
    }
  });
});
