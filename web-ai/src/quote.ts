/**
 * Finds a model's quote in the source text and returns its character range there (ANS-3).
 *
 * Tolerates what text extraction legitimately changes — runs of whitespace, line breaks,
 * and words hyphenated across a line — and nothing else. Wording, punctuation and case
 * must match, because a quote that differs in those was not copied, and a highlight built
 * from it would point at text that does not say what the answer claims.
 */
export function locateQuote(source: string, quote: string): { start: number; end: number } | null {
  const needle = normalise(quote, true).text;
  if (needle.length === 0) return null;
  // A hyphen at a line end is either hyphenation ("manage-\nment") or a compound that
  // happens to break there ("well-\nknown"). The text cannot say which, so try both.
  for (const keepHyphen of [false, true]) {
    const haystack = normalise(source, keepHyphen);
    const at = haystack.text.indexOf(needle);
    if (at >= 0) return { start: haystack.origin[at]!, end: haystack.origin[at + needle.length - 1]! + 1 };
  }
  return null;
}

/**
 * Collapses whitespace to single spaces and joins words split by a hyphen at a line end,
 * remembering where each kept character came from.
 */
function normalise(text: string, keepHyphen: boolean): { text: string; origin: number[] } {
  let out = '';
  const origin: number[] = [];
  let i = 0;
  while (i < text.length) {
    const c = text[i]!;
    if (c === '­') { i++; continue; }
    if (c === '-' && /\p{L}/u.test(out[out.length - 1] ?? '')) {
      let j = i + 1;
      while (j < text.length && /[ \t]/.test(text[j]!)) j++;
      if (text[j] === '\r' || text[j] === '\n') {
        if (keepHyphen) {
          out += c;
          origin.push(i);
        }
        while (j < text.length && /\s/.test(text[j]!)) j++;
        i = j;
        continue;
      }
    }
    if (/\s/.test(c)) {
      if (out.length > 0 && out[out.length - 1] !== ' ') {
        out += ' ';
        origin.push(i);
      }
      i++;
      continue;
    }
    out += c;
    origin.push(i);
    i++;
  }
  if (out.endsWith(' ')) {
    out = out.slice(0, -1);
    origin.pop();
  }
  return { text: out, origin };
}
