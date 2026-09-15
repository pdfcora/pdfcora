import type { PdfDocument, PdfFormField, PdfRect } from '@pdfiumkit/web';
import { describeFields, type PdfFieldDescription } from './describe.js';
import { formatHintOf, matchField, normalise, PROFILE_KEYS, type PdfProfileKey } from './synonyms.js';
import type { PdfPageRange } from '../text.js';
import { resolve, type PdfAiProvider, type PdfAiSource } from '../provider.js';
import { trialText } from '../trial.js';

export type PdfProfile = Partial<Record<PdfProfileKey, string>>;
export const FORM_NOTICE = 'Check every value before filling in the form.';

export interface PdfFormProposal {
  readonly id: string;
  readonly pageIndex: number;
  readonly annotationIndex: number;
  readonly fieldName?: string;
  readonly kind: PdfFormField['kind'];
  readonly key: PdfProfileKey;
  /** Text to write, the option index for a choice, or `true` for a toggle. */
  readonly value: string | number | boolean;
  readonly source: PdfAiSource;
  readonly rect: PdfRect;
}

export interface PdfFormApplied {
  /** Reopens the document as it was before `apply`. */
  undo(): Promise<PdfDocument>;
}

export interface PdfFormProposals {
  readonly items: readonly PdfFormProposal[];
  readonly modelUsed: boolean;
  /** Must be shown with the proposals (HIL). */
  readonly notice: string;
  apply(acceptedIds: readonly string[]): Promise<PdfFormApplied>;
}

const FILLABLE = new Set<PdfFormField['kind']>(['text', 'checkBox', 'radioButton', 'comboBox', 'listBox']);

export const formSchema = {
  type: 'object',
  properties: {
    fields: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'string' }, key: { type: 'string', enum: [...PROFILE_KEYS, 'unknown'] } },
        required: ['id', 'key'],
      },
    },
  },
  required: ['fields'],
};

export function formPrompt(fields: readonly PdfFieldDescription[]): string {
  const quote = (s?: string) => JSON.stringify(s ?? '');
  return [
    "For each form field below, decide which personal detail it asks for, judging only by that field's own name, tooltip and label.",
    'Details: givenName (first name), familyName (last name), fullName (whole name), dateOfBirth, email, phone,',
    'street (street and house number), postalCode, city, country, iban (bank account number), company (employer).',
    'Answer "unknown" unless the field\'s own text clearly names the detail. A name like "Text3" names nothing.',
    'The fields are in no particular order; do not assign details by position.',
    'Reply with JSON: {"fields": [{"id": "...", "key": "..."}]}.',
    'Fields:',
    ...fields.map((f) => {
      const options = f.field.kind === 'comboBox' || f.field.kind === 'listBox' ? `, options ${JSON.stringify(f.field.options)}` : '';
      return `- id ${f.pageIndex}:${f.annotationIndex}: name ${quote(f.name)}, tooltip ${quote(f.alternateName)}, label ${quote(f.label)}, kind ${f.field.kind}${options}`;
    }),
  ].join('\n');
}

/** The value to propose for a field, or null when the profile value does not fit it (FORM-5). */
export function formatValue(description: PdfFieldDescription, key: PdfProfileKey, raw: string): string | number | boolean | null {
  const field = description.field;
  switch (field.kind) {
    case 'text': {
      let value = raw;
      const iso = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (key === 'dateOfBirth' && iso) {
        const hint = (formatHintOf(description.alternateName ?? '') ?? formatHintOf(description.label ?? '')
          ?? formatHintOf(description.name ?? '') ?? '').toUpperCase().replace(/\s/g, '');
        const [, y, m, d] = iso;
        if (hint === 'TT.MM.JJJJ' || hint === 'DD.MM.YYYY') value = `${d}.${m}.${y}`;
        else if (hint === 'MM/DD/YYYY') value = `${m}/${d}/${y}`;
        else if (hint === 'DD/MM/YYYY') value = `${d}/${m}/${y}`;
      }
      return value === field.value ? null : value;
    }
    case 'comboBox':
    case 'listBox': {
      const index = field.options.findIndex((o) => normalise(o) === normalise(raw) && normalise(o) !== '');
      return index < 0 || field.selectedIndices.includes(index) ? null : index;
    }
    case 'checkBox':
    case 'radioButton':
      return field.exportValue && normalise(field.exportValue) === normalise(raw) && !field.isChecked ? true : null;
    default:
      return null;
  }
}

function parseMatches(structured: unknown, text: string): { id: string; key: string }[] {
  let value = structured;
  if (value === undefined) {
    const from = text.indexOf('{');
    const to = text.lastIndexOf('}');
    try { value = from >= 0 && to > from ? JSON.parse(text.slice(from, to + 1)) : undefined; } catch { value = undefined; }
  }
  const fields = (value as { fields?: unknown })?.fields;
  return Array.isArray(fields)
    ? fields.filter((f): f is { id: string; key: string } => typeof f?.id === 'string' && typeof f?.key === 'string')
    : [];
}

export async function proposeFormValues(
  document: PdfDocument, provider: PdfAiProvider | undefined, profile: PdfProfile, options: { pages?: PdfPageRange } = {},
): Promise<PdfFormProposals> {
  const fields = (await describeFields(document, options.pages))
    .filter((f) => FILLABLE.has(f.field.kind) && !f.field.isReadOnly);

  const matched = new Map<PdfFieldDescription, { key: PdfProfileKey; source: PdfAiSource }>();
  for (const f of fields) {
    const key = matchField(f);
    if (key) matched.set(f, { key, source: 'rules' });
  }

  let modelUsed = false;
  const unknown = fields.filter((f) => !matched.has(f));
  if (provider && unknown.length > 0) {
    const result = await resolve<{ id: string; key: string }[]>({
      customProvider: async () => {
        const response = await provider.generate({ prompt: formPrompt(unknown), schema: formSchema });
        return parseMatches(response.structured, response.text);
      },
    });
    if ('value' in result) {
      modelUsed = true;
      const byId = new Map(unknown.map((f) => [`${f.pageIndex}:${f.annotationIndex}`, f]));
      for (const { id, key } of result.value) {
        const f = byId.get(id);
        if (f && !matched.has(f) && (PROFILE_KEYS as readonly string[]).includes(key)) {
          matched.set(f, { key: key as PdfProfileKey, source: result.source });
        }
      }
    }
  }

  const items: PdfFormProposal[] = [];
  for (const f of fields) {
    const match = matched.get(f);
    const raw = match ? profile[match.key] : undefined;
    if (!match || raw === undefined) continue;
    const value = formatValue(f, match.key, raw);
    if (value === null) continue;
    items.push({
      id: `${f.pageIndex}:${f.annotationIndex}:${match.key}`, pageIndex: f.pageIndex, annotationIndex: f.annotationIndex,
      fieldName: f.name, kind: f.field.kind, key: match.key, value, source: match.source, rect: f.field.rect,
    });
  }

  return {
    items, modelUsed, notice: trialText(FORM_NOTICE),
    apply: async (acceptedIds) => {
      const known = new Set(items.map((p) => p.id));
      for (const id of acceptedIds) if (!known.has(id)) throw new Error(`unknown proposal: ${id}`);
      const snapshot = await document.snapshot();
      for (const p of items.filter((i) => acceptedIds.includes(i.id))) {
        const page = await document.page(p.pageIndex);
        if (typeof p.value === 'string') await page.setText(p.value, p.annotationIndex);
        else if (typeof p.value === 'number') await page.setOption(p.value, true, p.annotationIndex);
        else await page.setChecked(true, p.annotationIndex);
      }
      return { undo: () => snapshot.open() };
    },
  };
}
