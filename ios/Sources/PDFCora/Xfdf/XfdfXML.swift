import Foundation

/// The XML side of XFDF: a small element tree, the canonical number format and escaping.
enum Xfdf {
    static let maxBytes = 10 * 1024 * 1024
    /// Real XFDF nests a handful of levels; a limit keeps hostile input from exhausting the stack.
    static let maxDepth = 64

    final class Element {
        let name: String
        let attributes: [String: String]
        var children: [Element] = []
        var text = ""
        init(name: String, attributes: [String: String]) { self.name = name; self.attributes = attributes }
    }

    private static func invalid(_ why: String) -> PdfError { .invalidOperation(reason: "not valid XFDF: \(why)") }

    /// Parses XFDF with `XMLParser`. Input from outside is untrusted, so a DOCTYPE or entity
    /// declaration is refused before parsing, and external entities stay off.
    static func parse(_ text: String) throws -> Element {
        let data = Data(text.utf8)
        if data.count > maxBytes { throw invalid("larger than 10 MiB") }
        if text.contains("<!DOCTYPE") || text.contains("<!ENTITY") {
            throw invalid("DOCTYPE and entity declarations are not allowed")
        }
        // The parser is handed UTF-8. A declaration naming another encoding (UTF-7, UTF-16)
        // would make it re-read the bytes, and could hide a DOCTYPE from the check above.
        if let declaration = text.range(of: #"^\s*<\?xml[^>]*\?>"#, options: .regularExpression),
           let encoding = text[declaration].range(of: #"encoding\s*=\s*["']([^"']*)["']"#, options: .regularExpression) {
            let value = text[declaration][encoding].split(whereSeparator: { $0 == "\"" || $0 == "'" }).dropFirst().first ?? ""
            guard value.lowercased() == "utf-8" else { throw invalid("only UTF-8 is accepted, not \(value)") }
        }
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.shouldProcessNamespaces = false
        let builder = Builder()
        parser.delegate = builder
        guard parser.parse(), builder.refusal == nil, let root = builder.root, builder.stack.isEmpty else {
            throw invalid(builder.refusal ?? parser.parserError?.localizedDescription ?? "malformed XML")
        }
        return root
    }

    private final class Builder: NSObject, XMLParserDelegate {
        var root: Element?
        var stack: [Element] = []
        var refusal: String?

        private func refuse(_ parser: XMLParser, _ why: String) {
            if refusal == nil { refusal = why }
            parser.abortParsing()
        }

        // The text check above cannot see a DOCTYPE in another encoding (UTF-7, UTF-16);
        // any declaration the parser reports stops it.
        func parser(_ parser: XMLParser, foundInternalEntityDeclarationWithName name: String, value: String?) {
            refuse(parser, "entity declarations are not allowed")
        }
        func parser(_ parser: XMLParser, foundExternalEntityDeclarationWithName name: String, publicID: String?, systemID: String?) {
            refuse(parser, "entity declarations are not allowed")
        }
        func parser(_ parser: XMLParser, foundElementDeclarationWithName elementName: String, model: String) {
            refuse(parser, "DOCTYPE declarations are not allowed")
        }
        func parser(_ parser: XMLParser, foundNotationDeclarationWithName name: String, publicID: String?, systemID: String?) {
            refuse(parser, "DOCTYPE declarations are not allowed")
        }
        func parser(_ parser: XMLParser, resolveExternalEntityName name: String, systemID: String?) -> Data? {
            refuse(parser, "external entities are not allowed")
            return nil
        }

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            if stack.count >= Xfdf.maxDepth { refuse(parser, "nested deeper than \(Xfdf.maxDepth) levels"); return }
            let element = Element(name: name, attributes: attributes)
            if let parent = stack.last { parent.children.append(element) } else { root = element }
            stack.append(element)
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            if !stack.isEmpty { stack.removeLast() }
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.text += string }

        func parser(_ parser: XMLParser, foundCDATA block: Data) {
            stack.last?.text += String(decoding: block, as: UTF8.self)
        }
    }

    /// At most four decimals, no trailing zeros, no exponent, and never "-0". Halves round
    /// away from zero, as JavaScript's toFixed and Java's formatter do; C's %f would round
    /// a tie such as 72.03125 to even.
    static func format(_ value: Double) -> String {
        let rounded = (value * 10_000).rounded(.toNearestOrAwayFromZero) / 10_000
        var text = String(format: "%.4f", rounded)
        while text.hasSuffix("0") { text.removeLast() }
        if text.hasSuffix(".") { text.removeLast() }
        return text == "-0" ? "0" : text
    }

    static func escapeAttribute(_ s: String) -> String {
        var out = ""
        for c in s {
            switch c {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\"": out += "&quot;"
            case "'": out += "&apos;"
            case "\r": out += "&#13;"
            case "\n": out += "&#10;"
            case "\t": out += "&#9;"
            case "\r\n": out += "&#13;&#10;"
            default: out.append(c)
            }
        }
        return out
    }

    static func escapeText(_ s: String) -> String {
        var out = ""
        for c in s {
            switch c {
            case "&": out += "&amp;"
            case "<": out += "&lt;"
            case ">": out += "&gt;"
            case "\r": out += "&#13;"
            case "\r\n": out += "&#13;\n"
            default: out.append(c)
            }
        }
        return out
    }
}
