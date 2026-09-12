import Foundation
import CPdfium

/// Initialises PDFium exactly once per process.
enum PdfEngine {
    private static let once: Void = {
        var config = FPDF_LIBRARY_CONFIG()
        config.version = 3
        FPDF_InitLibraryWithConfig(&config)
    }()

    static func ensureInitialized() { _ = once }

    /// The PDFium revision this SDK was built against.
    public static let revision = "chromium/7243"
}

/// An open PDF document.
///
/// Every PDFium call for this document and anything reached through it runs on this
/// actor, which is what makes the SDK safe to use from any task. Separate documents
/// have separate actors, so unrelated documents render in parallel.
public actor PdfDocument {
    private(set) var handle: FPDF_DOCUMENT?
    private var formHandle: FPDF_FORMHANDLE?
    private var pageCache: [Int: FPDF_PAGE] = [:]
    private var formInfo = FPDF_FORMFILLINFO()

    /// PDFium reads from this buffer lazily, so it must outlive the document handle.
    private let backing: Data

    /// The PDFium revision this SDK was built against.
    public nonisolated static var engineVersion: String { PdfEngine.revision }

    public init(data: Data, password: String? = nil) async throws {
        PdfEngine.ensureInitialized()
        self.backing = data

        let opened: FPDF_DOCUMENT? = data.withUnsafeBytes { raw in
            if let password {
                return password.withCString { FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), $0) }
            }
            return FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), nil)
        }

        guard let opened else { throw PdfError.fromEngine(passwordSupplied: password != nil) }
        self.handle = opened

        formInfo.version = 2
        self.formHandle = FPDFDOC_InitFormFillEnvironment(opened, &formInfo)
        if let formHandle {
            FORM_DoDocumentJSAction(formHandle)
            FORM_DoDocumentOpenAction(formHandle)
        }
    }

    public init(url: URL, password: String? = nil) async throws {
        try await self.init(data: try Data(contentsOf: url, options: .mappedIfSafe), password: password)
    }

    deinit {
        for (_, page) in pageCache { FPDF_ClosePage(page) }
        if let formHandle { FPDFDOC_ExitFormFillEnvironment(formHandle) }
        if let handle { FPDF_CloseDocument(handle) }
    }

    /// Releases the document and every page loaded from it. Further use throws ``PdfError/closed``.
    public func close() {
        for (_, page) in pageCache { FPDF_ClosePage(page) }
        pageCache.removeAll()
        if let formHandle { FPDFDOC_ExitFormFillEnvironment(formHandle); self.formHandle = nil }
        if let handle { FPDF_CloseDocument(handle); self.handle = nil }
    }

    public var isClosed: Bool { handle == nil }

    public var pageCount: Int {
        guard let handle else { return 0 }
        return Int(FPDF_GetPageCount(handle))
    }

    public var permissions: PdfPermissions {
        guard let handle else { return [] }
        return PdfPermissions(rawValue: Int(FPDF_GetDocPermissions(handle)))
    }

    /// A lightweight reference to a page. Loading is deferred until the page is used.
    public func page(_ index: Int) throws -> PdfPage {
        let count = pageCount
        guard index >= 0 && index < count else {
            throw PdfError.pageOutOfRange(index, count: count)
        }
        return PdfPage(document: self, index: index)
    }

    // MARK: - Internal, actor-isolated primitives

    func requireHandle() throws -> FPDF_DOCUMENT {
        guard let handle else { throw PdfError.closed }
        return handle
    }

    var form: FPDF_FORMHANDLE? { formHandle }

    /// Loads and caches a page, running form-load callbacks the first time.
    func loadedPage(_ index: Int) throws -> FPDF_PAGE {
        let doc = try requireHandle()
        if let cached = pageCache[index] { return cached }
        let count = Int(FPDF_GetPageCount(doc))
        guard index >= 0 && index < count else {
            throw PdfError.pageOutOfRange(index, count: count)
        }
        guard let page = FPDF_LoadPage(doc, Int32(index)) else {
            throw PdfError.corrupt(detail: "page \(index) failed to load")
        }
        if let formHandle {
            FORM_OnAfterLoadPage(page, formHandle)
            FORM_DoPageAAction(page, formHandle, FPDFPAGE_AACTION_OPEN)
        }
        pageCache[index] = page
        return page
    }

    /// Releases a cached page. Safe to call for a page that was never loaded.
    func releasePage(_ index: Int) {
        guard let page = pageCache.removeValue(forKey: index) else { return }
        if let formHandle {
            FORM_DoPageAAction(page, formHandle, FPDFPAGE_AACTION_CLOSE)
            FORM_OnBeforeClosePage(page, formHandle)
        }
        FPDF_ClosePage(page)
    }

    /// Runs `body` with the raw document handle. The escape hatch of spec §8 — unsafe,
    /// and only valid for the duration of the call.
    public func withRawHandle<T>(_ body: (OpaquePointer) throws -> T) throws -> T {
        try body(try requireHandle())
    }
}
