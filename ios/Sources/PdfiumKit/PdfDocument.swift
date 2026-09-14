import Foundation
@_implementationOnly import CPdfium

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
    /// Every document runs on the same engine thread. See ``EngineExecutor``: PDFium's
    /// global state is not thread-safe, so per-actor executors let two documents race it.
    public nonisolated var unownedExecutor: UnownedSerialExecutor {
        EngineExecutor.shared.asUnownedSerialExecutor()
    }

    private(set) var handle: FPDF_DOCUMENT?
    private var formHandle: FPDF_FORMHANDLE?
    private var pageCache: [Int: FPDF_PAGE] = [:]
    /// On the heap, not stored inline: PDFium dereferences this for the life of the form
    /// handle, and `deinit` closes that handle after the actor's own memory is freed.
    private let formInfo: UnsafeMutablePointer<FPDF_FORMFILLINFO> = {
        let info = UnsafeMutablePointer<FPDF_FORMFILLINFO>.allocate(capacity: 1)
        info.initialize(to: FPDF_FORMFILLINFO())
        return info
    }()

    /// PDFium reads from this buffer lazily, so it must outlive the document handle.
    /// Its length is also what a signature's byte range is measured against.
    let backing: Data
    private var cachedFingerprint: String?

    /// A stable identifier for the bytes this document was opened from.
    ///
    /// Two documents opened from identical bytes share it; any difference changes it.
    /// Used to refuse replaying an edit against the wrong document — annotation and
    /// field indices are positions in specific bytes, so a removal replayed elsewhere
    /// removes the wrong thing, silently.
    ///
    /// FNV-1a rather than a cryptographic digest: this answers "are these the same
    /// bytes", not "has someone tampered with them", and needs no crypto framework. The
    /// length is appended, since a hash collision alone should not be enough.
    public var fingerprint: String {
        if let cachedFingerprint { return cachedFingerprint }
        var hash: UInt32 = 0x811c_9dc5
        for byte in backing {
            hash ^= UInt32(byte)
            hash = hash &* 16_777_619
        }
        let value = String(format: "%08x-%d", hash, backing.count)
        cachedFingerprint = value
        return value
    }

    /// The PDFium revision this SDK was built against.
    public nonisolated static var engineVersion: String { PdfEngine.revision }

    public init(data: Data, password: String? = nil) async throws {
        self.backing = data

        // An actor's init runs on the caller's context, *not* on the actor's executor,
        // so without this hop several documents opening at once would call PDFium
        // concurrently — which is exactly what CrossDocumentStressTests reproduces.
        let opened: FPDF_DOCUMENT? = EngineExecutor.shared.run {
            PdfEngine.ensureInitialized()
            return data.withUnsafeBytes { raw in
                if let password {
                    return password.withCString {
                        FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), $0)
                    }
                }
                return FPDF_LoadMemDocument(raw.baseAddress, Int32(data.count), nil)
            }
        }

        guard let opened else { throw PdfError.fromEngine(passwordSupplied: password != nil) }
        self.handle = opened

        formInfo.pointee.version = 2
        self.formHandle = EngineExecutor.shared.run {
            let form = FPDFDOC_InitFormFillEnvironment(opened, formInfo)
            if let form {
                FORM_DoDocumentJSAction(form)
                FORM_DoDocumentOpenAction(form)
            }
            return form
        }
    }

    public init(url: URL, password: String? = nil) async throws {
        try await self.init(data: try Data(contentsOf: url, options: .mappedIfSafe), password: password)
    }

    deinit {
        // An actor's deinit runs on whatever thread drops the last reference, not on the
        // actor's executor — so freeing here directly would race every other document's
        // in-flight work, which is the same bug CrossDocumentStressTests exists for.
        // `self` is gone by the time this runs, so everything PDFium still points into —
        // the form info and the bytes — is captured and released only after the handles.
        let pages = Array(pageCache.values)
        let form = formHandle
        let document = handle
        let info = formInfo
        let bytes = backing
        EngineExecutor.shared.runAsync {
            for page in pages { FPDF_ClosePage(page) }
            if let form { FPDFDOC_ExitFormFillEnvironment(form) }
            if let document { FPDF_CloseDocument(document) }
            info.deallocate()
            withExtendedLifetime(bytes) {}
        }
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
