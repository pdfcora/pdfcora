/**
 * Matching a form field to a profile key without a model (FORM-3), in English and German.
 * Behaviour is pinned by conformance/forms/matching.json, which every platform runs.
 */
export type PdfProfileKey =
  | 'givenName' | 'familyName' | 'fullName' | 'dateOfBirth' | 'email' | 'phone'
  | 'street' | 'postalCode' | 'city' | 'country' | 'iban' | 'company';

/** Also the tie-break order. */
export const PROFILE_KEYS: readonly PdfProfileKey[] = [
  'givenName', 'familyName', 'fullName', 'dateOfBirth', 'email', 'phone',
  'street', 'postalCode', 'city', 'country', 'iban', 'company',
];

const PHRASES: Record<PdfProfileKey, readonly string[]> = {
  givenName: ['first name', 'given name', 'forename', 'vorname', 'rufname'],
  familyName: ['last name', 'surname', 'family name', 'nachname', 'familienname', 'zuname'],
  fullName: ['full name', 'name', 'your name', 'vollständiger name', 'name und vorname'],
  dateOfBirth: ['date of birth', 'birth date', 'birthday', 'dob', 'geburtsdatum', 'geboren am'],
  email: ['email', 'e-mail', 'email address', 'e-mail address', 'e-mail-adresse', 'mail'],
  phone: ['phone', 'telephone', 'phone number', 'mobile', 'telefon', 'telefonnummer', 'mobilnummer', 'handy'],
  street: ['street', 'address', 'street address', 'address line 1', 'straße', 'strasse', 'straße und hausnummer', 'anschrift'],
  postalCode: ['postal code', 'postcode', 'zip', 'zip code', 'plz', 'postleitzahl'],
  city: ['city', 'town', 'ort', 'stadt', 'wohnort'],
  country: ['country', 'land', 'staat'],
  iban: ['iban', 'bank account', 'kontonummer'],
  company: ['company', 'organisation', 'organization', 'employer', 'firma', 'unternehmen', 'arbeitgeber'],
};

/** A trailing "(MM/DD/YYYY)" and the like: kept for formatting, ignored for matching. */
export const formatHintOf = (text: string): string | undefined => text.match(/\(([^()]*)\)\s*$/)?.[1];

export function normalise(text: string): string {
  return text.replace(/\([^()]*\)\s*$/, '').toLowerCase()
    .replace(/ß/g, 'ss').replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue')
    .replace(/[_\-./0-9]/g, ' ').replace(/[^\p{L} ]/gu, '').replace(/\s+/g, ' ').trim();
}

const NORMALISED = PROFILE_KEYS.flatMap((key) => PHRASES[key].map((phrase) => ({ key, phrase: normalise(phrase) })));

/** The key a text names, or null. Most words wins, then most letters, then key order. */
export function matchKey(text: string): PdfProfileKey | null {
  const padded = ` ${normalise(text)} `;
  if (padded.trim() === '') return null;
  let best: { key: PdfProfileKey; words: number; letters: number } | null = null;
  for (const { key, phrase } of NORMALISED) {
    if (!padded.includes(` ${phrase} `)) continue;
    const words = phrase.split(' ').length;
    const letters = phrase.replace(/ /g, '').length;
    if (!best || words > best.words || (words === best.words && letters > best.letters)) best = { key, words, letters };
  }
  return best?.key ?? null;
}

/** Tooltip, then label, then name: the first that names a key decides. */
export function matchField(field: { name?: string; alternateName?: string; label?: string }): PdfProfileKey | null {
  for (const text of [field.alternateName, field.label, field.name]) {
    const key = text ? matchKey(text) : null;
    if (key) return key;
  }
  return null;
}
