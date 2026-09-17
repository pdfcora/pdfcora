# Redaction Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Suggest likely personal data in a document (patterns everywhere, a model where one is available), show the suggestions as marks in the viewer for review, and redact the accepted ones with undo.

**Architecture:** `pdfcora-ai` finds suggestions: a pattern matcher shared in behaviour across platforms by a JSON case file, plus a model route whose quotes are verified against the text. The core gains two generic pieces with no AI in them: `PdfDocument.snapshot()` (opaque, reopenable) and viewer marks (set, hit-test, tap to cycle), which the three UI components draw with a review bar. `apply` snapshots, redacts the accepted rectangles through the existing `redact()`, re-checks the text, and returns an undo.

**Tech Stack:** TypeScript (web, web-ai), Swift 5.9 / SwiftUI (iOS 15), Kotlin 1.9 / Compose (Android minSdk 23), PDFium.

**Spec:** `docs/superpowers/specs/2026-09-15-redaction-suggestions-design.md`

## Global Constraints

- Pattern categories, in tie-break order: `iban`, `email`, `phone`, `paymentCard`, `date`, `url`, `ipAddress`.
- Model categories: `personName`, `postalAddress`, `dateOfBirth`, `idNumber`. Model quotes shorter than 3 characters are dropped.
- `source` values: `rules` for patterns; `onDevice` or `customProvider` for the model (web and Android: `customProvider` only; iOS: Apple on-device, then provider).
- Suggestion id: `"<pageIndex>:<start>-<end>:<category>"`.
- Notice text, verbatim: `Suggestions may be incomplete. Review the whole document.` On web and Android it passes through the existing AI trial prefix (`trialText` / `Trial`), on iOS through `Trial`.
- Character offsets are UTF-16 code units into the page text, on every platform.
- Overlaps among patterns: longer match wins; tie → earlier category in the order above. A model suggestion overlapping any pattern suggestion on the same page is dropped. Identical page+range+category kept once.
- Marks are never sent through viewer events (sync) and never touch the document.
- Mark tap cycles `pending → accepted → rejected → pending`.
- `PdfDocumentSnapshot` never exposes its bytes; the reopened document needs the watermark if the original did.
- Every command runs from `/Users/daos/Projects/Lab/PdfiumKit-v2`. iOS selected tests run through `./build/run-ios-tests.sh <TestTarget/Class>` (it stops xcodebuild once results print); Android device tests use `ANDROID_SERIAL=emulator-5554`.

---

## File map

| File | Responsibility |
| --- | --- |
| `conformance/redaction/patterns.json` | Text cases → expected pattern matches, shared by all platforms |
| `conformance/redaction/make-pii.mjs` | Writes `pii.pdf` (EN page, DE page) and `pii-expected.json` |
| `web-ai/src/redaction/patterns.ts` | Pattern rules, validators, overlap selection |
| `web-ai/src/redaction/suggest.ts` | Suggest (patterns + model + merge) and apply/undo |
| `web/src/document.ts` (+ `PdfDocumentSnapshot`) | Core snapshot |
| `web/src/view/viewer.ts`, `web/src/view/state.ts` | Headless marks |
| `web/src/ui/viewerElement.ts` | Mark overlay and review bar |
| `ios/Sources/PDFCoraAI/Redaction/Patterns.swift`, `Suggest.swift` | iOS detection, apply/undo |
| `ios/Sources/PDFCora/Snapshot.swift`, `ios/Sources/PDFCora/View/Marks.swift` | iOS core snapshot and marks |
| `ios/Sources/PDFCoraUI/PdfViewerView.swift` | iOS overlay and review bar |
| `android/pdfcora-ai/src/main/java/com/pdfcora/ai/redaction/Patterns.kt`, `Suggest.kt` | Android detection, apply/undo |
| `android/pdfcora/src/main/java/com/pdfcora/Snapshot.kt`, `view/Marks.kt` | Android core snapshot and marks |
| `android/pdfcora-ui/src/main/java/com/pdfcora/ui/PdfViewerView.kt` | Android overlay and review bar |

---

### Task 1: Shared fixtures

**Files:**
- Create: `conformance/redaction/patterns.json`, `conformance/redaction/make-pii.mjs`, `conformance/redaction/pii.pdf`, `conformance/redaction/pii-expected.json`

**Interfaces:**
- Produces: `patterns.json` = `[{ "text": string, "expected": [[category, matchedText], …] }]` (expected in text order). `pii-expected.json` = `[{ "pageIndex": n, "category": c, "text": t }]` in page then text order. `pii.pdf` pages: 0 English, 1 German.

- [ ] **Step 1: Write `patterns.json`**

```json
[
  { "text": "IBAN GB29 NWBK 6016 1331 9268 19.", "expected": [["iban", "GB29 NWBK 6016 1331 9268 19"]] },
  { "text": "Old IBAN GB29 NWBK 6016 1331 9268 18 is wrong.", "expected": [] },
  { "text": "Konto DE89 3704 0044 0532 0130 00, alt DE89 3704 0044 0532 0130 01.", "expected": [["iban", "DE89 3704 0044 0532 0130 00"]] },
  { "text": "CH93 0076 2011 6238 5295 7", "expected": [["iban", "CH93 0076 2011 6238 5295 7"]] },
  { "text": "XDE89370400440532013000", "expected": [] },
  { "text": "Mail anna.schmidt@example.com or j.doe+invoices@mail.example.co.uk.", "expected": [["email", "anna.schmidt@example.com"], ["email", "j.doe+invoices@mail.example.co.uk"]] },
  { "text": "Call +41 44 123 45 67 today.", "expected": [["phone", "+41 44 123 45 67"]] },
  { "text": "US +1 (212) 555-0142 and (212) 555-0142 and 212-555-0199.", "expected": [["phone", "+1 (212) 555-0142"], ["phone", "(212) 555-0142"], ["phone", "212-555-0199"]] },
  { "text": "London 020 7946 0958, mobile 07700 900123.", "expected": [["phone", "020 7946 0958"], ["phone", "07700 900123"]] },
  { "text": "Berlin 030 12345678, 030/1234567, 0171 1234567, +49 30 12345678.", "expected": [["phone", "030 12345678"], ["phone", "030/1234567"], ["phone", "0171 1234567"], ["phone", "+49 30 12345678"]] },
  { "text": "Order 123456 and room 12 34.", "expected": [] },
  { "text": "Card 4111 1111 1111 1111 and 5500-0000-0000-0004.", "expected": [["paymentCard", "4111 1111 1111 1111"], ["paymentCard", "5500-0000-0000-0004"]] },
  { "text": "Invalid 4111 1111 1111 1112 and 5500-0000-0000-0005.", "expected": [] },
  { "text": "On 2026-09-15, 15.09.2026, 15.9.26 and 09/15/2026.", "expected": [["date", "2026-09-15"], ["date", "15.09.2026"], ["date", "15.9.26"], ["date", "09/15/2026"]] },
  { "text": "Signed 15 September 2026, September 15, 2026 and 15 Sep 2026.", "expected": [["date", "15 September 2026"], ["date", "September 15, 2026"], ["date", "15 Sep 2026"]] },
  { "text": "Am 15. September 2026, 15. Sept. 2026 und 3. März 2025.", "expected": [["date", "15. September 2026"], ["date", "15. Sept. 2026"], ["date", "3. März 2025"]] },
  { "text": "Not dates: 31.02.2026, 2026-13-01, version 1.2.3.", "expected": [] },
  { "text": "See https://example.com/path?x=1, www.example.org. (and https://example.com)", "expected": [["url", "https://example.com/path?x=1"], ["url", "www.example.org"], ["url", "https://example.com"]] },
  { "text": "Hosts 192.168.0.1, 10.1.1.12, 2001:db8::8a2e:370:7334 and fe80::1.", "expected": [["ipAddress", "192.168.0.1"], ["ipAddress", "10.1.1.12"], ["ipAddress", "2001:db8::8a2e:370:7334"], ["ipAddress", "fe80::1"]] },
  { "text": "Not addresses: 999.1.1.1 at 10:30:45.", "expected": [] }
]
```

- [ ] **Step 2: Write `make-pii.mjs`**

```js
/**
 * Writes conformance/redaction/pii.pdf and pii-expected.json: the document redaction
 * suggestions are tested on. Written by hand, like make-contract.mjs, so the fixture cannot
 * inherit a bug from the SDK. Page 0 is English, page 1 German.
 *
 * Usage: node conformance/redaction/make-pii.mjs
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));

const PAGES = [
  [
    'Customer record',
    'Name: Anna Schmidt, born on 14 March 1985.',
    'Address: 221B Baker Street, London NW1 6XE, United Kingdom.',
    'Email anna.schmidt@example.com or call +44 20 7946 0958 or 020 7946 0958.',
    'US office: (212) 555-0142, fax 212-555-0199.',
    'IBAN GB29 NWBK 6016 1331 9268 19. Old IBAN GB29 NWBK 6016 1331 9268 18.',
    'Card 4111 1111 1111 1111 is valid; 4111 1111 1111 1112 is not.',
    'Passport number 502135326 was issued on 2019-04-02.',
    'Portal https://portal.example.com/account and www.example.org.',
    'Server 192.168.10.25 and 2001:db8::8a2e:370:7334.',
    'Anna Schmidt signed on September 15, 2026.',
  ],
  [
    'Kundendaten',
    'Name: Jonas Müller, geboren am 3. März 1990.',
    'Anschrift: Hauptstraße 12, 10115 Berlin.',
    'E-Mail jonas.mueller@beispiel.de, Telefon 030 12345678, mobil 0171 1234567.',
    'Fax 030/1234567, international +49 30 12345678.',
    'IBAN DE89 3704 0044 0532 0130 00, falsche IBAN DE89 3704 0044 0532 0130 01.',
    'Kreditkarte 5500-0000-0000-0004.',
    'Personalausweis L01X00T47, Steuer-ID 65929970489.',
    'Termin am 15.09.2026, Rückruf am 16.9.26, Frist 31.02.2026 ungültig.',
    'Jonas Müller unterschreibt am 15. Sept. 2026.',
  ],
];

const EXPECTED = [
  [0, 'date', '14 March 1985'], [0, 'email', 'anna.schmidt@example.com'],
  [0, 'phone', '+44 20 7946 0958'], [0, 'phone', '020 7946 0958'],
  [0, 'phone', '(212) 555-0142'], [0, 'phone', '212-555-0199'],
  [0, 'iban', 'GB29 NWBK 6016 1331 9268 19'], [0, 'paymentCard', '4111 1111 1111 1111'],
  [0, 'date', '2019-04-02'], [0, 'url', 'https://portal.example.com/account'],
  [0, 'url', 'www.example.org'], [0, 'ipAddress', '192.168.10.25'],
  [0, 'ipAddress', '2001:db8::8a2e:370:7334'], [0, 'date', 'September 15, 2026'],
  [1, 'date', '3. März 1990'], [1, 'email', 'jonas.mueller@beispiel.de'],
  [1, 'phone', '030 12345678'], [1, 'phone', '0171 1234567'],
  [1, 'phone', '030/1234567'], [1, 'phone', '+49 30 12345678'],
  [1, 'iban', 'DE89 3704 0044 0532 0130 00'], [1, 'paymentCard', '5500-0000-0000-0004'],
  [1, 'date', '15.09.2026'], [1, 'date', '16.9.26'], [1, 'date', '15. Sept. 2026'],
].map(([pageIndex, category, text]) => ({ pageIndex, category, text }));

function contentStream(lines) {
  return ['BT', '/F1 11 Tf', '15 TL', '72 740 Td',
    ...lines.map((line) => `(${line.replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`), 'ET'].join('\n');
}

const objects = [];
const add = (body) => { objects.push(body); return objects.length; };
const catalog = add(null);
const pagesId = add(null);
const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
const pageIds = PAGES.map((lines) => {
  const stream = contentStream(lines);
  const content = add(`<< /Length ${Buffer.byteLength(stream, 'latin1')} >>\nstream\n${stream}\nendstream`);
  return add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] ` +
    `/Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`);
});
objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
objects[pagesId - 1] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;

let pdf = '%PDF-1.7\n';
const offsets = objects.map((body, i) => {
  const at = Buffer.byteLength(pdf, 'latin1');
  pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
  return at;
});
const xref = Buffer.byteLength(pdf, 'latin1');
pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
pdf += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('');
pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

writeFileSync(join(HERE, 'pii.pdf'), pdf, 'latin1');
writeFileSync(join(HERE, 'pii-expected.json'), JSON.stringify(EXPECTED, null, 2) + '\n');
console.log(`wrote pii.pdf (${pdf.length} bytes) and ${EXPECTED.length} expected suggestions`);
```

- [ ] **Step 3: Generate and check the text layer**

Run: `node conformance/redaction/make-pii.mjs && cd web-ai && node --input-type=module -e 'const {PdfDocument}=await import("@pdfcora/web");const {readFileSync}=await import("node:fs");const d=await PdfDocument.open(new Uint8Array(readFileSync("../conformance/redaction/pii.pdf")));for(let i=0;i<2;i++)console.log(await (await d.page(i)).text.string())' 2>&1 | grep -v ^PDFCora`
Expected: `wrote pii.pdf (… bytes) and 25 expected suggestions`, then both pages' lines, with `Müller`, `März`, `Rückruf` intact.

- [ ] **Step 4: Commit**

```bash
git add conformance/redaction
git commit -m "Redaction suggestion fixtures: pattern cases and an EN/DE test document"
```

---

### Task 2: Web pattern matcher

**Files:**
- Create: `web-ai/src/redaction/patterns.ts`, `web-ai/test/redaction-patterns.test.ts`

**Interfaces:**
- Consumes: `conformance/redaction/patterns.json` (Task 1).
- Produces: `type PdfPatternCategory`, `PATTERN_CATEGORIES: readonly PdfPatternCategory[]` (tie-break order), `interface PatternMatch { category; start; end }`, `findPatterns(text: string, categories?: ReadonlySet<PdfPatternCategory>): PatternMatch[]` sorted by `start`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { findPatterns } from '../dist/redaction/patterns.js';

const CASES = JSON.parse(readFileSync(new URL('../../conformance/redaction/patterns.json', import.meta.url), 'utf8'));

for (const c of CASES) {
  test(`patterns: ${c.text}`, () => {
    const found = findPatterns(c.text).map((m) => [m.category, c.text.slice(m.start, m.end)]);
    assert.deepEqual(found, c.expected);
  });
}

test('categories restrict what is looked for', () => {
  const text = 'anna@example.com 4111 1111 1111 1111';
  assert.deepEqual(findPatterns(text, new Set(['email'])).map((m) => m.category), ['email']);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-ai && npm run build && npm run build:test 2>&1 | grep error`
Expected: `Cannot find module '../dist/redaction/patterns.js'`.

- [ ] **Step 3: Implement `patterns.ts`**

```ts
/**
 * Personal data found by pattern alone (RED-1). Runs on every device with no model.
 * Behaviour is pinned by conformance/redaction/patterns.json, which every platform runs.
 */
export type PdfPatternCategory = 'iban' | 'email' | 'phone' | 'paymentCard' | 'date' | 'url' | 'ipAddress';

/** Also the tie-break order when two equally long matches overlap. */
export const PATTERN_CATEGORIES: readonly PdfPatternCategory[] =
  ['iban', 'email', 'phone', 'paymentCard', 'date', 'url', 'ipAddress'];

export interface PatternMatch {
  readonly category: PdfPatternCategory;
  readonly start: number;
  readonly end: number;
}

type Accept = (text: string, start: number, end: number) => { start: number; end: number } | null;

const MONTHS: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6, July: 7, August: 8,
  September: 9, October: 10, November: 11, December: 12,
  Januar: 1, Februar: 2, März: 3, Mai: 5, Juni: 6, Juli: 7, Oktober: 10, Dezember: 12,
  Sept: 9, Jan: 1, Feb: 2, Mar: 3, Mär: 3, Apr: 4, Jun: 6, Jul: 7, Aug: 8, Sep: 9,
  Oct: 10, Okt: 10, Nov: 11, Dec: 12, Dez: 12, Jän: 1,
};
// Longest names first, so "September" is tried before "Sept" and "Sep".
const MONTH = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');

const isWord = (c: string | undefined) => c !== undefined && /[\p{L}\p{N}]/u.test(c);
/** True when the characters just before `start` continue a number, as in "12 3456". */
const continuesBefore = (text: string, start: number) => /[0-9][ .\-/]$/.test(text.slice(Math.max(0, start - 2), start));
const continuesAfter = (text: string, end: number) => /^[ .\-/][0-9]/.test(text.slice(end, end + 2));
const digitsIn = (s: string) => s.replace(/[^0-9]/g, '').length;

function mod97(iban: string): number {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const value = /[A-Z]/.test(ch) ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of value) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return sum % 10 === 0;
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const days = [31, (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]!;
}

const wordBounded: Accept = (text, start, end) =>
  isWord(text[start - 1]) || isWord(text[end]) ? null : { start, end };

const acceptIban: Accept = (text, start, end) => {
  if (isWord(text[start - 1])) return null;
  const raw = text.slice(start, end);
  const positions: number[] = [];
  for (let i = 0; i < raw.length; i++) if (/[A-Z0-9]/.test(raw[i]!)) positions.push(i);
  // The match may run into a following group of capitals; shrink until the checksum holds.
  for (let k = Math.min(34, positions.length); k >= 15; k--) {
    const stop = start + positions[k - 1]! + 1;
    if (isWord(text[stop])) continue;
    if (mod97(positions.slice(0, k).map((i) => raw[i]).join('')) === 1) return { start, end: stop };
  }
  return null;
};

const acceptEmail: Accept = (text, start, end) =>
  /[A-Za-z0-9._%+-]/.test(text[start - 1] ?? '') || isWord(text[end]) ? null : { start, end };

const acceptPhone: Accept = (text, start, end) => {
  if (isWord(text[start - 1]) || text[start - 1] === '+' || isWord(text[end])) return null;
  if (continuesBefore(text, start) || continuesAfter(text, end)) return null;
  const digits = digitsIn(text.slice(start, end));
  return digits >= 7 && digits <= 15 ? { start, end } : null;
};

const acceptCard: Accept = (text, start, end) => {
  if (isWord(text[start - 1]) || isWord(text[end])) return null;
  if (continuesBefore(text, start) || continuesAfter(text, end)) return null;
  const digits = text.slice(start, end).replace(/[^0-9]/g, '');
  return digits.length >= 13 && digits.length <= 19 && luhn(digits) ? { start, end } : null;
};

const acceptDate: Accept = (text, start, end) => {
  if (isWord(text[start - 1]) || isWord(text[end]) || continuesAfter(text, end)) return null;
  const s = text.slice(start, end);
  let m: RegExpMatchArray | null;
  if ((m = s.match(/^([0-9]{4})-([0-9]{2})-([0-9]{2})$/))) return validDate(+m[1]!, +m[2]!, +m[3]!) ? { start, end } : null;
  if ((m = s.match(/^([0-9]{1,2})\.([0-9]{1,2})\.([0-9]{2}|[0-9]{4})$/))) {
    const year = m[3]!.length === 2 ? 2000 + +m[3]! : +m[3]!;
    return validDate(year, +m[2]!, +m[1]!) ? { start, end } : null;
  }
  if ((m = s.match(/^([0-9]{1,2})\/([0-9]{1,2})\/([0-9]{4})$/))) {
    return validDate(+m[3]!, +m[1]!, +m[2]!) || validDate(+m[3]!, +m[2]!, +m[1]!) ? { start, end } : null;
  }
  if ((m = s.match(new RegExp(`^([0-9]{1,2})\\.? (${MONTH})\\.? ([0-9]{4})$`, 'u')))) {
    return validDate(+m[3]!, MONTHS[m[2]!]!, +m[1]!) ? { start, end } : null;
  }
  if ((m = s.match(new RegExp(`^(${MONTH})\\.? ([0-9]{1,2}),? ([0-9]{4})$`, 'u')))) {
    return validDate(+m[3]!, MONTHS[m[1]!]!, +m[2]!) ? { start, end } : null;
  }
  return null;
};

const acceptUrl: Accept = (text, start, end) => {
  if (isWord(text[start - 1])) return null;
  let stop = end;
  while (stop > start && /[.,;:)]/.test(text[stop - 1]!)) stop--;
  return stop - start >= 8 ? { start, end: stop } : null;
};

const acceptIp: Accept = (text, start, end) => {
  const s = text.slice(start, end);
  if (s.includes(':')) {
    if (isWord(text[start - 1]) || text[start - 1] === ':' || isWord(text[end]) || text[end] === ':') return null;
    const groups = s.split(':').filter((g) => g.length > 0);
    return groups.length <= 8 && (s.includes('::') || groups.length === 8) ? { start, end } : null;
  }
  if (isWord(text[start - 1]) || text[start - 1] === '.' || isWord(text[end]) || continuesAfter(text, end)) return null;
  return s.split('.').every((octet) => Number(octet) <= 255) ? { start, end } : null;
};

const HEX = '[0-9A-Fa-f]{1,4}';
const RULES: readonly { category: PdfPatternCategory; regex: RegExp; accept: Accept }[] = [
  { category: 'iban', regex: /[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}/gu, accept: acceptIban },
  { category: 'email', regex: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/gu, accept: acceptEmail },
  { category: 'phone', regex: /\+[0-9]{1,3}(?:[ .\-/]?\(?[0-9]{1,4}\)?){2,6}/gu, accept: acceptPhone },
  { category: 'phone', regex: /\(?[0-9]{3}\)?[ .-]?[0-9]{3}[ .-][0-9]{4}/gu, accept: acceptPhone },
  { category: 'phone', regex: /0[0-9]{2,4}(?:[ /-]?[0-9]{2,8}){1,3}/gu, accept: acceptPhone },
  { category: 'paymentCard', regex: /[0-9](?:[ -]?[0-9]){12,18}/gu, accept: acceptCard },
  { category: 'date', regex: /[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\.[0-9]{1,2}\.(?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}\/[0-9]{1,2}\/[0-9]{4}/gu, accept: acceptDate },
  { category: 'date', regex: new RegExp(`[0-9]{1,2}\\.? (?:${MONTH})\\.? [0-9]{4}|(?:${MONTH})\\.? [0-9]{1,2},? [0-9]{4}`, 'gu'), accept: acceptDate },
  { category: 'url', regex: /https?:\/\/[^\s<>"]+|www\.[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+(?:\/[^\s<>"]*)?/gu, accept: acceptUrl },
  { category: 'ipAddress', regex: /(?:[0-9]{1,3}\.){3}[0-9]{1,3}/gu, accept: acceptIp },
  { category: 'ipAddress', regex: new RegExp(`(?:${HEX}:){7}${HEX}|(?:${HEX}:){1,7}:(?:${HEX}(?::${HEX}){0,6})?|::${HEX}(?::${HEX}){0,6}`, 'gu'), accept: acceptIp },
];

/** Every pattern match in `text`, overlaps resolved, in text order. */
export function findPatterns(text: string, categories?: ReadonlySet<PdfPatternCategory>): PatternMatch[] {
  const candidates: PatternMatch[] = [];
  for (const rule of RULES) {
    if (categories && !categories.has(rule.category)) continue;
    rule.regex.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = rule.regex.exec(text)) !== null) {
      const accepted = rule.accept(text, match.index, match.index + match[0].length);
      if (accepted) candidates.push({ category: rule.category, ...accepted });
      // Try again one character on: a rejected match may hide a valid one starting later.
      rule.regex.lastIndex = match.index + 1;
    }
  }
  const order = (c: PdfPatternCategory) => PATTERN_CATEGORIES.indexOf(c);
  candidates.sort((a, b) => (b.end - b.start) - (a.end - a.start) || order(a.category) - order(b.category) || a.start - b.start);
  const chosen: PatternMatch[] = [];
  for (const c of candidates) {
    if (!chosen.some((o) => c.start < o.end && o.start < c.end)) chosen.push(c);
  }
  return chosen.sort((a, b) => a.start - b.start);
}
```

- [ ] **Step 4: Run the tests**

Run: `cd web-ai && npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test dist-test/redaction-patterns.test.js 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: 21 pass, 0 fail. When a case fails, print the candidates for that text and fix the rule or its validator; change `patterns.json` only when the case itself contradicts the spec.

- [ ] **Step 5: Commit**

```bash
git add web-ai/src/redaction/patterns.ts web-ai/test/redaction-patterns.test.ts
git commit -m "web-ai: find IBANs, emails, phones, cards, dates, URLs and IPs by pattern"
```

---
### Task 3: Web core — document snapshots

**Files:**
- Modify: `web/src/document.ts` (add `snapshot()`, `PdfDocumentSnapshot`), `web/src/index.ts` (export the type)
- Test: `web/test/snapshot.test.ts`

**Interfaces:**
- Produces: `PdfDocument.snapshot(): Promise<PdfDocumentSnapshot>`; `class PdfDocumentSnapshot { open(): Promise<PdfDocument> }` with no public bytes.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '../dist/index.js';
import { configureLicenseForTesting } from '../dist/license/state.js';

const FIXTURE = JSON.parse(readFileSync(new URL('../../conformance/license/cases.json', import.meta.url), 'utf8'));
const read = (name: string) => new Uint8Array(readFileSync(new URL(`../../conformance/corpus/${name}`, import.meta.url)));

test('a snapshot reopens the document as it was, edits included', async () => {
  const document = await PdfDocument.open(read('hello_world.pdf'));
  await (await document.page(0)).addNote({ left: 10, bottom: 10, right: 30, top: 30 }, 'kept');
  const snapshot = await document.snapshot();
  await document.redact([{ kind: 'textMatches', query: 'Hello' }]);

  const copy = await snapshot.open();
  assert.ok((await (await copy.page(0)).text.string()).includes('Hello'));
  assert.equal((await (await copy.page(0)).annotations()).length, 1);
  assert.equal(Object.keys(snapshot).length, 0, 'a snapshot exposes no fields');
});

test('a snapshot of a watermarked document reopens watermarked, and stamps once', async () => {
  await configureLicenseForTesting({ key: null, host: null });
  try {
    const document = await PdfDocument.open(read('hello_world.pdf'));
    const copy = await (await document.snapshot()).open();
    assert.equal(copy.needsWatermark, true);
    const saved = await PdfDocument.open(await copy.toBytes());
    const text = await (await saved.page(0)).text.string();
    assert.equal(text.split('PDFCora trial').length - 1, 1);
  } finally {
    await configureLicenseForTesting({ key: FIXTURE.fullKey, host: null });
  }
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm run build && npm run build:test 2>&1 | grep error`
Expected: `Property 'snapshot' does not exist on type 'PdfDocument'`.

- [ ] **Step 3: Implement**

In `web/src/document.ts`, add to `PdfDocument` after `toBytes`:

```ts
  /**
   * A copy of the document as it is now, to reopen later — for undoing a change that
   * cannot be undone in place, such as a redaction.
   *
   * The copy's bytes are never exposed: they are not watermarked, and handing them out
   * would be a way round the license. The reopened document needs the watermark if this
   * one does.
   */
  async snapshot(): Promise<PdfDocumentSnapshot> {
    const bytes = await this.run((h, m) => saveHandle(m, h, 2));
    const marked = this.marked;
    return new PdfDocumentSnapshot(async () => {
      const document = await PdfDocument.open(bytes);
      if (marked) document.marked = true;
      return document;
    });
  }
```

At the end of the file:

```ts
/** A document as it was when `snapshot()` was called. See {@link PdfDocument.snapshot}. */
export class PdfDocumentSnapshot {
  readonly #reopen: () => Promise<PdfDocument>;

  /** @internal */
  constructor(reopen: () => Promise<PdfDocument>) {
    this.#reopen = reopen;
  }

  /** Opens a new document from the snapshot. Each call opens another. */
  open(): Promise<PdfDocument> {
    return this.#reopen();
  }
}
```

In `web/src/index.ts` change `export { PdfDocument } from './document.js';` to `export { PdfDocument, PdfDocumentSnapshot } from './document.js';`.

- [ ] **Step 4: Run the tests**

Run: `cd web && npm run build && npm run build:test && node --import ./dist-test/license-setup.js --test dist-test/snapshot.test.js 2>&1 | grep -E "✖|ℹ (pass|fail)"`
Expected: 2 pass.

- [ ] **Step 5: Commit**

```bash
git add web/src/document.ts web/src/index.ts web/test/snapshot.test.ts web/dist-test
git commit -m "Web: document snapshots, reopenable and never exposing unwatermarked bytes"
```

---

### Task 4: Web core — viewer marks

**Files:**
- Modify: `web/src/view/state.ts` (types), `web/src/view/viewer.ts` (marks)
- Test: `web/test/viewer-marks.test.ts`

**Interfaces:**
- Produces: `type PdfMarkState = 'pending' | 'accepted' | 'rejected'`; `interface PdfMark { id: string; pageIndex: number; rects: readonly PdfRect[]; state: PdfMarkState }`; on `PdfViewer`: `get marks(): readonly PdfMark[]`, `setMarks(marks: readonly PdfMark[]): void`, `setAllMarks(state: PdfMarkState): void`, `markAt(pageIndex: number, point: PdfPoint): string | null`, `tapMark(pageIndex: number, point: PdfPoint): string | null`.

- [ ] **Step 1: Write the failing test**

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument, PdfViewer } from '../dist/index.js';

const read = () => new Uint8Array(readFileSync(new URL('../../conformance/corpus/hello_world.pdf', import.meta.url)));
const rect = (left: number, bottom: number, right: number, top: number) => ({ left, bottom, right, top });

async function viewer() {
  return PdfViewer.open(await PdfDocument.open(read()), { width: 400, height: 600 });
}

test('marks are set, replaced and hit-tested topmost first', async () => {
  const v = await viewer();
  v.setMarks([
    { id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' },
    { id: 'b', pageIndex: 0, rects: [rect(50, 20, 80, 30)], state: 'pending' },
  ]);
  assert.equal(v.markAt(0, { x: 60, y: 25 }), 'b');
  assert.equal(v.markAt(0, { x: 20, y: 15 }), 'a');
  assert.equal(v.markAt(1, { x: 20, y: 15 }), null);
  v.setMarks([{ id: 'c', pageIndex: 0, rects: [rect(0, 0, 5, 5)], state: 'pending' }]);
  assert.deepEqual(v.marks.map((m) => m.id), ['c']);
});

test('a tap cycles pending, accepted, rejected and back; accept all sets every mark', async () => {
  const v = await viewer();
  v.setMarks([{ id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' },
              { id: 'b', pageIndex: 0, rects: [rect(200, 10, 300, 40)], state: 'pending' }]);
  const states: string[] = [];
  for (let i = 0; i < 3; i++) {
    assert.equal(v.tapMark(0, { x: 20, y: 20 }), 'a');
    states.push(v.marks[0]!.state);
  }
  assert.deepEqual(states, ['accepted', 'rejected', 'pending']);
  assert.equal(v.tapMark(0, { x: 150, y: 20 }), null);
  v.setAllMarks('accepted');
  assert.deepEqual(v.marks.map((m) => m.state), ['accepted', 'accepted']);
});

test('marks never reach the event stream a sync transport listens to', async () => {
  const v = await viewer();
  const events: unknown[] = [];
  v.on((event) => events.push(event));
  v.setMarks([{ id: 'a', pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: 'pending' }]);
  v.tapMark(0, { x: 20, y: 20 });
  v.setAllMarks('rejected');
  v.flush();
  assert.deepEqual(events, []);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm run build && npm run build:test 2>&1 | grep error`
Expected: `Property 'setMarks' does not exist on type 'PdfViewer'`.

- [ ] **Step 3: Implement**

In `web/src/view/state.ts` add (it already imports `PdfRect` from `../types.js`; add the import if not):

```ts
/** A reviewable region drawn over a page, such as a redaction suggestion. */
export type PdfMarkState = 'pending' | 'accepted' | 'rejected';

export interface PdfMark {
  readonly id: string;
  readonly pageIndex: number;
  readonly rects: readonly PdfRect[];
  readonly state: PdfMarkState;
}
```

In `web/src/view/viewer.ts` import `PdfMark, PdfMarkState` from `./state.js` and `PdfPoint` is already imported. Add to the class, after the `tool` getter:

```ts
  // MARK: - Marks
  //
  // Local to this viewer: none of these emit an event, so a sync transport never carries a
  // review, and none touch the document.

  private currentMarks: PdfMark[] = [];

  get marks(): readonly PdfMark[] { return this.currentMarks; }

  setMarks(marks: readonly PdfMark[]): void {
    this.currentMarks = [...marks];
  }

  setAllMarks(state: PdfMarkState): void {
    this.currentMarks = this.currentMarks.map((mark) => ({ ...mark, state }));
  }

  /** The id of the topmost mark under a point on a page — the last one set — or null. */
  markAt(pageIndex: number, point: PdfPoint): string | null {
    for (let i = this.currentMarks.length - 1; i >= 0; i--) {
      const mark = this.currentMarks[i]!;
      if (mark.pageIndex === pageIndex && mark.rects.some((r) =>
        point.x >= Math.min(r.left, r.right) && point.x <= Math.max(r.left, r.right)
        && point.y >= Math.min(r.bottom, r.top) && point.y <= Math.max(r.bottom, r.top))) {
        return mark.id;
      }
    }
    return null;
  }

  /** Cycles the tapped mark pending → accepted → rejected → pending. Returns its id, or null. */
  tapMark(pageIndex: number, point: PdfPoint): string | null {
    const id = this.markAt(pageIndex, point);
    if (id === null) return null;
    const next: Record<PdfMarkState, PdfMarkState> = { pending: 'accepted', accepted: 'rejected', rejected: 'pending' };
    this.currentMarks = this.currentMarks.map((mark) => (mark.id === id ? { ...mark, state: next[mark.state] } : mark));
    return id;
  }
```

`export * from './view/state.js'` in `index.ts` already exports the new types.

- [ ] **Step 4: Run the tests and the web suite**

Run: `cd web && npm test 2>&1 | LC_ALL=C grep -a "ℹ tests\|ℹ fail"`
Expected: all pass (previous count + 2 snapshot + 3 marks).

- [ ] **Step 5: Commit**

```bash
git add web/src/view web/test/viewer-marks.test.ts web/dist-test
git commit -m "Web: viewer marks — set, hit-test, tap to cycle, never synced"
```

---
### Task 5: web-ai — suggest, apply and undo

**Files:**
- Create: `web-ai/src/redaction/suggest.ts`, `web-ai/test/redaction-suggest.test.ts`
- Modify: `web-ai/src/index.ts` (add `redactions` to `PdfAI`, export types)

**Interfaces:**
- Consumes: `findPatterns`, `PATTERN_CATEGORIES` (Task 2); `PdfDocument.snapshot()` (Task 3); existing `readPages`, `rectsForRange`, `locateQuote`, `resolve`, `trialText`.
- Produces:
  - `type PdfRedactionCategory = PdfPatternCategory | 'personName' | 'postalAddress' | 'dateOfBirth' | 'idNumber'`
  - `interface PdfRedactionSuggestion { id; category; source: PdfAiSource; pageIndex; start; end; text; rects: readonly PdfRect[] }`
  - `interface PdfRedactionOptions { pages?: PdfPageRange; categories?: readonly PdfRedactionCategory[] }`
  - `interface PdfRedactionReview { suggestions; modelUsed: boolean; notice: string; pagesWithoutText: readonly number[]; apply(acceptedIds: readonly string[]): Promise<PdfRedactionApplied> }`
  - `interface PdfRedactionApplied { report: PdfRedactionReport; remaining: readonly PdfRedactionSuggestion[]; undo(): Promise<PdfDocument> }`
  - `PdfAI.redactions.suggest(options?: PdfRedactionOptions): Promise<PdfRedactionReview>`
  - exported for tests: `REDACTION_NOTICE`, `redactionPrompt(text: string): string`, `redactionSchema`

- [ ] **Step 1: Write the failing tests**

```ts
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PdfDocument } from '@pdfcora/web';
import { PdfAI, type PdfAiRequest } from '../dist/index.js';

const ROOT = new URL('../../conformance/redaction/', import.meta.url);
const EXPECTED = JSON.parse(readFileSync(new URL('pii-expected.json', ROOT), 'utf8'));
const pii = () => PdfDocument.open(new Uint8Array(readFileSync(new URL('pii.pdf', ROOT))));
const model = (items: (prompt: string) => { category: string; quote: string }[]) => ({
  requests: [] as PdfAiRequest[],
  async generate(request: PdfAiRequest) {
    this.requests.push(request);
    return { text: '', structured: { items: items(request.prompt) } };
  },
});

describe('redaction suggestions', () => {
  test('without a model, the patterns alone find exactly the expected items', async () => {
    const review = await new PdfAI(await pii()).redactions.suggest();
    assert.equal(review.modelUsed, false);
    assert.match(review.notice, /Suggestions may be incomplete\. Review the whole document\./);
    assert.deepEqual(review.suggestions.map((s) => ({ pageIndex: s.pageIndex, category: s.category, text: s.text })), EXPECTED);
    for (const s of review.suggestions) {
      assert.equal(s.source, 'rules');
      assert.equal(s.id, `${s.pageIndex}:${s.start}-${s.end}:${s.category}`);
      assert.ok(s.rects.length > 0, `${s.text} has no rectangles`);
    }
  });

  test('a model quote is verified, expanded to every occurrence, and never overlaps a pattern', async () => {
    const provider = model(() => [
      { category: 'personName', quote: 'Anna Schmidt' },
      { category: 'personName', quote: 'Nobody Invented' },
      { category: 'dateOfBirth', quote: '14 March 1985' },
      { category: 'idNumber', quote: 'Li' },
      { category: 'bankBalance', quote: 'Customer record' },
    ]);
    const review = await new PdfAI(await pii(), { provider }).redactions.suggest({ pages: { from: 0, to: 0 } });
    assert.equal(review.modelUsed, true);
    const fromModel = review.suggestions.filter((s) => s.source === 'customProvider');
    assert.deepEqual(fromModel.map((s) => [s.category, s.text]), [['personName', 'Anna Schmidt'], ['personName', 'Anna Schmidt']]);
    assert.ok(provider.requests[0]!.schema, 'the model is given a schema');
  });

  test('a failing model leaves the pattern suggestions', async () => {
    const provider = { generate: async () => { throw new Error('offline'); } };
    const review = await new PdfAI(await pii(), { provider }).redactions.suggest();
    assert.equal(review.modelUsed, false);
    assert.equal(review.suggestions.length, EXPECTED.length);
  });

  test('categories restrict both patterns and the model', async () => {
    const review = await new PdfAI(await pii()).redactions.suggest({ categories: ['iban'] });
    assert.deepEqual(review.suggestions.map((s) => s.text), ['GB29 NWBK 6016 1331 9268 19', 'DE89 3704 0044 0532 0130 00']);
  });

  test('apply removes accepted text, keeps rejected text, and undo restores it', async () => {
    const document = await pii();
    const review = await new PdfAI(document).redactions.suggest({ pages: { from: 0, to: 0 } });
    const email = review.suggestions.find((s) => s.category === 'email')!;
    const iban = review.suggestions.find((s) => s.category === 'iban')!;

    const applied = await review.apply([email.id]);
    assert.deepEqual(applied.remaining, []);
    const saved = await PdfDocument.open(await document.toBytes('full'));
    const text = await (await saved.page(0)).text.string();
    assert.ok(!text.includes(email.text), 'accepted text is gone');
    assert.ok(text.includes(iban.text), 'rejected text stays');
    assert.ok(text.includes('Email'), 'the word before the email stays');

    const restored = await applied.undo();
    assert.ok((await (await restored.page(0)).text.string()).includes(email.text));
  });

  test('an unknown id writes nothing', async () => {
    const document = await pii();
    const review = await new PdfAI(document).redactions.suggest();
    await assert.rejects(review.apply([review.suggestions[0]!.id, 'nope']), /unknown suggestion: nope/);
    assert.ok((await (await document.page(0)).text.string()).includes(review.suggestions[0]!.text));
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-ai && npm run build && npm run build:test 2>&1 | grep error`
Expected: `Property 'redactions' does not exist on type 'PdfAI'`.

- [ ] **Step 3: Implement `suggest.ts`**

```ts
import type { PdfDocument, PdfRect, PdfRedactionReport } from '@pdfcora/web';
import { findPatterns, PATTERN_CATEGORIES, type PdfPatternCategory } from './patterns.js';
import { locateQuote } from '../quote.js';
import { readPages, rectsForRange, sentencesOf, type PdfPageRange, type PdfPageText } from '../text.js';
import { resolve, type PdfAiProvider, type PdfAiSource } from '../provider.js';
import { trialText } from '../trial.js';

export type PdfModelRedactionCategory = 'personName' | 'postalAddress' | 'dateOfBirth' | 'idNumber';
export type PdfRedactionCategory = PdfPatternCategory | PdfModelRedactionCategory;
export const MODEL_CATEGORIES: readonly PdfModelRedactionCategory[] = ['personName', 'postalAddress', 'dateOfBirth', 'idNumber'];
export const REDACTION_NOTICE = 'Suggestions may be incomplete. Review the whole document.';

export interface PdfRedactionSuggestion {
  readonly id: string;
  readonly category: PdfRedactionCategory;
  readonly source: PdfAiSource;
  readonly pageIndex: number;
  readonly start: number;
  readonly end: number;
  readonly text: string;
  readonly rects: readonly PdfRect[];
}

export interface PdfRedactionOptions {
  readonly pages?: PdfPageRange;
  readonly categories?: readonly PdfRedactionCategory[];
}

export interface PdfRedactionApplied {
  readonly report: PdfRedactionReport;
  /** Accepted suggestions whose text is still on the page. Empty unless something went wrong. */
  readonly remaining: readonly PdfRedactionSuggestion[];
  /** Reopens the document as it was before `apply`. The host shows it and closes the redacted one. */
  undo(): Promise<PdfDocument>;
}

export interface PdfRedactionReview {
  readonly suggestions: readonly PdfRedactionSuggestion[];
  /** False when no model answered, so only patterns ran. */
  readonly modelUsed: boolean;
  /** Must be shown with the suggestions (RED-4). */
  readonly notice: string;
  readonly pagesWithoutText: readonly number[];
  apply(acceptedIds: readonly string[]): Promise<PdfRedactionApplied>;
}

export const redactionSchema = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: { category: { type: 'string', enum: MODEL_CATEGORIES }, quote: { type: 'string' } },
        required: ['category', 'quote'],
      },
    },
  },
  required: ['items'],
};

export function redactionPrompt(text: string): string {
  return [
    'Find personal data in the text below.',
    'Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),',
    'dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).',
    'Copy each quote exactly as it appears in the text. Reply with JSON: {"items": [{"category": "...", "quote": "..."}]}.',
    'Reply with {"items": []} when there is none.',
    '',
    text,
  ].join('\n');
}

/** Every place `quote` occurs in `text`, with the same tolerance as quote verification. */
export function occurrences(text: string, quote: string): { start: number; end: number }[] {
  const found: { start: number; end: number }[] = [];
  let offset = 0;
  for (;;) {
    const at = locateQuote(text.slice(offset), quote);
    if (!at) return found;
    found.push({ start: offset + at.start, end: offset + at.end });
    offset += at.end;
  }
}

interface Chunk { readonly pageIndex: number; readonly text: string }

/** Page text in pieces of at most `limit` characters, split between sentences. */
function chunksOf(pages: readonly PdfPageText[], limit: number): Chunk[] {
  const chunks: Chunk[] = [];
  for (const page of pages) {
    let current = '';
    for (const { start, end } of sentencesOf(page.text)) {
      const sentence = page.text.slice(start, end);
      if (current && current.length + sentence.length + 1 > limit) {
        chunks.push({ pageIndex: page.pageIndex, text: current });
        current = '';
      }
      current = current ? `${current} ${sentence}` : sentence.slice(0, limit);
    }
    if (current) chunks.push({ pageIndex: page.pageIndex, text: current });
  }
  return chunks;
}

function parseItems(structured: unknown, text: string): { category: string; quote: string }[] {
  let value = structured;
  if (value === undefined) {
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    try { value = from >= 0 && to > from ? JSON.parse(text.slice(from, to + 1)) : undefined; } catch { value = undefined; }
  }
  const items = (value as { items?: unknown })?.items;
  return Array.isArray(items)
    ? items.filter((i): i is { category: string; quote: string } =>
        typeof i?.category === 'string' && typeof i?.quote === 'string')
    : [];
}

export async function suggestRedactions(
  document: PdfDocument, provider: PdfAiProvider | undefined, contextTokens: number, options: PdfRedactionOptions = {},
): Promise<PdfRedactionReview> {
  const wanted = new Set<PdfRedactionCategory>(options.categories ?? [...PATTERN_CATEGORIES, ...MODEL_CATEGORIES]);
  const patternCategories = new Set(PATTERN_CATEGORIES.filter((c) => wanted.has(c)));
  const modelCategories = MODEL_CATEGORIES.filter((c) => wanted.has(c));
  const { pages, pagesWithoutText } = await readPages(document, options.pages);

  const found: Omit<PdfRedactionSuggestion, 'id' | 'rects' | 'text'>[] = [];
  for (const page of pages) {
    for (const m of findPatterns(page.text, patternCategories)) {
      found.push({ category: m.category, source: 'rules', pageIndex: page.pageIndex, start: m.start, end: m.end });
    }
  }

  let modelUsed = false;
  if (provider && modelCategories.length > 0) {
    const limit = Math.floor(contextTokens * 3 * 0.6);
    const result = await resolve<{ category: PdfModelRedactionCategory; quote: string }[]>({
      customProvider: async () => {
        const verified: { category: PdfModelRedactionCategory; quote: string }[] = [];
        for (const chunk of chunksOf(pages, limit)) {
          const response = await provider.generate({ prompt: redactionPrompt(chunk.text), schema: redactionSchema });
          for (const item of parseItems(response.structured, response.text)) {
            const category = item.category as PdfModelRedactionCategory;
            if (!modelCategories.includes(category) || item.quote.trim().length < 3) continue;
            if (locateQuote(chunk.text, item.quote)) verified.push({ category, quote: item.quote });
          }
        }
        return verified;
      },
    });
    if ('value' in result) {
      modelUsed = true;
      for (const { category, quote } of result.value) {
        for (const page of pages) {
          for (const at of occurrences(page.text, quote)) {
            found.push({ category, source: result.source, pageIndex: page.pageIndex, ...at });
          }
        }
      }
    }
  }

  // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
  const kept = found.filter((s) => s.source === 'rules' || !found.some((p) =>
    p.source === 'rules' && p.pageIndex === s.pageIndex && s.start < p.end && p.start < s.end));
  const unique = new Map<string, (typeof kept)[number]>();
  for (const s of kept) unique.set(`${s.pageIndex}:${s.start}-${s.end}:${s.category}`, s);
  const ordered = [...unique.entries()].sort(([, a], [, b]) => a.pageIndex - b.pageIndex || a.start - b.start);

  const textOf = new Map(pages.map((p) => [p.pageIndex, p.text]));
  const suggestions: PdfRedactionSuggestion[] = [];
  for (const [id, s] of ordered) {
    suggestions.push({
      ...s, id, text: textOf.get(s.pageIndex)!.slice(s.start, s.end),
      rects: await rectsForRange(document, s.pageIndex, s.start, s.end),
    });
  }

  return {
    suggestions, modelUsed, pagesWithoutText, notice: trialText(REDACTION_NOTICE),
    apply: (acceptedIds) => applyRedactions(document, suggestions, textOf, acceptedIds),
  };
}

async function applyRedactions(
  document: PdfDocument, suggestions: readonly PdfRedactionSuggestion[],
  textBefore: ReadonlyMap<number, string>, acceptedIds: readonly string[],
): Promise<PdfRedactionApplied> {
  const known = new Set(suggestions.map((s) => s.id));
  for (const id of acceptedIds) if (!known.has(id)) throw new Error(`unknown suggestion: ${id}`);
  const accepted = suggestions.filter((s) => acceptedIds.includes(s.id));

  const snapshot = await document.snapshot();
  const report = await document.redact(accepted.flatMap((s) =>
    s.rects.map((rect) => ({ kind: 'region' as const, rect, pageIndex: s.pageIndex }))));

  // Offsets move once text is removed, so count occurrences instead: after the redaction a
  // page should hold each accepted text as many times as it was not accepted.
  const remaining: PdfRedactionSuggestion[] = [];
  for (const pageIndex of new Set(accepted.map((s) => s.pageIndex))) {
    const after = await (await document.page(pageIndex)).text.string();
    const before = textBefore.get(pageIndex)!;
    for (const text of new Set(accepted.filter((s) => s.pageIndex === pageIndex).map((s) => s.text))) {
      const removed = accepted.filter((s) => s.pageIndex === pageIndex && s.text === text).length;
      if (occurrences(after, text).length > occurrences(before, text).length - removed) {
        remaining.push(...accepted.filter((s) => s.pageIndex === pageIndex && s.text === text));
      }
    }
  }
  return { report, remaining, undo: () => snapshot.open() };
}
```

In `web-ai/src/index.ts`: import `suggestRedactions` and the types; add exports

```ts
export type {
  PdfRedactionApplied, PdfRedactionCategory, PdfRedactionOptions, PdfRedactionReview, PdfRedactionSuggestion,
} from './redaction/suggest.js';
```

and add to `PdfAI`, after `summaries`:

```ts
  /**
   * Suggests likely personal data to redact (RED). Patterns run on every device; the custom
   * provider, when configured, adds names, addresses, dates of birth and ID numbers. Nothing
   * is written until `apply`.
   */
  readonly redactions = {
    suggest: (options?: PdfRedactionOptions): Promise<PdfRedactionReview> =>
      suggestRedactions(this.document, this.options.provider, this.options.providerContextTokens ?? 4096, options),
  };
```

Check `sentencesOf` is exported from `text.ts` (it is, line 84) and `PdfRedactionReport` from `@pdfcora/web` (add it to the core `index.ts` exports if `tsc` says it is missing).

- [ ] **Step 4: Run the tests**

Run: `cd web-ai && npm test 2>&1 | LC_ALL=C grep -a "✖\|ℹ tests\|ℹ fail"`
Expected: all pass. If "the word before the email stays" fails, the region rectangles take a neighbouring character: inset each rectangle by 0.3 pt on left and right in `applyRedactions` and note why in a comment.

- [ ] **Step 5: Commit**

```bash
git add web-ai/src web-ai/test web/src/index.ts
git commit -m "web-ai: redaction suggestions from patterns and a custom provider, with apply and undo"
```

---
### Task 6: Web UI — marks overlay and review bar

**Files:**
- Modify: `web/src/ui/viewerElement.ts`, `web/src/index.ts`
- Test: `web/test-browser/viewer-element.js`

**Interfaces:**
- Consumes: viewer marks (Task 4).
- Produces: `interface PdfReviewOptions { marks: readonly PdfMark[]; notice: string; applyLabel?: string; onApply(acceptedIds: string[]): void | Promise<void>; onCancel?(): void }`; `PdfViewerElementOptions.review?: PdfReviewOptions`. DOM ids: `review-bar`, `review-notice`, `review-counts`, `review-accept-all`, `review-reject-all`, `review-apply`, `review-cancel`; each drawn mark rect is a `div[data-mark-id]` with `data-mark-state`.

- [ ] **Step 1: Write the failing browser test**

In `web/test-browser/viewer-element.js`, before the closed-document block, add:

```js
  // Review mode: a mark over the page, tapped once to accept, then applied.
  const reviewHost = document.createElement('div');
  reviewHost.style.cssText = 'width:400px;height:500px';
  document.body.append(reviewHost);
  let applied = null;
  await PdfViewerElement.mount(reviewHost, await open(), {
    review: {
      marks: [{ id: 'm1', pageIndex: 0, rects: [{ left: 0, bottom: 0, right: 612, top: 792 }], state: 'pending' }],
      notice: 'Suggestions may be incomplete. Review the whole document.',
      onApply: (ids) => { applied = ids; },
    },
  });
  check('the review notice is shown', document.getElementById('review-notice')?.textContent.includes('may be incomplete'));
  const reviewCanvas = reviewHost.querySelector('canvas');
  const box = reviewCanvas.getBoundingClientRect();
  const at = { clientX: box.left + box.width / 2, clientY: box.top + box.height / 2, bubbles: true };
  reviewCanvas.dispatchEvent(new PointerEvent('pointerdown', at));
  reviewCanvas.dispatchEvent(new PointerEvent('pointerup', at));
  for (let i = 0; i < 50 && !document.getElementById('review-counts')?.textContent.startsWith('1 accepted'); i++) await frame();
  check('tapping a mark accepts it', document.getElementById('review-counts')?.textContent.startsWith('1 accepted'),
    document.getElementById('review-counts')?.textContent);
  check('an accepted mark is drawn as accepted', reviewHost.querySelector('[data-mark-id="m1"]')?.dataset.markState === 'accepted');
  document.getElementById('review-apply').click();
  for (let i = 0; i < 50 && applied === null; i++) await frame();
  check('apply hands over the accepted ids', JSON.stringify(applied) === '["m1"]', JSON.stringify(applied));
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web && npm run build && cd .. && ./scripts/test-web-browser.sh 2>&1 | tail -6`
Expected: FAIL lines for the four review checks (`the review notice is shown` first).

- [ ] **Step 3: Implement**

In `web/src/ui/viewerElement.ts`:

1. Imports: add `import type { PdfMark, PdfMarkState } from '../view/state.js';`.
2. Options:
```ts
export interface PdfReviewOptions {
  readonly marks: readonly PdfMark[];
  /** Always shown while reviewing. For redaction, say that suggestions may be incomplete. */
  readonly notice: string;
  readonly applyLabel?: string;
  readonly onApply: (acceptedIds: string[]) => void | Promise<void>;
  readonly onCancel?: () => void;
}

export interface PdfViewerElementOptions {
  readonly toolbar?: PdfToolbarConfiguration;
  readonly theme?: PdfViewerTheme;
  readonly onSave?: (bytes: Uint8Array) => void;
  readonly review?: PdfReviewOptions;
}
```
3. Fields and constructor: add `private readonly overlay = document.createElement('div');`, `private readonly reviewBar = document.createElement('div');`, and a constructor parameter `private readonly review?: PdfReviewOptions` passed from `mount` as `options.review`.
4. In `build()`, after the viewer opens: `if (this.review) this.viewer.setMarks(this.review.marks);`. Style the overlay `Object.assign(this.overlay.style, { position: 'absolute', left: '0', top: '0', pointerEvents: 'none' });`, append it to `this.stage` after the canvas, and put the review bar between the stage and the status: `this.host.replaceChildren(this.bar, this.stage, ...(this.review ? [this.reviewBar] : []), this.status);`. Call `this.renderReview()` after `renderToolbar()`.
5. Add:
```ts
  private renderReview(): void {
    const review = this.review;
    const viewer = this.viewer;
    if (!review || !viewer) return;
    const count = (state: PdfMarkState) => viewer.marks.filter((m) => m.state === state).length;
    const button = (id: string, label: string, action: () => void) => {
      const b = document.createElement('button');
      b.id = id;
      b.textContent = label;
      b.onclick = action;
      return b;
    };
    const notice = document.createElement('span');
    notice.id = 'review-notice';
    notice.textContent = review.notice;
    const counts = document.createElement('span');
    counts.id = 'review-counts';
    counts.textContent = `${count('accepted')} accepted · ${count('pending')} pending`;
    this.reviewBar.id = 'review-bar';
    Object.assign(this.reviewBar.style, {
      display: 'flex', flexWrap: 'wrap', gap: '8px', alignItems: 'center', padding: '6px 8px',
      font: '13px sans-serif', background: this.theme.toolbarBackground, color: this.theme.toolbarForeground,
    });
    this.reviewBar.replaceChildren(
      notice, counts,
      button('review-accept-all', 'Accept all', () => { viewer.setAllMarks('accepted'); this.drawMarks(); }),
      button('review-reject-all', 'Reject all', () => { viewer.setAllMarks('rejected'); this.drawMarks(); }),
      button('review-apply', review.applyLabel ?? 'Apply', () => {
        void review.onApply(viewer.marks.filter((m) => m.state === 'accepted').map((m) => m.id));
      }),
      button('review-cancel', 'Cancel', () => review.onCancel?.()),
    );
  }

  /** Marks on the current page, positioned in the canvas's CSS pixels. */
  private drawMarks(): void {
    const viewer = this.viewer;
    if (!viewer) return;
    const transform = viewer.transform();
    const style: Record<PdfMarkState, Partial<CSSStyleDeclaration>> = {
      pending: { border: '2px solid #ff9500', background: 'rgba(255,149,0,0.18)' },
      accepted: { border: '2px solid #1d1d1f', background: this.theme.redactionFill },
      rejected: { border: '1px dashed #8e8e93', background: 'transparent' },
    };
    const boxes: HTMLElement[] = [];
    for (const mark of viewer.marks.filter((m) => m.pageIndex === viewer.state.pageIndex)) {
      for (const rect of mark.rects) {
        const r = transform.toViewRect(rect);
        const box = document.createElement('div');
        box.dataset.markId = mark.id;
        box.dataset.markState = mark.state;
        Object.assign(box.style, { position: 'absolute', left: `${r.x}px`, top: `${r.y}px`,
          width: `${r.width}px`, height: `${r.height}px`, boxSizing: 'border-box' }, style[mark.state]);
        boxes.push(box);
      }
    }
    this.overlay.replaceChildren(...boxes);
    this.renderReview();
  }
```
6. In `attachGestures`, at the start of `onpointerup` after `if (!from || !viewer) return;` and computing `to`/`transform`:
```ts
      // While reviewing, a tap is about a mark; editing tools stay out of the way.
      if (this.review) {
        if (viewer.tapMark(viewer.state.pageIndex, transform.toPdf(to))) this.drawMarks();
        return;
      }
```
7. In `control()`, disable tool buttons while reviewing: after creating `button`, `if (this.review && item.item.kind === 'tool') button.disabled = true;`.
8. At the end of `refresh()`, call `this.drawMarks();`.

In `web/src/index.ts` export `type PdfReviewOptions` next to `PdfViewerElementOptions`.

- [ ] **Step 4: Run the browser test and the web suite**

Run: `cd web && npm test 2>&1 | LC_ALL=C grep -a "ℹ fail" && cd .. && ./scripts/test-web-browser.sh 2>&1 | tail -3`
Expected: `ℹ fail 0`; browser `PASS 19/19`.

- [ ] **Step 5: Commit**

```bash
git add web/src/ui/viewerElement.ts web/src/index.ts web/test-browser/viewer-element.js
git commit -m "Web: review marks on the page, with a review bar that always shows its notice"
```

---
### Task 7: iOS pattern matcher

**Files:**
- Create: `ios/Sources/PDFCoraAI/Redaction/Patterns.swift`, `ios/Tests/PDFCoraAITests/RedactionPatternTests.swift`

**Interfaces:**
- Consumes: `conformance/redaction/patterns.json`.
- Produces: `public enum PdfRedactionCategory: String, CaseIterable, Sendable { case iban, email, phone, paymentCard, date, url, ipAddress, personName, postalAddress, dateOfBirth, idNumber; static let patterns: [PdfRedactionCategory]; static let model: [PdfRedactionCategory] }`; `struct PatternMatch: Equatable { category; range: Range<Int> }`; `enum Patterns { static func find(in text: String, categories: Set<PdfRedactionCategory>? = nil) -> [PatternMatch] }` (UTF-16 offsets).

- [ ] **Step 1: Write the failing test**

```swift
import XCTest
@testable import PDFCoraAI

final class RedactionPatternTests: LicensedTestCase {
    struct Case: Decodable { let text: String; let expected: [[String]] }

    static let root = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent().deletingLastPathComponent()

    func testSharedCases() throws {
        let data = try Data(contentsOf: Self.root.appendingPathComponent("conformance/redaction/patterns.json"))
        for c in try JSONDecoder().decode([Case].self, from: data) {
            let text = NSString(string: c.text)
            let found = Patterns.find(in: c.text).map {
                [$0.category.rawValue, text.substring(with: NSRange(location: $0.range.lowerBound, length: $0.range.count))]
            }
            XCTAssertEqual(found, c.expected, c.text)
        }
    }

    func testCategoriesRestrictWhatIsLookedFor() {
        let found = Patterns.find(in: "anna@example.com 4111 1111 1111 1111", categories: [.email])
        XCTAssertEqual(found.map(\.category), [.email])
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `./build/run-ios-tests.sh PDFCoraAITests/RedactionPatternTests`
Expected: `cannot find 'Patterns' in scope`.

- [ ] **Step 3: Implement `Patterns.swift`**

```swift
import Foundation

public enum PdfRedactionCategory: String, CaseIterable, Sendable {
    case iban, email, phone, paymentCard, date, url, ipAddress
    case personName, postalAddress, dateOfBirth, idNumber

    /// Found by pattern, in tie-break order.
    public static let patterns: [PdfRedactionCategory] = [.iban, .email, .phone, .paymentCard, .date, .url, .ipAddress]
    /// Found by a model.
    public static let model: [PdfRedactionCategory] = [.personName, .postalAddress, .dateOfBirth, .idNumber]
}

struct PatternMatch: Equatable {
    let category: PdfRedactionCategory
    let range: Range<Int>
}

/// Personal data found by pattern alone (RED-1). Behaviour is pinned by
/// conformance/redaction/patterns.json, which every platform runs. Offsets are UTF-16.
enum Patterns {
    private typealias Accept = (_ text: NSString, _ range: Range<Int>) -> Range<Int>?

    private static let months: [String: Int] = [
        "January": 1, "February": 2, "March": 3, "April": 4, "May": 5, "June": 6, "July": 7, "August": 8,
        "September": 9, "October": 10, "November": 11, "December": 12,
        "Januar": 1, "Februar": 2, "März": 3, "Mai": 5, "Juni": 6, "Juli": 7, "Oktober": 10, "Dezember": 12,
        "Sept": 9, "Jan": 1, "Feb": 2, "Mar": 3, "Mär": 3, "Apr": 4, "Jun": 6, "Jul": 7, "Aug": 8, "Sep": 9,
        "Oct": 10, "Okt": 10, "Nov": 11, "Dec": 12, "Dez": 12, "Jän": 1,
    ]
    private static let month = months.keys.sorted { $0.count > $1.count }.joined(separator: "|")
    private static let hex = "[0-9A-Fa-f]{1,4}"

    private static let rules: [(PdfRedactionCategory, NSRegularExpression, Accept)] = [
        (.iban, regex("[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}"), acceptIban),
        (.email, regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), acceptEmail),
        (.phone, regex("\\+[0-9]{1,3}(?:[ .\\-/]?\\(?[0-9]{1,4}\\)?){2,6}"), acceptPhone),
        (.phone, regex("\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-][0-9]{4}"), acceptPhone),
        (.phone, regex("0[0-9]{2,4}(?:[ /-]?[0-9]{2,8}){1,3}"), acceptPhone),
        (.paymentCard, regex("[0-9](?:[ -]?[0-9]){12,18}"), acceptCard),
        (.date, regex("[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\.[0-9]{1,2}\\.(?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}"), acceptDate),
        (.date, regex("[0-9]{1,2}\\.? (?:\(month))\\.? [0-9]{4}|(?:\(month))\\.? [0-9]{1,2},? [0-9]{4}"), acceptDate),
        (.url, regex("https?://[^\\s<>\"]+|www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?:/[^\\s<>\"]*)?"), acceptUrl),
        (.ipAddress, regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}"), acceptIp),
        (.ipAddress, regex("(?:\(hex):){7}\(hex)|(?:\(hex):){1,7}:(?:\(hex)(?::\(hex)){0,6})?|::\(hex)(?::\(hex)){0,6}"), acceptIp),
    ]

    private static func regex(_ pattern: String) -> NSRegularExpression { try! NSRegularExpression(pattern: pattern) }

    static func find(in string: String, categories: Set<PdfRedactionCategory>? = nil) -> [PatternMatch] {
        let text = NSString(string: string)
        var candidates: [PatternMatch] = []
        for (category, regex, accept) in rules where categories?.contains(category) ?? true {
            var from = 0
            while from < text.length,
                  let match = regex.firstMatch(in: string, range: NSRange(location: from, length: text.length - from)) {
                let range = match.range.location..<(match.range.location + match.range.length)
                if let accepted = accept(text, range) { candidates.append(PatternMatch(category: category, range: accepted)) }
                // A rejected match may hide a valid one starting one character later.
                from = match.range.location + 1
            }
        }
        let order = { (c: PdfRedactionCategory) in PdfRedactionCategory.patterns.firstIndex(of: c)! }
        candidates.sort {
            $0.range.count != $1.range.count ? $0.range.count > $1.range.count
                : order($0.category) != order($1.category) ? order($0.category) < order($1.category)
                : $0.range.lowerBound < $1.range.lowerBound
        }
        var chosen: [PatternMatch] = []
        for c in candidates where !chosen.contains(where: { c.range.overlaps($0.range) }) { chosen.append(c) }
        return chosen.sorted { $0.range.lowerBound < $1.range.lowerBound }
    }

    // MARK: - Validators

    private static func char(_ text: NSString, _ i: Int) -> String? {
        i >= 0 && i < text.length ? text.substring(with: NSRange(location: i, length: 1)) : nil
    }
    private static func isWord(_ text: NSString, _ i: Int) -> Bool {
        guard i >= 0, i < text.length, let scalar = UnicodeScalar(text.character(at: i)) else { return false }
        return CharacterSet.letters.contains(scalar) || CharacterSet.decimalDigits.contains(scalar)
    }
    private static func sub(_ text: NSString, _ range: Range<Int>) -> String {
        let lower = max(0, range.lowerBound), upper = min(text.length, range.upperBound)
        return lower < upper ? text.substring(with: NSRange(location: lower, length: upper - lower)) : ""
    }
    private static func matches(_ s: String, _ pattern: String) -> Bool {
        s.range(of: pattern, options: .regularExpression) != nil
    }
    private static func continuesBefore(_ text: NSString, _ start: Int) -> Bool { matches(sub(text, (start - 2)..<start), "[0-9][ .\\-/]$") }
    private static func continuesAfter(_ text: NSString, _ end: Int) -> Bool { matches(sub(text, end..<(end + 2)), "^[ .\\-/][0-9]") }

    private static func mod97(_ iban: String) -> Int {
        let chars = Array(iban)
        var remainder = 0
        for ch in chars[4...] + chars[..<4] {
            let value = ch.isLetter ? String(Int(ch.asciiValue!) - 55) : String(ch)
            for digit in value { remainder = (remainder * 10 + Int(String(digit))!) % 97 }
        }
        return remainder
    }

    private static func luhn(_ digits: [Int]) -> Bool {
        var sum = 0
        for (i, d) in digits.reversed().enumerated() {
            var v = d
            if i % 2 == 1 { v *= 2; if v > 9 { v -= 9 } }
            sum += v
        }
        return sum % 10 == 0
    }

    private static func validDate(_ year: Int, _ month: Int, _ day: Int) -> Bool {
        guard (1...12).contains(month), day >= 1 else { return false }
        let leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
    }

    private static let acceptIban: Accept = { text, range in
        guard !isWord(text, range.lowerBound - 1) else { return nil }
        let positions = range.filter { matches(sub(text, $0..<($0 + 1)), "^[A-Z0-9]$") }
        for k in stride(from: min(34, positions.count), through: 15, by: -1) {
            let stop = positions[k - 1] + 1
            if isWord(text, stop) { continue }
            if mod97(positions[..<k].map { sub(text, $0..<($0 + 1)) }.joined()) == 1 { return range.lowerBound..<stop }
        }
        return nil
    }

    private static let acceptEmail: Accept = { text, range in
        matches(char(text, range.lowerBound - 1) ?? "", "^[A-Za-z0-9._%+-]$") || isWord(text, range.upperBound) ? nil : range
    }

    private static let acceptPhone: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == "+" || isWord(text, range.upperBound) { return nil }
        if continuesBefore(text, range.lowerBound) || continuesAfter(text, range.upperBound) { return nil }
        let digits = sub(text, range).filter(\.isNumber).count
        return (7...15).contains(digits) ? range : nil
    }

    private static let acceptCard: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || isWord(text, range.upperBound) { return nil }
        if continuesBefore(text, range.lowerBound) || continuesAfter(text, range.upperBound) { return nil }
        let digits = sub(text, range).compactMap(\.wholeNumberValue)
        return (13...19).contains(digits.count) && luhn(digits) ? range : nil
    }

    private static let acceptDate: Accept = { text, range in
        if isWord(text, range.lowerBound - 1) || isWord(text, range.upperBound) || continuesAfter(text, range.upperBound) { return nil }
        let s = sub(text, range)
        func groups(_ pattern: String) -> [String]? {
            guard let m = try! NSRegularExpression(pattern: pattern).firstMatch(in: s, range: NSRange(location: 0, length: (s as NSString).length)) else { return nil }
            return (1..<m.numberOfRanges).map { (s as NSString).substring(with: m.range(at: $0)) }
        }
        if let g = groups("^([0-9]{4})-([0-9]{2})-([0-9]{2})$") { return validDate(Int(g[0])!, Int(g[1])!, Int(g[2])!) ? range : nil }
        if let g = groups("^([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{2}|[0-9]{4})$") {
            let year = g[2].count == 2 ? 2000 + Int(g[2])! : Int(g[2])!
            return validDate(year, Int(g[1])!, Int(g[0])!) ? range : nil
        }
        if let g = groups("^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$") {
            return validDate(Int(g[2])!, Int(g[0])!, Int(g[1])!) || validDate(Int(g[2])!, Int(g[1])!, Int(g[0])!) ? range : nil
        }
        if let g = groups("^([0-9]{1,2})\\.? (\(month))\\.? ([0-9]{4})$") { return validDate(Int(g[2])!, months[g[1]]!, Int(g[0])!) ? range : nil }
        if let g = groups("^(\(month))\\.? ([0-9]{1,2}),? ([0-9]{4})$") { return validDate(Int(g[2])!, months[g[0]]!, Int(g[1])!) ? range : nil }
        return nil
    }

    private static let acceptUrl: Accept = { text, range in
        guard !isWord(text, range.lowerBound - 1) else { return nil }
        var stop = range.upperBound
        while stop > range.lowerBound, ".,;:)".contains(char(text, stop - 1) ?? "") { stop -= 1 }
        return stop - range.lowerBound >= 8 ? range.lowerBound..<stop : nil
    }

    private static let acceptIp: Accept = { text, range in
        let s = sub(text, range)
        if s.contains(":") {
            if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == ":"
                || isWord(text, range.upperBound) || char(text, range.upperBound) == ":" { return nil }
            let groups = s.split(separator: ":", omittingEmptySubsequences: true)
            return groups.count <= 8 && (s.contains("::") || groups.count == 8) ? range : nil
        }
        if isWord(text, range.lowerBound - 1) || char(text, range.lowerBound - 1) == "."
            || isWord(text, range.upperBound) || continuesAfter(text, range.upperBound) { return nil }
        return s.split(separator: ".").allSatisfy { Int($0)! <= 255 } ? range : nil
    }
}
```

Note on `month` inside a raw regex: the Swift strings above interpolate `month` and `hex`; they contain no regex metacharacters except `|`, which is intended.

- [ ] **Step 4: Run the tests**

Run: `./build/run-ios-tests.sh PDFCoraAITests/RedactionPatternTests`
Expected: `Executed 2 tests, with 0 failures`. On a mismatch, compare with the web output for the same case (`node --input-type=module -e` importing `web-ai/dist/redaction/patterns.js`): the platforms must agree, and the web implementation passed first.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/PDFCoraAI/Redaction ios/Tests/PDFCoraAITests/RedactionPatternTests.swift
git commit -m "iOS AI: redaction patterns, matching the shared cases"
```

---
### Task 8: iOS core — snapshots and viewer marks

**Files:**
- Create: `ios/Sources/PDFCora/Snapshot.swift`, `ios/Sources/PDFCora/View/Marks.swift`, `ios/Tests/PDFCoraTests/SnapshotAndMarksTests.swift`
- Modify: `ios/Sources/PDFCora/PdfDocument.swift` (`needsWatermark` setter becomes internal), `ios/Sources/PDFCora/View/Viewer.swift` (marks storage)

**Interfaces:**
- Produces: `PdfDocument.snapshot() throws -> PdfDocumentSnapshot`; `public final class PdfDocumentSnapshot: Sendable { public func open() async throws -> PdfDocument }`; `public enum PdfMarkState: Sendable { case pending, accepted, rejected }`; `public struct PdfMark: Equatable, Sendable { id: String; pageIndex: Int; rects: [PdfRect]; state: PdfMarkState; public init(...) }`; on `PdfViewer`: `marks: [PdfMark]`, `setMarks(_:)`, `setAllMarks(_:)`, `markAt(page:point:) -> String?`, `tapMark(page:point:) -> String?` (discardable).

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import PDFCora

final class SnapshotAndMarksTests: LicensedTestCase {
    private func read(_ name: String) throws -> Data { try Data(contentsOf: Repo.corpus.appendingPathComponent(name)) }
    private func rect(_ l: Double, _ b: Double, _ r: Double, _ t: Double) -> PdfRect { PdfRect(left: l, bottom: b, right: r, top: t) }

    func testASnapshotReopensTheDocumentAsItWas() async throws {
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        try await document.page(0).addNote(rect: rect(10, 10, 30, 30), contents: "kept")
        let snapshot = try await document.snapshot()
        _ = try await document.redact([.textMatches("Hello")])

        let copy = try await snapshot.open()
        let text = try await copy.page(0).text.string()
        XCTAssertTrue(text.contains("Hello"))
        let annotations = try await copy.page(0).annotations()
        XCTAssertEqual(annotations.count, 1)
    }

    func testASnapshotOfAWatermarkedDocumentReopensWatermarked() async throws {
        PdfLicense.configureForTesting(key: .some(nil))
        defer { LicensedTestCase.installFullTestLicense() }
        let document = try await PdfDocument(data: try read("hello_world.pdf"))
        let copy = try await document.snapshot().open()
        let needs = await copy.needsWatermark
        XCTAssertTrue(needs)
        let saved = try await PdfDocument(data: try await copy.data())
        let text = try await saved.page(0).text.string()
        XCTAssertEqual(text.components(separatedBy: "PDFCora trial").count - 1, 1)
    }

    private func viewer() async throws -> PdfViewer {
        try await PdfViewer(document: try await PdfDocument(data: try read("hello_world.pdf")), viewport: CGSize(width: 400, height: 600))
    }

    func testMarksAreHitTestedTopmostFirstAndTapsCycle() async throws {
        let v = try await viewer()
        await v.setMarks([PdfMark(id: "a", pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: .pending),
                          PdfMark(id: "b", pageIndex: 0, rects: [rect(50, 20, 80, 30)], state: .pending)])
        let top = await v.markAt(page: 0, point: PdfPoint(x: 60, y: 25))
        XCTAssertEqual(top, "b")
        let other = await v.markAt(page: 1, point: PdfPoint(x: 20, y: 15))
        XCTAssertNil(other)
        var states: [PdfMarkState] = []
        for _ in 0..<3 {
            await v.tapMark(page: 0, point: PdfPoint(x: 20, y: 15))
            states.append(await v.marks[0].state)
        }
        XCTAssertEqual(states, [.accepted, .rejected, .pending])
        await v.setAllMarks(.accepted)
        let all = await v.marks.map(\.state)
        XCTAssertEqual(all, [.accepted, .accepted])
    }

    func testMarksNeverReachTheEventStream() async throws {
        let v = try await viewer()
        let events = LockedCount()
        _ = await v.onEvent { _ in events.increment() }
        await v.setMarks([PdfMark(id: "a", pageIndex: 0, rects: [rect(10, 10, 100, 40)], state: .pending)])
        await v.tapMark(page: 0, point: PdfPoint(x: 20, y: 20))
        await v.setAllMarks(.rejected)
        await v.flush()
        XCTAssertEqual(events.value, 0)
    }
}

final class LockedCount: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0
    func increment() { lock.lock(); count += 1; lock.unlock() }
    var value: Int { lock.lock(); defer { lock.unlock() }; return count }
}
```

Check the viewer init signature (`PdfViewer(document:viewport:)` in `View/Viewer.swift:62`) and `onEvent` (line 83) before running; match any extra required parameters.

- [ ] **Step 2: Run to verify it fails**

Run: `./build/run-ios-tests.sh PDFCoraTests/SnapshotAndMarksTests`
Expected: `value of type 'PdfDocument' has no member 'snapshot'`.

- [ ] **Step 3: Implement**

`PdfDocument.swift`: change `private(set) var needsWatermark = PdfLicense.status.isTrial` to `var needsWatermark = PdfLicense.status.isTrial`.

`Snapshot.swift`:
```swift
import Foundation
@_implementationOnly import CPdfium

/// A document as it was when ``PdfDocument/snapshot()`` was called.
///
/// The bytes are never exposed: they are not watermarked, and handing them out would be a
/// way round the license. The reopened document needs the watermark if the original did.
public final class PdfDocumentSnapshot: Sendable {
    private let bytes: Data
    private let needsWatermark: Bool

    init(bytes: Data, needsWatermark: Bool) {
        self.bytes = bytes
        self.needsWatermark = needsWatermark
    }

    /// Opens a new document from the snapshot. Each call opens another.
    public func open() async throws -> PdfDocument {
        let document = try await PdfDocument(data: bytes)
        if needsWatermark { await document.markNeedsWatermark() }
        return document
    }
}

extension PdfDocument {
    /// A copy of the document as it is now, to reopen later — for undoing a change that
    /// cannot be undone in place, such as a redaction.
    public func snapshot() throws -> PdfDocumentSnapshot {
        let handle = try requireHandle()
        if let form { FORM_ForceToKillFocus(form) }
        return PdfDocumentSnapshot(bytes: try Self.serialise(handle, flags: FPDF_DWORD(FPDF_NO_INCREMENTAL)),
                                   needsWatermark: needsWatermark)
    }

    func markNeedsWatermark() { needsWatermark = true }
}
```

`View/Marks.swift`:
```swift
import Foundation

public enum PdfMarkState: Sendable, Equatable { case pending, accepted, rejected }

/// A reviewable region drawn over a page, such as a redaction suggestion.
public struct PdfMark: Equatable, Sendable {
    public let id: String
    public let pageIndex: Int
    public let rects: [PdfRect]
    public var state: PdfMarkState

    public init(id: String, pageIndex: Int, rects: [PdfRect], state: PdfMarkState = .pending) {
        self.id = id
        self.pageIndex = pageIndex
        self.rects = rects
        self.state = state
    }
}

// Local to one viewer: none of these emit an event, so a sync transport never carries a
// review, and none touch the document.
extension PdfViewer {
    public func setMarks(_ marks: [PdfMark]) { self.marks = marks }

    public func setAllMarks(_ state: PdfMarkState) {
        marks = marks.map { var mark = $0; mark.state = state; return mark }
    }

    /// The id of the topmost mark under a point on a page — the last one set — or nil.
    public func markAt(page: Int, point: PdfPoint) -> String? {
        marks.last { $0.pageIndex == page && $0.rects.contains { $0.contains(point) } }?.id
    }

    /// Cycles the tapped mark pending → accepted → rejected → pending. Returns its id, or nil.
    @discardableResult
    public func tapMark(page: Int, point: PdfPoint) -> String? {
        guard let id = markAt(page: page, point: point), let i = marks.firstIndex(where: { $0.id == id }) else { return nil }
        switch marks[i].state {
        case .pending: marks[i].state = .accepted
        case .accepted: marks[i].state = .rejected
        case .rejected: marks[i].state = .pending
        }
        return id
    }
}
```

`View/Viewer.swift`: in the actor body add the storage the extension uses (an extension cannot add stored properties):
```swift
    /// See `Marks.swift`.
    public internal(set) var marks: [PdfMark] = []
```

Check `PdfRect.contains(_:)` (`Geometry.swift:170`) treats edges as inside; the tests hit interior points either way.

- [ ] **Step 4: Run the tests**

Run: `./build/run-ios-tests.sh PDFCoraTests/SnapshotAndMarksTests`
Expected: `Executed 4 tests, with 0 failures`.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/PDFCora ios/Tests/PDFCoraTests/SnapshotAndMarksTests.swift
git commit -m "iOS: document snapshots and viewer marks"
```

---
### Task 9: iOS AI — suggest, apply and undo

**Files:**
- Create: `ios/Sources/PDFCoraAI/Redaction/Suggest.swift`, `ios/Tests/PDFCoraAITests/RedactionSuggestTests.swift`
- Modify: `ios/Sources/PDFCoraAI/PdfAI.swift` (`appleReading()` from `fileprivate` to internal; add `redactions`)

**Interfaces:**
- Consumes: `Patterns.find` (Task 7); `PdfDocument.snapshot()` (Task 8); existing `TextLayer.readPages`, `TextLayer.sentences(of:)`, `TextLayer.rects`, `locateQuote(in:_:)`, `resolveRoutes`, `AppleModel.respond(to:)`, `Trial`.
- Produces: `public struct PdfRedactionSuggestion: Sendable, Equatable { id; category: PdfRedactionCategory; source: PdfAiSource; pageIndex: Int; range: Range<Int>; text: String; rects: [PdfRect] }`; `public struct PdfRedactionReview: Sendable { suggestions; modelUsed: Bool; notice: String; pagesWithoutText: [Int]; func apply(accepting: [String]) async throws -> PdfRedactionApplied }`; `public struct PdfRedactionApplied: Sendable { report: PdfRedactionReport; remaining: [PdfRedactionSuggestion]; func undo() async throws -> PdfDocument }`; `PdfAI.redactions.suggest(pages: ClosedRange<Int>? = nil, categories: Set<PdfRedactionCategory>? = nil) async throws -> PdfRedactionReview`; `enum PdfRedactionError: Error { case unknownSuggestion(String) }`.

- [ ] **Step 1: Write the failing tests**

```swift
import XCTest
@testable import PDFCora
@testable import PDFCoraAI

final class RedactionSuggestTests: LicensedTestCase {
    struct Expected: Decodable, Equatable { let pageIndex: Int; let category: String; let text: String }
    static let dir = RedactionPatternTests.root.appendingPathComponent("conformance/redaction")

    private func pii() async throws -> PdfDocument {
        try await PdfDocument(data: try Data(contentsOf: Self.dir.appendingPathComponent("pii.pdf")))
    }
    private func ai(_ document: PdfDocument, _ provider: PdfAiProvider? = nil) -> PdfAI {
        var options = PdfAIOptions(provider: provider)
        options.allowsOnDevice = false
        return PdfAI(document: document, options: options)
    }

    struct Items: PdfAiProvider {
        let items: [[String: String]]
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse {
            let json = String(data: try JSONSerialization.data(withJSONObject: ["items": items]), encoding: .utf8)!
            return PdfAiResponse(text: json, structured: json)
        }
    }
    struct Failing: PdfAiProvider {
        func generate(_ request: PdfAiRequest) async throws -> PdfAiResponse { throw URLError(.notConnectedToInternet) }
    }

    func testPatternsAloneFindExactlyTheExpectedItems() async throws {
        let expected = try JSONDecoder().decode([Expected].self, from: Data(contentsOf: Self.dir.appendingPathComponent("pii-expected.json")))
        let review = try await ai(try await pii()).redactions.suggest()
        XCTAssertFalse(review.modelUsed)
        XCTAssertTrue(review.notice.contains("Suggestions may be incomplete. Review the whole document."))
        XCTAssertEqual(review.suggestions.map { Expected(pageIndex: $0.pageIndex, category: $0.category.rawValue, text: $0.text) }, expected)
        for s in review.suggestions {
            XCTAssertEqual(s.source, .rules)
            XCTAssertEqual(s.id, "\(s.pageIndex):\(s.range.lowerBound)-\(s.range.upperBound):\(s.category.rawValue)")
            XCTAssertFalse(s.rects.isEmpty, s.text)
        }
    }

    func testModelQuotesAreVerifiedExpandedAndNeverOverlapAPattern() async throws {
        let provider = Items(items: [["category": "personName", "quote": "Anna Schmidt"],
                                     ["category": "personName", "quote": "Nobody Invented"],
                                     ["category": "dateOfBirth", "quote": "14 March 1985"],
                                     ["category": "idNumber", "quote": "Li"],
                                     ["category": "bankBalance", "quote": "Customer record"]])
        let review = try await ai(try await pii(), provider).redactions.suggest(pages: 0...0)
        XCTAssertTrue(review.modelUsed)
        let fromModel = review.suggestions.filter { $0.source == .customProvider }.map { [$0.category.rawValue, $0.text] }
        XCTAssertEqual(fromModel, [["personName", "Anna Schmidt"], ["personName", "Anna Schmidt"]])
    }

    func testAFailingModelLeavesThePatterns() async throws {
        let review = try await ai(try await pii(), Failing()).redactions.suggest()
        XCTAssertFalse(review.modelUsed)
        XCTAssertEqual(review.suggestions.count, 25)
    }

    func testApplyRemovesAcceptedTextKeepsRejectedAndUndoRestores() async throws {
        let document = try await pii()
        let review = try await ai(document).redactions.suggest(pages: 0...0)
        let email = try XCTUnwrap(review.suggestions.first { $0.category == .email })
        let iban = try XCTUnwrap(review.suggestions.first { $0.category == .iban })

        let applied = try await review.apply(accepting: [email.id])
        XCTAssertEqual(applied.remaining, [])
        let saved = try await PdfDocument(data: try await document.data(mode: .full))
        let text = try await saved.page(0).text.string()
        XCTAssertFalse(text.contains(email.text))
        XCTAssertTrue(text.contains(iban.text))
        XCTAssertTrue(text.contains("Email"))

        let restored = try await applied.undo()
        let back = try await restored.page(0).text.string()
        XCTAssertTrue(back.contains(email.text))
    }

    func testAnUnknownIdWritesNothing() async throws {
        let document = try await pii()
        let review = try await ai(document).redactions.suggest()
        let first = review.suggestions[0]
        do {
            _ = try await review.apply(accepting: [first.id, "nope"])
            XCTFail("expected a throw")
        } catch PdfRedactionError.unknownSuggestion(let id) {
            XCTAssertEqual(id, "nope")
        }
        let text = try await document.page(0).text.string()
        XCTAssertTrue(text.contains(first.text))
    }
}
```

Check `PdfAiResponse`'s initialiser and `structured` type in `Provider.swift`, and how `AnswersTests` builds a provider (`Model`), and match them.

- [ ] **Step 2: Run to verify it fails**

Run: `./build/run-ios-tests.sh PDFCoraAITests/RedactionSuggestTests`
Expected: `value of type 'PdfAI' has no member 'redactions'`.

- [ ] **Step 3: Implement `Suggest.swift`**

```swift
import Foundation
import PDFCora

public let redactionNotice = "Suggestions may be incomplete. Review the whole document."

public struct PdfRedactionSuggestion: Sendable, Equatable {
    public let id: String
    public let category: PdfRedactionCategory
    public let source: PdfAiSource
    public let pageIndex: Int
    /// UTF-16 offsets into the page text.
    public let range: Range<Int>
    public let text: String
    public let rects: [PdfRect]
}

public enum PdfRedactionError: Error, Equatable { case unknownSuggestion(String) }

public struct PdfRedactionApplied: Sendable {
    public let report: PdfRedactionReport
    /// Accepted suggestions whose text is still on the page. Empty unless something went wrong.
    public let remaining: [PdfRedactionSuggestion]
    let snapshot: PdfDocumentSnapshot
    /// Reopens the document as it was before `apply`. The host shows it and closes the redacted one.
    public func undo() async throws -> PdfDocument { try await snapshot.open() }
}

public struct PdfRedactionReview: Sendable {
    public let suggestions: [PdfRedactionSuggestion]
    /// False when no model answered, so only patterns ran.
    public let modelUsed: Bool
    /// Must be shown with the suggestions (RED-4).
    public let notice: String
    public let pagesWithoutText: [Int]
    let document: PdfDocument
    let textBefore: [Int: String]

    public func apply(accepting acceptedIds: [String]) async throws -> PdfRedactionApplied {
        let known = Set(suggestions.map(\.id))
        if let unknown = acceptedIds.first(where: { !known.contains($0) }) { throw PdfRedactionError.unknownSuggestion(unknown) }
        let accepted = suggestions.filter { acceptedIds.contains($0.id) }

        let snapshot = try await document.snapshot()
        let report = try await document.redact(accepted.flatMap { s in s.rects.map { .region($0, pageIndex: s.pageIndex) } })

        // Offsets move once text is removed, so count occurrences instead.
        var remaining: [PdfRedactionSuggestion] = []
        for pageIndex in Set(accepted.map(\.pageIndex)) {
            let after = try await document.page(pageIndex).text.string()
            let before = textBefore[pageIndex] ?? ""
            let onPage = accepted.filter { $0.pageIndex == pageIndex }
            for text in Set(onPage.map(\.text)) {
                let same = onPage.filter { $0.text == text }
                if RedactionSuggester.occurrences(of: text, in: after).count
                    > RedactionSuggester.occurrences(of: text, in: before).count - same.count {
                    remaining.append(contentsOf: same)
                }
            }
        }
        return PdfRedactionApplied(report: report, remaining: remaining.sorted { $0.id < $1.id }, snapshot: snapshot)
    }
}

enum RedactionSuggester {
    struct Item: Sendable { let category: PdfRedactionCategory; let quote: String }

    static func prompt(_ text: String) -> String {
        [
            "Find personal data in the text below.",
            "Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),",
            "dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).",
            "Copy each quote exactly as it appears in the text. Reply with JSON: {\"items\": [{\"category\": \"...\", \"quote\": \"...\"}]}.",
            "Reply with {\"items\": []} when there is none.",
            "",
            text,
        ].joined(separator: "\n")
    }

    static let schema = """
    {"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"category":{"type":"string","enum":["personName","postalAddress","dateOfBirth","idNumber"]},"quote":{"type":"string"}},"required":["category","quote"]}}},"required":["items"]}
    """

    static func occurrences(of quote: String, in text: String) -> [Range<Int>] {
        let units = NSString(string: text)
        var found: [Range<Int>] = []
        var offset = 0
        while offset < units.length, let at = locateQuote(in: units.substring(from: offset), quote) {
            found.append((offset + at.lowerBound)..<(offset + at.upperBound))
            offset += at.upperBound
        }
        return found
    }

    static func parse(_ text: String) -> [(category: String, quote: String)] {
        guard let from = text.firstIndex(of: "{"), let to = text.lastIndex(of: "}"),
              let object = try? JSONSerialization.jsonObject(with: Data(text[from...to].utf8)) as? [String: Any],
              let items = object["items"] as? [[String: Any]] else { return [] }
        return items.compactMap { item in
            guard let category = item["category"] as? String, let quote = item["quote"] as? String else { return nil }
            return (category, quote)
        }
    }

    /// Page text in pieces of at most `limit` UTF-16 units, split between sentences.
    static func chunks(_ pages: [PdfPageText], limit: Int) -> [String] {
        var chunks: [String] = []
        for page in pages {
            let units = NSString(string: page.text)
            var current = ""
            for sentence in TextLayer.sentences(of: page.text) {
                let piece = units.substring(with: NSRange(location: sentence.lowerBound, length: sentence.count))
                if !current.isEmpty, (current as NSString).length + (piece as NSString).length + 1 > limit {
                    chunks.append(current)
                    current = ""
                }
                current = current.isEmpty ? String(piece.prefix(limit)) : current + " " + piece
            }
            if !current.isEmpty { chunks.append(current) }
        }
        return chunks
    }

    static func verified(_ reply: String, chunk: String, wanted: Set<PdfRedactionCategory>) -> [Item] {
        parse(reply).compactMap { raw in
            guard let category = PdfRedactionCategory(rawValue: raw.category), PdfRedactionCategory.model.contains(category),
                  wanted.contains(category), raw.quote.trimmingCharacters(in: .whitespaces).count >= 3,
                  locateQuote(in: chunk, raw.quote) != nil else { return nil }
            return Item(category: category, quote: raw.quote)
        }
    }
}

extension PdfAI {
    public struct Redactions: Sendable {
        let ai: PdfAI

        /// Suggests likely personal data to redact (RED). Patterns run on every device; Apple's
        /// on-device model, or the custom provider, adds names, addresses, dates of birth and
        /// ID numbers. Nothing is written until `apply`.
        public func suggest(pages: ClosedRange<Int>? = nil,
                            categories: Set<PdfRedactionCategory>? = nil) async throws -> PdfRedactionReview {
            let wanted = categories ?? Set(PdfRedactionCategory.allCases)
            let document = ai.document
            let (pageTexts, pagesWithoutText) = try await TextLayer.readPages(document, range: pages)

            var found: [(category: PdfRedactionCategory, source: PdfAiSource, pageIndex: Int, range: Range<Int>)] = []
            for page in pageTexts {
                for match in Patterns.find(in: page.text, categories: wanted.intersection(PdfRedactionCategory.patterns)) {
                    found.append((match.category, .rules, page.pageIndex, match.range))
                }
            }

            var modelUsed = false
            let modelWanted = wanted.intersection(PdfRedactionCategory.model)
            let apple = ai.appleReading()
            let appleTokens = apple?.isPromptable == true ? apple?.contextTokens : nil
            let provider = ai.options.provider
            if !modelWanted.isEmpty, appleTokens != nil || provider != nil {
                func limit(_ tokens: Int) -> Int { Int(Double(tokens * GroundedAnswers.charsPerToken) * 0.6) }
                let outcome = await resolveRoutes(
                    onDevice: appleTokens.map { tokens in {
                        var items: [RedactionSuggester.Item] = []
                        for chunk in RedactionSuggester.chunks(pageTexts, limit: limit(tokens)) {
                            guard let reply = try await AppleModel.respond(to: RedactionSuggester.prompt(chunk)) else { return nil }
                            items += RedactionSuggester.verified(reply, chunk: chunk, wanted: modelWanted)
                        }
                        return items
                    } },
                    customProvider: provider.map { provider in {
                        var items: [RedactionSuggester.Item] = []
                        for chunk in RedactionSuggester.chunks(pageTexts, limit: limit(ai.options.providerContextTokens)) {
                            let response = try await provider.generate(PdfAiRequest(prompt: RedactionSuggester.prompt(chunk),
                                                                                   schema: RedactionSuggester.schema))
                            items += RedactionSuggester.verified(response.text, chunk: chunk, wanted: modelWanted)
                        }
                        return items
                    } })
                if case .answered(let result) = outcome {
                    modelUsed = true
                    for item in result.value {
                        for page in pageTexts {
                            for range in RedactionSuggester.occurrences(of: item.quote, in: page.text) {
                                found.append((item.category, result.source, page.pageIndex, range))
                            }
                        }
                    }
                }
            }

            // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
            let kept = found.filter { s in
                s.source == .rules || !found.contains { $0.source == .rules && $0.pageIndex == s.pageIndex && $0.range.overlaps(s.range) }
            }
            var seen = Set<String>()
            let textBefore = Dictionary(uniqueKeysWithValues: pageTexts.map { ($0.pageIndex, $0.text) })
            var suggestions: [PdfRedactionSuggestion] = []
            for s in kept.sorted(by: { ($0.pageIndex, $0.range.lowerBound) < ($1.pageIndex, $1.range.lowerBound) }) {
                let id = "\(s.pageIndex):\(s.range.lowerBound)-\(s.range.upperBound):\(s.category.rawValue)"
                guard seen.insert(id).inserted else { continue }
                let text = NSString(string: textBefore[s.pageIndex]!).substring(with: NSRange(location: s.range.lowerBound, length: s.range.count))
                suggestions.append(PdfRedactionSuggestion(
                    id: id, category: s.category, source: s.source, pageIndex: s.pageIndex, range: s.range, text: text,
                    rects: try await TextLayer.rects(document, pageIndex: s.pageIndex, range: s.range)))
            }
            return PdfRedactionReview(suggestions: suggestions, modelUsed: modelUsed, notice: Trial.text(redactionNotice),
                                      pagesWithoutText: pagesWithoutText, document: document, textBefore: textBefore)
        }
    }

    /// Suggests likely personal data to redact (RED).
    public var redactions: Redactions { Redactions(ai: self) }
}
```

Add to `Trial.swift`:
```swift
    /// A notice or other SDK text shown without an `ai` license gets the same prefix as model output.
    static func text(_ value: String, licensed: Bool = PdfLicense.status.covers(.ai)) -> String {
        licensed ? value : prefix + value
    }
```

Match to the real code before building: the element type of `TextLayer.readPages` (`PdfPageText` with `pageIndex` and `text`), `PdfAiRequest`'s initialiser (`prompt:schema:`, where `schema` may be typed; pass the JSON string the way `GroundedAnswers.schema` is passed), and `GroundedAnswers.charsPerToken`.

- [ ] **Step 4: Run the tests**

Run: `./build/run-ios-tests.sh PDFCoraAITests`
Expected: all AI tests pass, including the 5 new ones. If "Email" is removed by the redaction, inset each rectangle by 0.3 pt left and right in `apply`, and apply the same inset on web and Android.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/PDFCoraAI ios/Tests/PDFCoraAITests/RedactionSuggestTests.swift
git commit -m "iOS AI: redaction suggestions from patterns, Apple's model and a provider, with apply and undo"
```

---
### Task 10: iOS UI — marks overlay, review bar, demo screen

**Files:**
- Modify: `ios/Sources/PDFCoraUI/PdfViewerView.swift`
- Create: `ios/Sources/PDFCoraUI/Review.swift`, `ios/Demo/Sources/Screens/RedactionReviewScreen.swift`
- Modify: the demo's screen list (find it with `grep -rn "ComponentScreen()" ios/Demo/Sources`), `ios/Demo/UITests/ScreenTourTests.swift`

**Interfaces:**
- Consumes: viewer marks (Task 8); `PdfAI.redactions` (Task 9).
- Produces: `public struct PdfReviewConfiguration { marks: [PdfMark]; notice: String; applyLabel: String; onApply: ([String]) -> Void; onCancel: (() -> Void)?; public init(...) }`; `PdfViewerView(document:toolbar:theme:review:onSave:)`. Accessibility ids: `review-notice`, `review-counts`, `review-accept-all`, `review-reject-all`, `review-apply`, `review-cancel`, and one `mark-<id>` per rect.

- [ ] **Step 1: Write the failing UI test**

Add to `ScreenTourTests`:
```swift
    /// Redaction review in the component: suggestions appear as marks, a tap accepts one,
    /// and Apply redacts it.
    func testRedactionReviewAcceptsAndApplies() {
        let app = XCUIApplication()
        app.launch()
        XCTAssertTrue(app.staticTexts["Hello World"].waitForExistence(timeout: 10))
        let link = app.descendants(matching: .any).matching(identifier: "demo-RedactionReview").firstMatch
        if !link.waitForExistence(timeout: 5) { app.swipeUp() }
        link.tap()

        let notice = app.staticTexts["review-notice"]
        XCTAssertTrue(notice.waitForExistence(timeout: 20))
        XCTAssertTrue(notice.label.contains("may be incomplete"))
        let mark = app.descendants(matching: .any).matching(NSPredicate(format: "identifier BEGINSWITH 'mark-'")).firstMatch
        XCTAssertTrue(mark.waitForExistence(timeout: 10))
        mark.tap()
        let counts = app.staticTexts["review-counts"]
        XCTAssertTrue(counts.waitForLabel(prefix: "1 accepted", timeout: 5), counts.label)
        app.buttons["review-apply"].tap()
        XCTAssertTrue(app.staticTexts["redaction-result"].waitForExistence(timeout: 20))
        save(app, named: "redaction-review-applied")
    }
```
And a helper at file end:
```swift
private extension XCUIElement {
    func waitForLabel(prefix: String, timeout: TimeInterval) -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline { if label.hasPrefix(prefix) { return true }; Thread.sleep(forTimeInterval: 0.2) }
        return false
    }
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `(cd ios/Demo && xcodegen generate >/dev/null) && xcodebuild test -project ios/Demo/PDFCoraDemo.xcodeproj -scheme PDFCoraDemo -destination 'platform=iOS Simulator,name=iPhone 17 Pro,OS=27.0' -only-testing:PDFCoraDemoUITests/ScreenTourTests/testRedactionReviewAcceptsAndApplies 2>&1 | grep -E "error:|Executed" | head -5`
Expected: failure at `link.tap()` (no such screen).

- [ ] **Step 3: Implement**

`Review.swift`:
```swift
import SwiftUI
import PDFCora

/// Puts the viewer in review mode: marks over the page that a tap cycles, and a bar that
/// always shows `notice`. The component does not apply anything; `onApply` does.
public struct PdfReviewConfiguration {
    public var marks: [PdfMark]
    public var notice: String
    public var applyLabel: String
    public var onApply: ([String]) -> Void
    public var onCancel: (() -> Void)?

    public init(marks: [PdfMark], notice: String, applyLabel: String = "Apply",
                onApply: @escaping ([String]) -> Void, onCancel: (() -> Void)? = nil) {
        self.marks = marks
        self.notice = notice
        self.applyLabel = applyLabel
        self.onApply = onApply
        self.onCancel = onCancel
    }
}

struct PdfReviewBar: View {
    let configuration: PdfReviewConfiguration
    let marks: [PdfMark]
    let theme: PdfViewerTheme
    let setAll: (PdfMarkState) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(configuration.notice).font(.caption).accessibilityIdentifier("review-notice")
            HStack {
                Text("\(marks.filter { $0.state == .accepted }.count) accepted · \(marks.filter { $0.state == .pending }.count) pending")
                    .font(.caption).accessibilityIdentifier("review-counts")
                Spacer()
                Button("Accept all") { setAll(.accepted) }.accessibilityIdentifier("review-accept-all")
                Button("Reject all") { setAll(.rejected) }.accessibilityIdentifier("review-reject-all")
                Button(configuration.applyLabel) {
                    configuration.onApply(marks.filter { $0.state == .accepted }.map(\.id))
                }.accessibilityIdentifier("review-apply")
                if let cancel = configuration.onCancel {
                    Button("Cancel", action: cancel).accessibilityIdentifier("review-cancel")
                }
            }
            .font(.caption)
        }
        .padding(8)
        .background(theme.toolbarBackground)
    }
}
```

`PdfViewerView.swift`:
1. Add `private let review: PdfReviewConfiguration?` and `@State private var marks: [PdfMark] = []`; the initialiser gains `review: PdfReviewConfiguration? = nil` before `onSave`.
2. In `body`, below `page`: `if let review { PdfReviewBar(configuration: review, marks: marks, theme: theme) { state in Task { await viewer?.setAllMarks(state); marks = await viewer?.marks ?? [] } } }`.
3. In `open()`, after the viewer is created: `if let review { await viewer?.setMarks(review.marks) }`.
4. In `refresh()`: `marks = await viewer.marks`.
5. In `overlay(_:)`, before the drag rectangle, draw the marks for the current page (the `transform` is needed synchronously, so add `@State private var transform: PdfViewTransform?` set in `refresh()` from `await viewer.transform()`):
```swift
        if let transform {
            ForEach(marks.filter { $0.pageIndex == state.pageIndex }, id: \.id) { mark in
                ForEach(Array(mark.rects.enumerated()), id: \.offset) { _, rect in
                    let box = transform.toView(rect)
                    markShape(mark.state)
                        .frame(width: box.width, height: box.height)
                        .offset(x: box.minX, y: box.minY)
                        .accessibilityElement()
                        .accessibilityIdentifier("mark-\(mark.id)")
                        .accessibilityAddTraits(.isButton)
                        .onTapGesture { Task { await tap(mark: mark, at: CGPoint(x: box.midX, y: box.midY)) } }
                }
            }
        }
```
with
```swift
    @ViewBuilder
    private func markShape(_ state: PdfMarkState) -> some View {
        switch state {
        case .pending: Rectangle().fill(Color.orange.opacity(0.18)).overlay(Rectangle().stroke(Color.orange, lineWidth: 2))
        case .accepted: Rectangle().fill(theme.redactionFill)
        case .rejected: Rectangle().stroke(Color.gray, style: StrokeStyle(lineWidth: 1, dash: [4, 3]))
        }
    }

    private func tap(mark: PdfMark, at point: CGPoint) async {
        guard let viewer, let transform else { return }
        await viewer.tapMark(page: mark.pageIndex, point: transform.toPdf(point))
        marks = await viewer.marks
    }
```
6. In `finish(_:)`, return at the top while reviewing: `if review != nil { return }`; and pass `review != nil` to `PdfToolbarView` so tool items are disabled (add a `reviewing: Bool` parameter there and apply `.disabled(reviewing)` to tool buttons).

`RedactionReviewScreen.swift` (demo):
```swift
import SwiftUI
import PDFCora
import PDFCoraUI
import PDFCoraAI

/// Redaction suggestions reviewed in the component: patterns only, so it runs anywhere.
struct RedactionReviewScreen: View {
    @State private var document: PdfDocument?
    @State private var review: PdfRedactionReview?
    @State private var result: String?

    var body: some View {
        VStack {
            if let result { Text(result).accessibilityIdentifier("redaction-result") }
            if let document, let review {
                PdfViewerView(document: document, review: PdfReviewConfiguration(
                    marks: review.suggestions.map { PdfMark(id: $0.id, pageIndex: $0.pageIndex, rects: $0.rects) },
                    notice: review.notice, applyLabel: "Redact",
                    onApply: { ids in Task {
                        let applied = try await review.apply(accepting: ids)
                        result = "Redacted \(ids.count), \(applied.remaining.count) remaining"
                    } }))
            } else {
                ProgressView()
            }
        }
        .navigationTitle("Redaction review")
        .task {
            guard let url = Bundle.main.url(forResource: "pii", withExtension: "pdf"),
                  let opened = try? await PdfDocument(url: url) else { return }
            document = opened
            review = try? await PdfAI(document: opened).redactions.suggest()
        }
    }
}
```
Register it in the demo's screen list with the identifier `demo-RedactionReview`, following how `ComponentScreen` is listed, add `PDFCoraAI` to the demo target dependencies in `ios/Demo/project.yml` if absent, and copy `conformance/redaction/pii.pdf` into `ios/Demo/Resources/pii.pdf`.

- [ ] **Step 4: Run the UI test and the iOS gate**

Run the Step 2 command again. Expected: `Executed 1 test, with 0 failures`.
Run: `./scripts/test-ios.sh 2>&1 | grep -E "Executed [0-9]+ tests|TEST FAILED|cross-check" | tail -8`
Expected: everything passes; demo UI tests are now 10.

- [ ] **Step 5: Commit**

```bash
git add ios/Sources/PDFCoraUI ios/Demo
git commit -m "iOS: review marks and bar in PdfViewerView, and a redaction review demo screen"
```

---
### Task 11: Android pattern matcher

**Files:**
- Create: `android/pdfcora-ai/src/main/java/com/pdfcora/ai/redaction/Patterns.kt`, `android/pdfcora-ai/src/test/java/com/pdfcora/ai/redaction/PatternsTest.kt`

**Interfaces:**
- Consumes: `conformance/redaction/patterns.json`.
- Produces: `enum class PdfRedactionCategory(val id: String) { IBAN("iban"), EMAIL("email"), PHONE("phone"), PAYMENT_CARD("paymentCard"), DATE("date"), URL("url"), IP_ADDRESS("ipAddress"), PERSON_NAME("personName"), POSTAL_ADDRESS("postalAddress"), DATE_OF_BIRTH("dateOfBirth"), ID_NUMBER("idNumber"); companion { PATTERNS; MODEL } }`; `internal data class PatternMatch(val category: PdfRedactionCategory, val start: Int, val end: Int)`; `internal object Patterns { fun find(text: String, categories: Set<PdfRedactionCategory>? = null): List<PatternMatch> }`.

- [ ] **Step 1: Write the failing JVM test**

```kotlin
package com.pdfcora.ai.redaction

import org.json.JSONArray
import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class PatternsTest {
    // JVM unit tests run with the module directory as the working directory.
    private val cases = JSONArray(File("../../conformance/redaction/patterns.json").readText())

    @Test fun sharedCases() {
        for (i in 0 until cases.length()) {
            val c = cases.getJSONObject(i)
            val text = c.getString("text")
            val expected = c.getJSONArray("expected").let { a -> (0 until a.length()).map { a.getJSONArray(it).let { p -> p.getString(0) to p.getString(1) } } }
            val found = Patterns.find(text).map { it.category.id to text.substring(it.start, it.end) }
            assertEquals(text, expected, found)
        }
    }

    @Test fun categoriesRestrictWhatIsLookedFor() {
        val found = Patterns.find("anna@example.com 4111 1111 1111 1111", setOf(PdfRedactionCategory.EMAIL))
        assertEquals(listOf(PdfRedactionCategory.EMAIL), found.map { it.category })
    }
}
```

`org.json` is an Android stub in JVM unit tests. If `JSONArray` throws "not mocked", add `testImplementation("org.json:json:20240303")` to `android/pdfcora-ai/build.gradle.kts`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfcora-ai:testDebugUnitTest --tests '*PatternsTest' --console=plain -q 2>&1 | grep -E "^e:" | head -2`
Expected: `Unresolved reference: Patterns`.

- [ ] **Step 3: Implement `Patterns.kt`**

```kotlin
package com.pdfcora.ai.redaction

enum class PdfRedactionCategory(val id: String) {
    IBAN("iban"), EMAIL("email"), PHONE("phone"), PAYMENT_CARD("paymentCard"), DATE("date"), URL("url"),
    IP_ADDRESS("ipAddress"), PERSON_NAME("personName"), POSTAL_ADDRESS("postalAddress"),
    DATE_OF_BIRTH("dateOfBirth"), ID_NUMBER("idNumber");

    companion object {
        /** Found by pattern, in tie-break order. */
        val PATTERNS = listOf(IBAN, EMAIL, PHONE, PAYMENT_CARD, DATE, URL, IP_ADDRESS)
        /** Found by a model. */
        val MODEL = listOf(PERSON_NAME, POSTAL_ADDRESS, DATE_OF_BIRTH, ID_NUMBER)
    }
}

internal data class PatternMatch(val category: PdfRedactionCategory, val start: Int, val end: Int)

/**
 * Personal data found by pattern alone (RED-1). Behaviour is pinned by
 * conformance/redaction/patterns.json, which every platform runs.
 */
internal object Patterns {
    private val MONTHS = mapOf(
        "January" to 1, "February" to 2, "March" to 3, "April" to 4, "May" to 5, "June" to 6, "July" to 7,
        "August" to 8, "September" to 9, "October" to 10, "November" to 11, "December" to 12,
        "Januar" to 1, "Februar" to 2, "März" to 3, "Mai" to 5, "Juni" to 6, "Juli" to 7, "Oktober" to 10,
        "Dezember" to 12, "Sept" to 9, "Jan" to 1, "Feb" to 2, "Mar" to 3, "Mär" to 3, "Apr" to 4, "Jun" to 6,
        "Jul" to 7, "Aug" to 8, "Sep" to 9, "Oct" to 10, "Okt" to 10, "Nov" to 11, "Dec" to 12, "Dez" to 12, "Jän" to 1,
    )
    private val MONTH = MONTHS.keys.sortedByDescending { it.length }.joinToString("|")
    private const val HEX = "[0-9A-Fa-f]{1,4}"

    private fun interface Accept { fun accept(text: String, start: Int, end: Int): IntRange? }

    private val rules: List<Triple<PdfRedactionCategory, Regex, Accept>> by lazy {
        listOf(
            Triple(PdfRedactionCategory.IBAN, Regex("[A-Z]{2}[0-9]{2}(?: ?[A-Z0-9]){11,30}"), Accept(::iban)),
            Triple(PdfRedactionCategory.EMAIL, Regex("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}"), Accept(::email)),
            Triple(PdfRedactionCategory.PHONE, Regex("\\+[0-9]{1,3}(?:[ .\\-/]?\\(?[0-9]{1,4}\\)?){2,6}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PHONE, Regex("\\(?[0-9]{3}\\)?[ .-]?[0-9]{3}[ .-][0-9]{4}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PHONE, Regex("0[0-9]{2,4}(?:[ /-]?[0-9]{2,8}){1,3}"), Accept(::phone)),
            Triple(PdfRedactionCategory.PAYMENT_CARD, Regex("[0-9](?:[ -]?[0-9]){12,18}"), Accept(::card)),
            Triple(PdfRedactionCategory.DATE, Regex("[0-9]{4}-[0-9]{2}-[0-9]{2}|[0-9]{1,2}\\.[0-9]{1,2}\\.(?:[0-9]{4}|[0-9]{2})|[0-9]{1,2}/[0-9]{1,2}/[0-9]{4}"), Accept(::date)),
            Triple(PdfRedactionCategory.DATE, Regex("[0-9]{1,2}\\.? (?:$MONTH)\\.? [0-9]{4}|(?:$MONTH)\\.? [0-9]{1,2},? [0-9]{4}"), Accept(::date)),
            Triple(PdfRedactionCategory.URL, Regex("https?://[^\\s<>\"]+|www\\.[A-Za-z0-9-]+(?:\\.[A-Za-z0-9-]+)+(?:/[^\\s<>\"]*)?"), Accept(::url)),
            Triple(PdfRedactionCategory.IP_ADDRESS, Regex("(?:[0-9]{1,3}\\.){3}[0-9]{1,3}"), Accept(::ip)),
            Triple(PdfRedactionCategory.IP_ADDRESS, Regex("(?:$HEX:){7}$HEX|(?:$HEX:){1,7}:(?:$HEX(?::$HEX){0,6})?|::$HEX(?::$HEX){0,6}"), Accept(::ip)),
        )
    }

    fun find(text: String, categories: Set<PdfRedactionCategory>? = null): List<PatternMatch> {
        val candidates = mutableListOf<PatternMatch>()
        for ((category, regex, accept) in rules) {
            if (categories != null && category !in categories) continue
            var from = 0
            while (from < text.length) {
                val match = regex.find(text, from) ?: break
                accept.accept(text, match.range.first, match.range.last + 1)?.let {
                    candidates += PatternMatch(category, it.first, it.last + 1)
                }
                // A rejected match may hide a valid one starting one character later.
                from = match.range.first + 1
            }
        }
        val order = { c: PdfRedactionCategory -> PdfRedactionCategory.PATTERNS.indexOf(c) }
        candidates.sortWith(compareByDescending<PatternMatch> { it.end - it.start }
            .thenBy { order(it.category) }.thenBy { it.start })
        val chosen = mutableListOf<PatternMatch>()
        for (c in candidates) if (chosen.none { c.start < it.end && it.start < c.end }) chosen += c
        return chosen.sortedBy { it.start }
    }

    private fun isWord(text: String, i: Int) = i in text.indices && text[i].isLetterOrDigit()
    private fun charAt(text: String, i: Int) = text.getOrNull(i)
    private fun continuesBefore(text: String, start: Int) =
        Regex("[0-9][ .\\-/]$").containsMatchIn(text.substring(maxOf(0, start - 2), start))
    private fun continuesAfter(text: String, end: Int) =
        Regex("^[ .\\-/][0-9]").containsMatchIn(text.substring(end, minOf(text.length, end + 2)))

    private fun mod97(iban: String): Int {
        var remainder = 0
        for (ch in iban.substring(4) + iban.substring(0, 4)) {
            val value = if (ch.isLetter()) (ch.code - 55).toString() else ch.toString()
            for (digit in value) remainder = (remainder * 10 + (digit - '0')) % 97
        }
        return remainder
    }

    private fun luhn(digits: List<Int>): Boolean = digits.reversed().mapIndexed { i, d ->
        if (i % 2 == 1) (d * 2).let { if (it > 9) it - 9 else it } else d
    }.sum() % 10 == 0

    private fun validDate(year: Int, month: Int, day: Int): Boolean {
        if (month !in 1..12 || day < 1) return false
        val leap = (year % 4 == 0 && year % 100 != 0) || year % 400 == 0
        return day <= intArrayOf(31, if (leap) 29 else 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)[month - 1]
    }

    private fun iban(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1)) return null
        val positions = (start until end).filter { text[it] in 'A'..'Z' || text[it] in '0'..'9' }
        for (k in minOf(34, positions.size) downTo 15) {
            val stop = positions[k - 1] + 1
            if (isWord(text, stop)) continue
            if (mod97(positions.take(k).map { text[it] }.joinToString("")) == 1) return start until stop
        }
        return null
    }

    private fun email(text: String, start: Int, end: Int): IntRange? {
        val before = charAt(text, start - 1)
        return if (before != null && (before.isLetterOrDigit() || before in "._%+-") || isWord(text, end)) null else start until end
    }

    private fun phone(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || charAt(text, start - 1) == '+' || isWord(text, end)) return null
        if (continuesBefore(text, start) || continuesAfter(text, end)) return null
        return if (text.substring(start, end).count { it.isDigit() } in 7..15) start until end else null
    }

    private fun card(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || isWord(text, end)) return null
        if (continuesBefore(text, start) || continuesAfter(text, end)) return null
        val digits = text.substring(start, end).filter { it.isDigit() }.map { it - '0' }
        return if (digits.size in 13..19 && luhn(digits)) start until end else null
    }

    private fun date(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1) || isWord(text, end) || continuesAfter(text, end)) return null
        val s = text.substring(start, end)
        val ok = Regex("^([0-9]{4})-([0-9]{2})-([0-9]{2})$").find(s)?.destructured?.let { (y, m, d) -> validDate(y.toInt(), m.toInt(), d.toInt()) }
            ?: Regex("^([0-9]{1,2})\\.([0-9]{1,2})\\.([0-9]{2}|[0-9]{4})$").find(s)?.destructured?.let { (d, m, y) ->
                validDate(if (y.length == 2) 2000 + y.toInt() else y.toInt(), m.toInt(), d.toInt()) }
            ?: Regex("^([0-9]{1,2})/([0-9]{1,2})/([0-9]{4})$").find(s)?.destructured?.let { (a, b, y) ->
                validDate(y.toInt(), a.toInt(), b.toInt()) || validDate(y.toInt(), b.toInt(), a.toInt()) }
            ?: Regex("^([0-9]{1,2})\\.? ($MONTH)\\.? ([0-9]{4})$").find(s)?.destructured?.let { (d, m, y) -> validDate(y.toInt(), MONTHS.getValue(m), d.toInt()) }
            ?: Regex("^($MONTH)\\.? ([0-9]{1,2}),? ([0-9]{4})$").find(s)?.destructured?.let { (m, d, y) -> validDate(y.toInt(), MONTHS.getValue(m), d.toInt()) }
            ?: false
        return if (ok) start until end else null
    }

    private fun url(text: String, start: Int, end: Int): IntRange? {
        if (isWord(text, start - 1)) return null
        var stop = end
        while (stop > start && text[stop - 1] in ".,;:)") stop--
        return if (stop - start >= 8) start until stop else null
    }

    private fun ip(text: String, start: Int, end: Int): IntRange? {
        val s = text.substring(start, end)
        if (':' in s) {
            if (isWord(text, start - 1) || charAt(text, start - 1) == ':' || isWord(text, end) || charAt(text, end) == ':') return null
            val groups = s.split(':').filter { it.isNotEmpty() }
            return if (groups.size <= 8 && ("::" in s || groups.size == 8)) start until end else null
        }
        if (isWord(text, start - 1) || charAt(text, start - 1) == '.' || isWord(text, end) || continuesAfter(text, end)) return null
        return if (s.split('.').all { it.toInt() <= 255 }) start until end else null
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `cd android && gradle :pdfcora-ai:testDebugUnitTest --tests '*PatternsTest' --console=plain -q; echo exit=$?`
Expected: `exit=0`. On a mismatch, compare with the web output for the same text.

- [ ] **Step 5: Commit**

```bash
git add android/pdfcora-ai
git commit -m "Android AI: redaction patterns, matching the shared cases"
```

---
### Task 12: Android core — snapshots and viewer marks

**Files:**
- Create: `android/pdfcora/src/main/java/com/pdfcora/Snapshot.kt`, `android/pdfcora/src/main/java/com/pdfcora/view/Marks.kt`, `android/pdfcora/src/androidTest/java/com/pdfcora/SnapshotAndMarksTest.kt`
- Modify: `android/pdfcora/src/main/java/com/pdfcora/PdfDocument.kt` (`needsWatermark` setter `internal`), `android/pdfcora/src/main/java/com/pdfcora/view/Viewer.kt` (marks)

**Interfaces:**
- Produces: `suspend fun PdfDocument.snapshot(): PdfDocumentSnapshot`; `class PdfDocumentSnapshot { suspend fun open(): PdfDocument }`; `enum class PdfMarkState { PENDING, ACCEPTED, REJECTED }`; `data class PdfMark(val id: String, val pageIndex: Int, val rects: List<PdfRect>, val state: PdfMarkState = PdfMarkState.PENDING)`; on `PdfViewer`: `val marks: List<PdfMark>`, `fun setMarks(marks: List<PdfMark>)`, `fun setAllMarks(state: PdfMarkState)`, `fun markAt(page: Int, point: PdfPoint): String?`, `fun tapMark(page: Int, point: PdfPoint): String?`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.license.PdfLicense
import com.pdfcora.view.*
import kotlinx.coroutines.flow.launchIn
import kotlinx.coroutines.flow.onEach
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancel
import org.junit.After
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class SnapshotAndMarksTest {
    @After fun restore() = LicenseFixture.installFullKey()
    private fun corpus(name: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open("corpus/$name").use { it.readBytes() }

    @Test fun aSnapshotReopensTheDocumentAsItWas() = runBlocking {
        val document = PdfDocument.open(corpus("hello_world.pdf"))
        document.page(0).addNote(PdfRect(10f, 10f, 30f, 30f), "kept")
        val snapshot = document.snapshot()
        document.redact(listOf(PdfRedactionTarget.TextMatches("Hello")))
        val copy = snapshot.open()
        assertTrue(copy.page(0).text.string().contains("Hello"))
        assertEquals(1, copy.page(0).annotations().size)
    }

    @Test fun aSnapshotOfAWatermarkedDocumentReopensWatermarked() = runBlocking {
        PdfLicense.configureForTesting(key = null, setKey = true)
        val copy = PdfDocument.open(corpus("hello_world.pdf")).snapshot().open()
        assertTrue(copy.needsWatermark)
        val text = PdfDocument.open(copy.toByteArray()).page(0).text.string()
        assertEquals(1, text.split("PDFCora trial").size - 1)
    }

    private suspend fun viewer() = PdfViewer.open(PdfDocument.open(corpus("hello_world.pdf")), PdfViewport(400f, 600f))

    @Test fun marksAreHitTestedAndTapsCycle() = runBlocking {
        val v = viewer()
        v.setMarks(listOf(PdfMark("a", 0, listOf(PdfRect(10f, 10f, 100f, 40f))), PdfMark("b", 0, listOf(PdfRect(50f, 20f, 80f, 30f)))))
        assertEquals("b", v.markAt(0, PdfPoint(60f, 25f)))
        assertNull(v.markAt(1, PdfPoint(20f, 15f)))
        val states = (0 until 3).map { v.tapMark(0, PdfPoint(20f, 15f)); v.marks[0].state }
        assertEquals(listOf(PdfMarkState.ACCEPTED, PdfMarkState.REJECTED, PdfMarkState.PENDING), states)
        v.setAllMarks(PdfMarkState.ACCEPTED)
        assertEquals(listOf(PdfMarkState.ACCEPTED, PdfMarkState.ACCEPTED), v.marks.map { it.state })
    }

    @Test fun marksNeverReachTheEventStream() = runBlocking {
        val v = viewer()
        var events = 0
        val scope = CoroutineScope(Dispatchers.Default)
        v.events.onEach { events++ }.launchIn(scope)
        v.setMarks(listOf(PdfMark("a", 0, listOf(PdfRect(10f, 10f, 100f, 40f)))))
        v.tapMark(0, PdfPoint(20f, 20f))
        v.setAllMarks(PdfMarkState.REJECTED)
        v.flush()
        kotlinx.coroutines.delay(100)
        scope.cancel()
        assertEquals(0, events)
    }
}
```

Match `PdfViewport`'s constructor and `PdfRedactionTarget.TextMatches` to the real code.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfcora:compileDebugAndroidTestKotlin --console=plain -q 2>&1 | grep "^e:" | head -2`
Expected: `Unresolved reference: snapshot`.

- [ ] **Step 3: Implement**

`PdfDocument.kt`: change `private set` on `needsWatermark` to `internal set`.

`Snapshot.kt`:
```kotlin
package com.pdfcora

/**
 * A document as it was when [PdfDocument.snapshot] was called.
 *
 * The bytes are never exposed: they are not watermarked, and handing them out would be a
 * way round the license. The reopened document needs the watermark if the original did.
 */
class PdfDocumentSnapshot internal constructor(
    private val bytes: ByteArray,
    private val needsWatermark: Boolean,
) {
    /** Opens a new document from the snapshot. Each call opens another. */
    suspend fun open(): PdfDocument = PdfDocument.open(bytes).also { if (needsWatermark) it.needsWatermark = true }
}

/**
 * A copy of the document as it is now, to reopen later — for undoing a change that cannot
 * be undone in place, such as a redaction.
 */
suspend fun PdfDocument.snapshot(): PdfDocumentSnapshot {
    val marked = needsWatermark
    val bytes = onDocument { Native.saveDocument(it, PdfSaveMode.FULL.flag) }
    if (bytes.isEmpty()) throw PdfError.SaveFailed("no bytes were produced")
    return PdfDocumentSnapshot(bytes, marked)
}
```

`view/Marks.kt`:
```kotlin
package com.pdfcora.view

import com.pdfcora.PdfRect

enum class PdfMarkState { PENDING, ACCEPTED, REJECTED }

/** A reviewable region drawn over a page, such as a redaction suggestion. */
data class PdfMark(
    val id: String,
    val pageIndex: Int,
    val rects: List<PdfRect>,
    val state: PdfMarkState = PdfMarkState.PENDING,
)
```

`view/Viewer.kt`, in the class body:
```kotlin
    // MARK: - Marks
    //
    // Local to this viewer: none of these emit an event, so a sync transport never carries a
    // review, and none touch the document.

    @Volatile var marks: List<PdfMark> = emptyList()
        private set

    fun setMarks(marks: List<PdfMark>) { this.marks = marks.toList() }

    fun setAllMarks(state: PdfMarkState) { marks = marks.map { it.copy(state = state) } }

    /** The id of the topmost mark under a point on a page — the last one set — or null. */
    fun markAt(page: Int, point: PdfPoint): String? =
        marks.lastOrNull { mark -> mark.pageIndex == page && mark.rects.any { it.contains(point) } }?.id

    /** Cycles the tapped mark PENDING → ACCEPTED → REJECTED → PENDING. Returns its id, or null. */
    fun tapMark(page: Int, point: PdfPoint): String? {
        val id = markAt(page, point) ?: return null
        marks = marks.map { mark ->
            if (mark.id != id) mark else mark.copy(state = when (mark.state) {
                PdfMarkState.PENDING -> PdfMarkState.ACCEPTED
                PdfMarkState.ACCEPTED -> PdfMarkState.REJECTED
                PdfMarkState.REJECTED -> PdfMarkState.PENDING
            })
        }
        return id
    }
```
Import `com.pdfcora.contains` if `PdfRect.contains` is not visible (it is a top-level extension in `Types.kt`).

- [ ] **Step 4: Run the test**

Run: `cd android && gradle :pdfcora:connectedDebugAndroidTest -Pandroid.testInstrumentationRunnerArguments.class=com.pdfcora.SnapshotAndMarksTest --console=plain -q; echo exit=$?`
Expected: `exit=0`, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add android/pdfcora
git commit -m "Android: document snapshots and viewer marks"
```

---
### Task 13: Android AI — suggest, apply and undo

**Files:**
- Create: `android/pdfcora-ai/src/main/java/com/pdfcora/ai/redaction/Suggest.kt`, `android/pdfcora-ai/src/androidTest/java/com/pdfcora/ai/RedactionSuggestTest.kt`
- Modify: `android/pdfcora-ai/src/main/java/com/pdfcora/ai/PdfAI.kt` (add `redactions`), `android/pdfcora-ai/build.gradle.kts` (androidTest assets include `conformance/redaction`)

**Interfaces:**
- Consumes: `Patterns.find` (Task 11); `PdfDocument.snapshot()` (Task 12); existing `TextLayer.readPages`, `TextLayer.sentencesOf`, `TextLayer.rects`, `locateQuote`, `resolveRoutes`, `Trial`.
- Produces: `data class PdfRedactionSuggestion(val id: String, val category: PdfRedactionCategory, val source: PdfAiSource, val pageIndex: Int, val start: Int, val end: Int, val text: String, val rects: List<PdfRect>)`; `class PdfRedactionReview { val suggestions; val modelUsed; val notice; val pagesWithoutText; suspend fun apply(accepting: List<String>): PdfRedactionApplied }`; `class PdfRedactionApplied { val report; val remaining; suspend fun undo(): PdfDocument }`; `class UnknownSuggestionException(id: String)`; `PdfAI.redactions.suggest(pages: IntRange? = null, categories: Set<PdfRedactionCategory>? = null): PdfRedactionReview`.

- [ ] **Step 1: Write the failing test**

```kotlin
package com.pdfcora.ai

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.pdfcora.PdfDocument
import com.pdfcora.PdfSaveMode
import com.pdfcora.ai.redaction.PdfRedactionCategory
import com.pdfcora.ai.redaction.UnknownSuggestionException
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

@RunWith(AndroidJUnit4::class)
class RedactionSuggestTest {
    private val assets get() = InstrumentationRegistry.getInstrumentation().context.assets
    private suspend fun pii() = PdfDocument.open(assets.open("pii.pdf").use { it.readBytes() })
    private fun items(vararg pairs: Pair<String, String>) = PdfAiProvider {
        PdfAiResponse(text = "", structured = JSONObject().put("items", JSONArray().apply {
            pairs.forEach { (c, q) -> put(JSONObject().put("category", c).put("quote", q)) }
        }).toString())
    }

    @Test fun patternsAloneFindExactlyTheExpectedItems() = runBlocking {
        val expected = JSONArray(assets.open("pii-expected.json").use { it.readBytes().decodeToString() })
            .let { a -> (0 until a.length()).map { a.getJSONObject(it).run { Triple(getInt("pageIndex"), getString("category"), getString("text")) } } }
        val review = PdfAI(pii()).redactions.suggest()
        assertFalse(review.modelUsed)
        assertTrue(review.notice.contains("Suggestions may be incomplete. Review the whole document."))
        assertEquals(expected, review.suggestions.map { Triple(it.pageIndex, it.category.id, it.text) })
        review.suggestions.forEach {
            assertEquals(PdfAiSource.RULES, it.source)
            assertEquals("${it.pageIndex}:${it.start}-${it.end}:${it.category.id}", it.id)
            assertTrue(it.text, it.rects.isNotEmpty())
        }
    }

    @Test fun modelQuotesAreVerifiedExpandedAndNeverOverlapAPattern() = runBlocking {
        val provider = items("personName" to "Anna Schmidt", "personName" to "Nobody Invented",
            "dateOfBirth" to "14 March 1985", "idNumber" to "Li", "bankBalance" to "Customer record")
        val review = PdfAI(pii(), PdfAIOptions(provider)).redactions.suggest(pages = 0..0)
        assertTrue(review.modelUsed)
        assertEquals(listOf("personName" to "Anna Schmidt", "personName" to "Anna Schmidt"),
            review.suggestions.filter { it.source == PdfAiSource.CUSTOM_PROVIDER }.map { it.category.id to it.text })
    }

    @Test fun aFailingModelLeavesThePatterns() = runBlocking {
        val review = PdfAI(pii(), PdfAIOptions(PdfAiProvider { throw java.io.IOException("offline") })).redactions.suggest()
        assertFalse(review.modelUsed)
        assertEquals(25, review.suggestions.size)
    }

    @Test fun applyRemovesAcceptedTextKeepsRejectedAndUndoRestores() = runBlocking {
        val document = pii()
        val review = PdfAI(document).redactions.suggest(pages = 0..0)
        val email = review.suggestions.first { it.category == PdfRedactionCategory.EMAIL }
        val iban = review.suggestions.first { it.category == PdfRedactionCategory.IBAN }
        val applied = review.apply(listOf(email.id))
        assertEquals(emptyList<Any>(), applied.remaining)
        val text = PdfDocument.open(document.toByteArray(PdfSaveMode.FULL)).page(0).text.string()
        assertFalse(text.contains(email.text))
        assertTrue(text.contains(iban.text))
        assertTrue(text.contains("Email"))
        assertTrue(applied.undo().page(0).text.string().contains(email.text))
    }

    @Test fun anUnknownIdWritesNothing() = runBlocking {
        val document = pii()
        val review = PdfAI(document).redactions.suggest()
        val first = review.suggestions[0]
        assertThrows(UnknownSuggestionException::class.java) { runBlocking { review.apply(listOf(first.id, "nope")) } }
        assertTrue(document.page(0).text.string().contains(first.text))
    }
}
```

In `android/pdfcora-ai/build.gradle.kts`, add the fixture directory to the androidTest assets next to the one holding `contract.pdf` (`grep -n assets android/pdfcora-ai/build.gradle.kts`): `rootProject.projectDir.parentFile.resolve("conformance/redaction")`. Match `PdfAiResponse`'s constructor and how `structured` is typed to `AnswersTest`'s `Model`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfcora-ai:compileDebugAndroidTestKotlin --console=plain -q 2>&1 | grep "^e:" | head -2`
Expected: `Unresolved reference: redactions`.

- [ ] **Step 3: Implement `Suggest.kt`**

```kotlin
package com.pdfcora.ai.redaction

import com.pdfcora.PdfDocument
import com.pdfcora.PdfDocumentSnapshot
import com.pdfcora.PdfRect
import com.pdfcora.PdfRedactionReport
import com.pdfcora.PdfRedactionTarget
import com.pdfcora.ai.*
import com.pdfcora.redact
import com.pdfcora.snapshot
import org.json.JSONObject

const val REDACTION_NOTICE = "Suggestions may be incomplete. Review the whole document."

data class PdfRedactionSuggestion(
    val id: String,
    val category: PdfRedactionCategory,
    val source: PdfAiSource,
    val pageIndex: Int,
    val start: Int,
    val end: Int,
    val text: String,
    val rects: List<PdfRect>,
)

class UnknownSuggestionException(id: String) : IllegalArgumentException("unknown suggestion: $id")

class PdfRedactionApplied internal constructor(
    val report: PdfRedactionReport,
    /** Accepted suggestions whose text is still on the page. Empty unless something went wrong. */
    val remaining: List<PdfRedactionSuggestion>,
    private val snapshot: PdfDocumentSnapshot,
) {
    /** Reopens the document as it was before apply. The host shows it and closes the redacted one. */
    suspend fun undo(): PdfDocument = snapshot.open()
}

class PdfRedactionReview internal constructor(
    val suggestions: List<PdfRedactionSuggestion>,
    /** False when no model answered, so only patterns ran. */
    val modelUsed: Boolean,
    /** Must be shown with the suggestions (RED-4). */
    val notice: String,
    val pagesWithoutText: List<Int>,
    private val document: PdfDocument,
    private val textBefore: Map<Int, String>,
) {
    suspend fun apply(accepting: List<String>): PdfRedactionApplied {
        val known = suggestions.map { it.id }.toSet()
        accepting.firstOrNull { it !in known }?.let { throw UnknownSuggestionException(it) }
        val accepted = suggestions.filter { it.id in accepting }

        val snapshot = document.snapshot()
        val report = document.redact(accepted.flatMap { s -> s.rects.map { PdfRedactionTarget.Region(it, s.pageIndex) } })

        // Offsets move once text is removed, so count occurrences instead.
        val remaining = mutableListOf<PdfRedactionSuggestion>()
        for (pageIndex in accepted.map { it.pageIndex }.toSet()) {
            val after = document.page(pageIndex).text.string()
            val before = textBefore.getValue(pageIndex)
            val onPage = accepted.filter { it.pageIndex == pageIndex }
            for (text in onPage.map { it.text }.toSet()) {
                val same = onPage.filter { it.text == text }
                if (RedactionSuggester.occurrences(text, after).size > RedactionSuggester.occurrences(text, before).size - same.size) {
                    remaining += same
                }
            }
        }
        return PdfRedactionApplied(report, remaining, snapshot)
    }
}

internal object RedactionSuggester {
    data class Item(val category: PdfRedactionCategory, val quote: String)

    fun prompt(text: String) = listOf(
        "Find personal data in the text below.",
        "Categories: personName (the name of a person, not a company), postalAddress (a street address with a postal code or city),",
        "dateOfBirth (a date the text says is a birth date), idNumber (a passport, national ID, social security or tax number).",
        "Copy each quote exactly as it appears in the text. Reply with JSON: {\"items\": [{\"category\": \"...\", \"quote\": \"...\"}]}.",
        "Reply with {\"items\": []} when there is none.",
        "",
        text,
    ).joinToString("\n")

    const val SCHEMA = """{"type":"object","properties":{"items":{"type":"array","items":{"type":"object","properties":{"category":{"type":"string","enum":["personName","postalAddress","dateOfBirth","idNumber"]},"quote":{"type":"string"}},"required":["category","quote"]}}},"required":["items"]}"""

    fun occurrences(quote: String, text: String): List<IntRange> {
        val found = mutableListOf<IntRange>()
        var offset = 0
        while (offset < text.length) {
            val at = locateQuote(text.substring(offset), quote) ?: break
            found += (offset + at.first)..(offset + at.last)
            offset += at.last + 1
        }
        return found
    }

    fun chunks(pages: List<PdfPageText>, limit: Int): List<String> {
        val chunks = mutableListOf<String>()
        for (page in pages) {
            var current = ""
            for (sentence in TextLayer.sentencesOf(page.text)) {
                val piece = page.text.substring(sentence.first, sentence.last + 1)
                if (current.isNotEmpty() && current.length + piece.length + 1 > limit) { chunks += current; current = "" }
                current = if (current.isEmpty()) piece.take(limit) else "$current $piece"
            }
            if (current.isNotEmpty()) chunks += current
        }
        return chunks
    }

    fun verified(reply: String, chunk: String, wanted: Set<PdfRedactionCategory>): List<Item> {
        val from = reply.indexOf('{')
        val to = reply.lastIndexOf('}')
        if (from < 0 || to <= from) return emptyList()
        val items = try { JSONObject(reply.substring(from, to + 1)).optJSONArray("items") } catch (e: Exception) { null } ?: return emptyList()
        return (0 until items.length()).mapNotNull { i ->
            val item = items.optJSONObject(i) ?: return@mapNotNull null
            val category = PdfRedactionCategory.MODEL.firstOrNull { it.id == item.optString("category") } ?: return@mapNotNull null
            val quote = item.optString("quote")
            if (category !in wanted || quote.trim().length < 3 || locateQuote(chunk, quote) == null) null else Item(category, quote)
        }
    }
}

suspend fun suggestRedactions(ai: PdfAI, pages: IntRange?, categories: Set<PdfRedactionCategory>?): PdfRedactionReview {
    val wanted = categories ?: PdfRedactionCategory.values().toSet()
    val document = ai.document
    val (pageTexts, pagesWithoutText) = TextLayer.readPages(document, pages)

    data class Found(val category: PdfRedactionCategory, val source: PdfAiSource, val pageIndex: Int, val start: Int, val end: Int)
    val found = mutableListOf<Found>()
    for (page in pageTexts) {
        Patterns.find(page.text, wanted.intersect(PdfRedactionCategory.PATTERNS.toSet())).forEach {
            found += Found(it.category, PdfAiSource.RULES, page.pageIndex, it.start, it.end)
        }
    }

    var modelUsed = false
    val modelWanted = wanted.intersect(PdfRedactionCategory.MODEL.toSet())
    val provider = ai.options.provider
    if (modelWanted.isNotEmpty() && provider != null) {
        val limit = (ai.options.providerContextTokens * GroundedAnswers.CHARS_PER_TOKEN * 0.6).toInt()
        val outcome = resolveRoutes(customProvider = {
            RedactionSuggester.chunks(pageTexts, limit).flatMap { chunk ->
                val response = provider.generate(PdfAiRequest(RedactionSuggester.prompt(chunk), schema = RedactionSuggester.SCHEMA))
                RedactionSuggester.verified(response.structured?.toString() ?: response.text, chunk, modelWanted)
            }
        })
        if (outcome is PdfAiOutcome.Answered) {
            modelUsed = true
            for (item in outcome.result.value) for (page in pageTexts) {
                RedactionSuggester.occurrences(item.quote, page.text).forEach {
                    found += Found(item.category, outcome.result.source, page.pageIndex, it.first, it.last + 1)
                }
            }
        }
    }

    // Patterns are deterministic, so a model suggestion that overlaps one is dropped.
    val kept = found.filter { s ->
        s.source == PdfAiSource.RULES || found.none { it.source == PdfAiSource.RULES && it.pageIndex == s.pageIndex && s.start < it.end && it.start < s.end }
    }
    val textBefore = pageTexts.associate { it.pageIndex to it.text }
    val suggestions = kept.sortedWith(compareBy({ it.pageIndex }, { it.start }))
        .distinctBy { "${it.pageIndex}:${it.start}-${it.end}:${it.category.id}" }
        .map {
            PdfRedactionSuggestion("${it.pageIndex}:${it.start}-${it.end}:${it.category.id}", it.category, it.source,
                it.pageIndex, it.start, it.end, textBefore.getValue(it.pageIndex).substring(it.start, it.end),
                TextLayer.rects(document, it.pageIndex, it.start, it.end))
        }
    return PdfRedactionReview(suggestions, modelUsed, Trial.text(REDACTION_NOTICE), pagesWithoutText, document, textBefore)
}
```

In `PdfAI.kt` add:
```kotlin
    /**
     * Suggests likely personal data to redact (RED). Patterns run on every device; the custom
     * provider, when configured, adds names, addresses, dates of birth and ID numbers.
     * Nothing is written until apply.
     */
    val redactions = Redactions()

    inner class Redactions {
        suspend fun suggest(pages: IntRange? = null, categories: Set<PdfRedactionCategory>? = null): PdfRedactionReview =
            suggestRedactions(this@PdfAI, pages, categories)
    }
```
with imports for `com.pdfcora.ai.redaction.*`.

In `Trial.kt` add:
```kotlin
    /** SDK text shown without an `ai` license gets the same prefix as model output. */
    fun text(value: String, licensed: Boolean = licensedNow()): String = if (licensed) value else PREFIX + value
```

Match to the real code before building: `PdfPageText`'s properties, `PdfAiRequest`'s constructor (`prompt`, `schema`) and `PdfAiResponse.structured`'s type, and `TextLayer.sentencesOf` returning `List<IntRange>` (inclusive).

This module's instrumented tests run without a license key, so the notice carries the trial prefix; the test checks `contains`, which allows it.

- [ ] **Step 4: Run the tests**

Run: `cd android && gradle :pdfcora-ai:connectedDebugAndroidTest :pdfcora-ai:testDebugUnitTest --console=plain -q; echo exit=$?`
Expected: `exit=0`; AnswersTest 10 + RedactionSuggestTest 5 on the device.

- [ ] **Step 5: Commit**

```bash
git add android/pdfcora-ai
git commit -m "Android AI: redaction suggestions from patterns and a provider, with apply and undo"
```

---
### Task 14: Android UI — marks overlay and review bar

**Files:**
- Modify: `android/pdfcora-ui/src/main/java/com/pdfcora/ui/PdfViewerView.kt`
- Create: `android/pdfcora-ui/src/main/java/com/pdfcora/ui/Review.kt`
- Test: `android/pdfcora-ui/src/androidTest/java/com/pdfcora/ui/PdfViewerViewTest.kt`

**Interfaces:**
- Consumes: viewer marks (Task 12).
- Produces: `class PdfReviewConfiguration(val marks: List<PdfMark>, val notice: String, val applyLabel: String = "Apply", val onApply: (List<String>) -> Unit, val onCancel: (() -> Unit)? = null)`; `PdfViewerView(document, modifier, toolbar, theme, review: PdfReviewConfiguration? = null, onSave)`. Content descriptions: `review-notice`, `review-counts`, `review-accept-all`, `review-reject-all`, `review-apply`, `review-cancel`, `mark-<id>`.

- [ ] **Step 1: Write the failing test**

Add to `PdfViewerViewTest`:
```kotlin
    /** Review mode: a mark over the page, tapped once to accept, then applied. */
    @Test
    fun aTappedMarkIsAcceptedAndApplyHandsOverItsId() {
        val document = document()
        var applied: List<String>? = null
        compose.setContent {
            PdfViewerView(document, Modifier.fillMaxSize(), review = PdfReviewConfiguration(
                marks = listOf(PdfMark("m1", 0, listOf(PdfRect(0f, 0f, 612f, 792f)))),
                notice = "Suggestions may be incomplete. Review the whole document.",
                onApply = { applied = it },
            ))
        }
        waitForPage()
        compose.onNodeWithContentDescription("review-notice").assertIsDisplayed()
        compose.onNodeWithContentDescription("mark-m1").performClick()
        compose.waitUntil(5_000) {
            compose.onAllNodesWithText("1 accepted", substring = true).fetchSemanticsNodes().isNotEmpty()
        }
        compose.onNodeWithContentDescription("review-apply").performClick()
        compose.waitUntil(5_000) { applied != null }
        assertEquals(listOf("m1"), applied)
        document.close()
    }
```
Imports: `com.pdfcora.PdfRect`, `com.pdfcora.view.PdfMark`, `androidx.compose.ui.test.performClick`, `org.junit.Assert.assertEquals`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd android && gradle :pdfcora-ui:compileDebugAndroidTestKotlin --console=plain -q 2>&1 | grep "^e:" | head -2`
Expected: `Unresolved reference: PdfReviewConfiguration`.

- [ ] **Step 3: Implement**

`Review.kt`:
```kotlin
package com.pdfcora.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.*
import androidx.compose.material3.*
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import com.pdfcora.view.PdfMark
import com.pdfcora.view.PdfMarkState

/**
 * Puts the viewer in review mode: marks over the page that a tap cycles, and a bar that
 * always shows [notice]. The component does not apply anything; [onApply] does.
 */
class PdfReviewConfiguration(
    val marks: List<PdfMark>,
    val notice: String,
    val applyLabel: String = "Apply",
    val onApply: (List<String>) -> Unit,
    val onCancel: (() -> Unit)? = null,
)

@Composable
internal fun PdfReviewBar(
    configuration: PdfReviewConfiguration,
    marks: List<PdfMark>,
    theme: PdfViewerTheme,
    setAll: (PdfMarkState) -> Unit,
) {
    Column(Modifier.fillMaxWidth().background(theme.toolbarBackground).padding(8.dp)) {
        Text(configuration.notice, style = MaterialTheme.typography.bodySmall,
             modifier = Modifier.semantics { contentDescription = "review-notice" })
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(4.dp)) {
            val accepted = marks.count { it.state == PdfMarkState.ACCEPTED }
            val pending = marks.count { it.state == PdfMarkState.PENDING }
            Text("$accepted accepted · $pending pending", style = MaterialTheme.typography.bodySmall,
                 modifier = Modifier.weight(1f).semantics { contentDescription = "review-counts" })
            TextButton({ setAll(PdfMarkState.ACCEPTED) }, Modifier.semantics { contentDescription = "review-accept-all" }) { Text("Accept all") }
            TextButton({ setAll(PdfMarkState.REJECTED) }, Modifier.semantics { contentDescription = "review-reject-all" }) { Text("Reject all") }
            TextButton({ configuration.onApply(marks.filter { it.state == PdfMarkState.ACCEPTED }.map { it.id }) },
                       Modifier.semantics { contentDescription = "review-apply" }) { Text(configuration.applyLabel) }
            configuration.onCancel?.let { cancel ->
                TextButton(cancel, Modifier.semantics { contentDescription = "review-cancel" }) { Text("Cancel") }
            }
        }
    }
}
```
The counts `Text` has a content description, which replaces its text for `onAllNodesWithText`; if the test's text lookup fails, look the node up by content description and assert on its `Text` semantics instead, or drop the content description from the counts and find it by text.

`PdfViewerView.kt`:
1. Add parameter `review: PdfReviewConfiguration? = null` before `onSave`; add `var marks by remember { mutableStateOf(emptyList<PdfMark>()) }`.
2. In the `LaunchedEffect`, after `viewer = PdfViewer.open(document, port)`: `review?.let { viewer?.setMarks(it.marks); marks = viewer?.marks.orEmpty() }`.
3. Inside the page `Box`, after the `Image`, draw marks for the current page:
```kotlin
                val v = viewer
                if (v != null) {
                    val transform = v.transform()
                    marks.filter { it.pageIndex == v.state.pageIndex }.forEach { mark ->
                        mark.rects.forEach { rect ->
                            val box = transform.toView(rect)
                            val (fill, border) = when (mark.state) {
                                PdfMarkState.PENDING -> Color(0x2EFF9500) to Color(0xFFFF9500)
                                PdfMarkState.ACCEPTED -> theme.redactionFill to Color(0xFF1D1D1F)
                                PdfMarkState.REJECTED -> Color.Transparent to Color(0xFF8E8E93)
                            }
                            Box(Modifier
                                .offset { IntOffset(box.left.toInt(), box.top.toInt()) }
                                .size(with(density) { box.width().toDp() }, with(density) { box.height().toDp() })
                                .background(fill)
                                .border(if (mark.state == PdfMarkState.REJECTED) 1.dp else 2.dp, border)
                                .semantics { contentDescription = "mark-${mark.id}" }
                                .clickable {
                                    v.tapMark(mark.pageIndex, transform.toPdf(box.centerX(), box.centerY()))
                                    marks = v.marks
                                })
                        }
                    }
                }
```
   Imports: `androidx.compose.foundation.border`, `androidx.compose.foundation.clickable`, `androidx.compose.ui.graphics.Color`, `androidx.compose.ui.unit.IntOffset`, `com.pdfcora.view.PdfMark`, `com.pdfcora.view.PdfMarkState`. Check `PdfViewTransform.toPdf`'s signature on Android (x, y floats or a point) and adapt.
4. Below the page `Box` and above `status`: `review?.let { PdfReviewBar(it, marks, theme) { state -> viewer?.setAllMarks(state); marks = viewer?.marks.orEmpty() } }`.
5. While reviewing, ignore drags: at the start of `onDragEnd`'s launch, `if (review != null) return@launch`; and pass `reviewing = review != null` to `PdfToolbar`, disabling `PdfToolbarItem.Tool` items.

- [ ] **Step 4: Run the UI tests**

Run: `cd android && gradle :pdfcora-ui:connectedDebugAndroidTest --console=plain -q; echo exit=$?`
Expected: `exit=0`, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add android/pdfcora-ui
git commit -m "Android: review marks and bar in PdfViewerView"
```

---

### Task 15: Measure Apple's model, document, run every gate

**Files:**
- Create: `ios/Tests/PDFCoraAITests/RedactionMeasurementTests.swift`
- Modify: `docs/superpowers/plans/2026-09-14-phase1-ai-answers-summaries.md` (measurement), `README.md` (feature table row and a short section), `docs/HANDOFF.md`, `docs/superpowers/specs/2026-09-13-pdfcora-ai-requirements.md` (§12 status), the spec's §4.1 (tap cycling lives in the headless viewer)

- [ ] **Step 1: Write the opt-in measurement**

```swift
import XCTest
@testable import PDFCora
@testable import PDFCoraAI

/// How much personal data Apple's on-device model adds on the shared document, per language.
/// Opt-in: `TEST_RUNNER_PDFCORA_MEASURE_APPLE=1` in the environment of `xcodebuild test`.
final class RedactionMeasurementTests: LicensedTestCase {
    func testAppleModelOnThePiiDocument() async throws {
        guard ProcessInfo.processInfo.environment["PDFCORA_MEASURE_APPLE"] == "1" else {
            throw XCTSkip("set TEST_RUNNER_PDFCORA_MEASURE_APPLE=1")
        }
        let url = RedactionPatternTests.root.appendingPathComponent("conformance/redaction/pii.pdf")
        let document = try await PdfDocument(data: try Data(contentsOf: url))
        let wanted: [Int: [(PdfRedactionCategory, String)]] = [
            0: [(.personName, "Anna Schmidt"), (.postalAddress, "221B Baker Street, London NW1 6XE"), (.idNumber, "502135326")],
            1: [(.personName, "Jonas Müller"), (.postalAddress, "Hauptstraße 12, 10115 Berlin"), (.idNumber, "L01X00T47"), (.idNumber, "65929970489")],
        ]
        for page in [0, 1] {
            let started = Date()
            let review = try await PdfAI(document: document).redactions.suggest(pages: page...page, categories: Set(PdfRedactionCategory.model))
            let found = review.suggestions.filter { $0.source == .onDevice }
            let hits = wanted[page]!.filter { want in found.contains { $0.category == want.0 && $0.text.contains(want.1) } }
            print("MEASURE page \(page) \(page == 0 ? "English" : "German"): modelUsed=\(review.modelUsed) found \(hits.count) of \(wanted[page]!.count) in \(String(format: "%.1f", Date().timeIntervalSince(started))) s; suggestions: \(found.map { "\($0.category.rawValue)=\($0.text)" })")
        }
    }
}
```

- [ ] **Step 2: Run it against the Mac's Apple Intelligence**

Run: `TEST_RUNNER_PDFCORA_MEASURE_APPLE=1 ./build/run-ios-tests.sh PDFCoraAITests/RedactionMeasurementTests; grep MEASURE build/ios-selected.log`
Expected: two `MEASURE` lines with `modelUsed=true`. If `modelUsed=false`, the simulator did not reach the model this launch (the first readings after launch report no budget); run it again.

- [ ] **Step 3: Document**

- `2026-09-14-phase1-ai-answers-summaries.md`: under "Measured against a real model", add a "Redaction suggestions with Apple's model" paragraph with the two `MEASURE` results (found n of m, per language, time) and any wrong suggestions it made.
- `README.md` feature table: add `| Redaction suggestions (patterns; model where available), review in the viewer | ✅ | ✅ | ✅ |`, and under License keys' neighbour sections a short "Redaction suggestions" paragraph with the web example from the spec §3.1 and §5.2, stating that suggestions may be incomplete.
- `HANDOFF.md`: a row in §1 and the new test counts.
- Requirements spec §12: "Implemented 2026-09-15 (patterns EN/DE, model on Apple and a custom provider, review marks in the viewer, snapshot undo)", with the measured numbers.
- Redaction spec §4.1: replace the `markTapped` event with `tapMark(pageIndex, point)` on the headless viewer, which cycles the state and emits nothing, so the three components share one tested behaviour.

- [ ] **Step 4: Run every gate**

```bash
(cd web && npm test 2>&1 | LC_ALL=C grep -a "ℹ tests\|ℹ fail")
(cd web-ai && npm test 2>&1 | LC_ALL=C grep -a "ℹ tests\|ℹ fail")
./scripts/test-web-browser.sh 2>&1 | tail -1
./scripts/test-ios.sh 2>&1 | grep -E "Executed [0-9]+ tests|TEST FAILED|cross-check" | tail -8
ANDROID_SERIAL=emulator-5554 ./scripts/test-android.sh 2>&1 | grep -E "Finished [0-9]+ tests|FAILED|cross-check" | tail -8
```
Expected: every suite passes.

- [ ] **Step 5: Commit, push, check CI**

```bash
git add ios/Tests/PDFCoraAITests/RedactionMeasurementTests.swift docs README.md
git commit -m "Redaction suggestions: Apple's model measured, documentation"
```
Push with the user's token as before, then `./build/ci-status.sh $(git rev-parse HEAD) --wait`. Expected: all six workflows pass.
