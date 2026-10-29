import Foundation

/// The XML side of XFDF: a small element tree, the canonical number format and escaping.
enum Xfdf {
    static let maxBytes = 10 * 1024 * 1024

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
        let parser = XMLParser(data: data)
        parser.shouldResolveExternalEntities = false
        parser.shouldProcessNamespaces = false
        let builder = Builder()
        parser.delegate = builder
        guard parser.parse(), let root = builder.root, builder.stack.isEmpty else {
            throw invalid(parser.parserError?.localizedDescription ?? "malformed XML")
        }
        return root
    }

    private final class Builder: NSObject, XMLParserDelegate {
        var root: Element?
        var stack: [Element] = []

        func parser(_ parser: XMLParser, didStartElement name: String, namespaceURI: String?,
                    qualifiedName: String?, attributes: [String: String] = [:]) {
            let element = Element(name: name, attributes: attributes)
            if let parent = stack.last { parent.children.append(element) } else { root = element }
            stack.append(element)
        }

        func parser(_ parser: XMLParser, didEndElement name: String, namespaceURI: String?, qualifiedName: String?) {
            stack.removeLast()
        }

        func parser(_ parser: XMLParser, foundCharacters string: String) { stack.last?.text += string }

        func parser(_ parser: XMLParser, foundCDATA block: Data) {
            stack.last?.text += String(decoding: block, as: UTF8.self)
        }
    }

    /// At most four decimals, no trailing zeros, no exponent, and never "-0".
    static func format(_ value: Double) -> String {
        var text = String(format: "%.4f", value)
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
            default: out.append(c)
            }
        }
        return out
    }
}
