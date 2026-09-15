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
