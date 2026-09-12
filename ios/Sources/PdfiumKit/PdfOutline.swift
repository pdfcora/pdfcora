import Foundation
import CPdfium

/// A bookmark in the document outline. The whole tree is read eagerly as values.
public struct PdfOutlineItem: Equatable, Sendable {
    public let title: String
    /// Destination page, when the bookmark points somewhere resolvable.
    public let pageIndex: Int?
    public let children: [PdfOutlineItem]
}

/// A link region on a page.
public struct PdfLink: Equatable, Sendable {
    public enum Target: Equatable, Sendable {
        case page(Int)
        case uri(String)
        case unresolved
    }
    public let rect: PdfRect
    public let target: Target
}

/// An embedded file attachment.
public struct PdfAttachment: Equatable, Sendable {
    public let name: String
    public let byteCount: Int
}

extension PdfDocument {
    /// The document outline, or an empty array when there is none.
    public var outline: [PdfOutlineItem] {
        get throws {
            let handle = try requireHandle()
            return children(of: nil, in: handle, depth: 0)
        }
    }

    /// Guards against the cyclic bookmark trees malformed documents can contain.
    private func children(of parent: FPDF_BOOKMARK?, in doc: FPDF_DOCUMENT, depth: Int) -> [PdfOutlineItem] {
        guard depth < 32 else { return [] }
        var items: [PdfOutlineItem] = []
        var current = FPDFBookmark_GetFirstChild(doc, parent)
        var visited = 0

        while let bookmark = current, visited < 4096 {
            visited += 1
            items.append(PdfOutlineItem(
                title: bookmarkTitle(bookmark),
                pageIndex: bookmarkPage(bookmark, in: doc),
                children: children(of: bookmark, in: doc, depth: depth + 1)
            ))
            current = FPDFBookmark_GetNextSibling(doc, bookmark)
        }
        return items
    }

    private func bookmarkTitle(_ bookmark: FPDF_BOOKMARK) -> String {
        let byteCount = FPDFBookmark_GetTitle(bookmark, nil, 0)
        guard byteCount > 2 else { return "" }
        var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
        FPDFBookmark_GetTitle(bookmark, &buffer, byteCount)
        return String(decoding: buffer.dropLast(), as: UTF16.self)
    }

    private func bookmarkPage(_ bookmark: FPDF_BOOKMARK, in doc: FPDF_DOCUMENT) -> Int? {
        if let dest = FPDFBookmark_GetDest(doc, bookmark) {
            let index = FPDFDest_GetDestPageIndex(doc, dest)
            return index >= 0 ? Int(index) : nil
        }
        if let action = FPDFBookmark_GetAction(bookmark),
           let dest = FPDFAction_GetDest(doc, action) {
            let index = FPDFDest_GetDestPageIndex(doc, dest)
            return index >= 0 ? Int(index) : nil
        }
        return nil
    }

    /// Files embedded in the document.
    public var attachments: [PdfAttachment] {
        get throws {
            let handle = try requireHandle()
            let count = Int(FPDFDoc_GetAttachmentCount(handle))
            var result: [PdfAttachment] = []
            for i in 0..<max(0, count) {
                guard let attachment = FPDFDoc_GetAttachment(handle, Int32(i)) else { continue }
                let nameBytes = FPDFAttachment_GetName(attachment, nil, 0)
                var name = ""
                if nameBytes > 2 {
                    var buffer = [UInt16](repeating: 0, count: Int(nameBytes) / 2)
                    FPDFAttachment_GetName(attachment, &buffer, nameBytes)
                    name = String(decoding: buffer.dropLast(), as: UTF16.self)
                }
                var size: UInt = 0
                FPDFAttachment_GetFile(attachment, nil, 0, &size)
                result.append(PdfAttachment(name: name, byteCount: Int(size)))
            }
            return result
        }
    }

    /// The bytes of one attachment.
    public func attachmentData(at index: Int) throws -> Data {
        let handle = try requireHandle()
        let count = Int(FPDFDoc_GetAttachmentCount(handle))
        guard index >= 0 && index < count else {
            throw PdfError.pageOutOfRange(index, count: count)
        }
        guard let attachment = FPDFDoc_GetAttachment(handle, Int32(index)) else {
            throw PdfError.corrupt(detail: "attachment \(index) unreadable")
        }
        var size: UInt = 0
        FPDFAttachment_GetFile(attachment, nil, 0, &size)
        guard size > 0 else { return Data() }
        var bytes = [UInt8](repeating: 0, count: Int(size))
        var written: UInt = 0
        FPDFAttachment_GetFile(attachment, &bytes, size, &written)
        return Data(bytes.prefix(Int(written)))
    }
}

extension PdfPage {
    /// Link regions on this page.
    public func links() async throws -> [PdfLink] {
        try await document.links(pageIndex: index)
    }
}

extension PdfDocument {
    func links(pageIndex: Int) throws -> [PdfLink] {
        let doc = try requireHandle()
        let page = try loadedPage(pageIndex)
        var links: [PdfLink] = []
        var position: Int32 = 0
        var link: FPDF_LINK?

        while FPDFLink_Enumerate(page, &position, &link) != 0 {
            guard let link else { continue }
            var rect = FS_RECTF()
            guard FPDFLink_GetAnnotRect(link, &rect) != 0 else { continue }

            links.append(PdfLink(
                rect: PdfRect(left: Double(rect.left), bottom: Double(rect.bottom),
                              right: Double(rect.right), top: Double(rect.top)),
                target: linkTarget(link, in: doc)
            ))
        }
        return links
    }

    private func linkTarget(_ link: FPDF_LINK, in doc: FPDF_DOCUMENT) -> PdfLink.Target {
        if let dest = FPDFLink_GetDest(doc, link) {
            let index = FPDFDest_GetDestPageIndex(doc, dest)
            if index >= 0 { return .page(Int(index)) }
        }
        guard let action = FPDFLink_GetAction(link) else { return .unresolved }

        if let dest = FPDFAction_GetDest(doc, action) {
            let index = FPDFDest_GetDestPageIndex(doc, dest)
            if index >= 0 { return .page(Int(index)) }
        }
        let byteCount = FPDFAction_GetURIPath(doc, action, nil, 0)
        guard byteCount > 1 else { return .unresolved }
        var buffer = [CChar](repeating: 0, count: Int(byteCount))
        FPDFAction_GetURIPath(doc, action, &buffer, byteCount)
        let uri = String(cString: buffer)
        return uri.isEmpty ? .unresolved : .uri(uri)
    }
}
