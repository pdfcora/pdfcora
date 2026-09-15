import Foundation

/// A profile value's meaning (FORM-2). The order is also the tie-break order.
public enum PdfProfileKey: String, CaseIterable, Sendable {
    case givenName, familyName, fullName, dateOfBirth, email, phone, street, postalCode, city, country, iban, company
}

/// Matching a form field to a profile key without a model (FORM-3), in English and German.
/// Behaviour is pinned by conformance/forms/matching.json, which every platform runs.
enum Synonyms {
    private static let phrases: [PdfProfileKey: [String]] = [
        .givenName: ["first name", "given name", "forename", "vorname", "rufname"],
        .familyName: ["last name", "surname", "family name", "nachname", "familienname", "zuname"],
        .fullName: ["full name", "name", "your name", "vollständiger name", "name und vorname"],
        .dateOfBirth: ["date of birth", "birth date", "birthday", "dob", "geburtsdatum", "geboren am"],
        .email: ["email", "e-mail", "email address", "e-mail address", "e-mail-adresse", "mail"],
        .phone: ["phone", "telephone", "phone number", "mobile", "telefon", "telefonnummer", "mobilnummer", "handy"],
        .street: ["street", "address", "street address", "address line 1", "straße", "strasse", "straße und hausnummer", "anschrift"],
        .postalCode: ["postal code", "postcode", "zip", "zip code", "plz", "postleitzahl"],
        .city: ["city", "town", "ort", "stadt", "wohnort"],
        .country: ["country", "land", "staat"],
        .iban: ["iban", "bank account", "kontonummer"],
        .company: ["company", "organisation", "organization", "employer", "firma", "unternehmen", "arbeitgeber"],
    ]

    private static let normalised: [(key: PdfProfileKey, phrase: String)] =
        PdfProfileKey.allCases.flatMap { key in phrases[key]!.map { (key, normalise($0)) } }

    /// A trailing "(MM/DD/YYYY)" and the like: kept for formatting, ignored for matching.
    static func formatHint(_ text: String) -> String? {
        guard let range = text.range(of: #"\(([^()]*)\)\s*$"#, options: .regularExpression) else { return nil }
        return text[range].trimmingCharacters(in: .whitespaces).dropFirst().dropLast().description
    }

    static func normalise(_ text: String) -> String {
        var s = text.replacingOccurrences(of: #"\([^()]*\)\s*$"#, with: "", options: .regularExpression).lowercased()
        for (from, to) in [("ß", "ss"), ("ä", "ae"), ("ö", "oe"), ("ü", "ue")] { s = s.replacingOccurrences(of: from, with: to) }
        s = s.replacingOccurrences(of: #"[_\-./0-9]"#, with: " ", options: .regularExpression)
        s = String(String.UnicodeScalarView(s.unicodeScalars.filter { CharacterSet.letters.contains($0) || $0 == " " }))
        return s.replacingOccurrences(of: #"\s+"#, with: " ", options: .regularExpression).trimmingCharacters(in: .whitespaces)
    }

    /// The key a text names, or nil. Most words wins, then most letters, then key order.
    static func key(for text: String) -> PdfProfileKey? {
        let padded = " \(normalise(text)) "
        guard !padded.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
        var best: (key: PdfProfileKey, words: Int, letters: Int)?
        for (key, phrase) in normalised where padded.contains(" \(phrase) ") {
            let words = phrase.split(separator: " ").count
            let letters = phrase.replacingOccurrences(of: " ", with: "").count
            if best == nil || words > best!.words || (words == best!.words && letters > best!.letters) {
                best = (key, words, letters)
            }
        }
        return best?.key
    }

    /// Tooltip, then label, then name: the first that names a key decides.
    static func key(name: String?, alternateName: String?, label: String?) -> PdfProfileKey? {
        for text in [alternateName, label, name] {
            if let text, let key = key(for: text) { return key }
        }
        return nil
    }
}
