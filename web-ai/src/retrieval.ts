import type { PdfPassage } from './text.js';

/** Lower-cased letter and digit runs. Diacritics are kept: "Straße" is not "Strasse". */
export function tokens(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Ranks passages against a question with BM25, on the device and without a model (ANS-1).
 *
 * Returns only passages that share at least one term with the question, best first, and
 * stops before their combined text would exceed `budgetChars`.
 */
export function retrieve(
  passages: readonly PdfPassage[], question: string, budgetChars: number,
): PdfPassage[] {
  const k1 = 1.2;
  const b = 0.75;
  const terms = [...new Set(tokens(question))];
  if (terms.length === 0 || passages.length === 0) return [];

  const docs = passages.map((p) => tokens(p.text));
  const averageLength = docs.reduce((sum, d) => sum + d.length, 0) / docs.length || 1;
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  }

  const scored = passages.map((passage, i) => {
    const doc = docs[i]!;
    let score = 0;
    for (const term of terms) {
      const frequency = doc.filter((t) => t === term).length;
      if (frequency === 0) continue;
      const n = documentFrequency.get(term) ?? 0;
      const idf = Math.log(1 + (passages.length - n + 0.5) / (n + 0.5));
      score += idf * (frequency * (k1 + 1)) / (frequency + k1 * (1 - b + b * doc.length / averageLength));
    }
    return { passage, score };
  });

  const picked: PdfPassage[] = [];
  let used = 0;
  for (const { passage, score } of scored.filter((s) => s.score > 0).sort((x, y) => y.score - x.score)) {
    if (used + passage.text.length > budgetChars) break;
    picked.push(passage);
    used += passage.text.length;
  }
  return picked;
}
