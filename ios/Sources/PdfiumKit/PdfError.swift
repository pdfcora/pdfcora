@_implementationOnly import CPdfium

/// Errors raised by PdfiumKit. Cases are identical across the iOS, Android, and Web SDKs.
public enum PdfError: Error, Equatable, Sendable {
    case passwordRequired
    case wrongPassword
    case corrupt(detail: String)
    case unsupportedSecurity
    case pageOutOfRange(Int, count: Int)
    case closed
    case cancelled
    case saveFailed(reason: String)
    case invalidOperation(reason: String)
    /// An FPDF_GetLastError value with no more specific mapping.
    case engine(code: Int)

    /// A PDFium call has outlived ``PdfDocument/engineTimeout`` and still holds the
    /// engine, which every document shares. Calls behind it fail with this instead of
    /// waiting forever; they succeed again if the stuck call ever returns.
    case engineUnresponsive

    /// This viewer is following someone else's session and may not edit.
    case readOnlyFollower

    /// An edit arrived for a document with different bytes. Annotation and field
    /// indices are positions in specific bytes, so applying it would change the
    /// wrong thing.
    case documentMismatch(expected: String, received: String)

    /// Maps the engine's last error, using `password` to disambiguate the two password cases.
    static func fromEngine(passwordSupplied: Bool) -> PdfError {
        switch FPDF_GetLastError() {
        case 3: return .corrupt(detail: "malformed PDF structure")
        case 4: return passwordSupplied ? .wrongPassword : .passwordRequired
        case 5: return .unsupportedSecurity
        case 2: return .corrupt(detail: "file could not be read")
        case let code: return .engine(code: Int(code))
        }
    }
}

extension PdfError: CustomStringConvertible {
    public var description: String {
        switch self {
        case .passwordRequired:       return "a password is required to open this document"
        case .wrongPassword:          return "the supplied password is incorrect"
        case .corrupt(let detail):    return "the document is corrupt: \(detail)"
        case .unsupportedSecurity:    return "the document uses an unsupported security handler"
        case .pageOutOfRange(let i, let n): return "page \(i) is out of range (document has \(n))"
        case .closed:                 return "the document has been closed"
        case .cancelled:              return "the operation was cancelled"
        case .saveFailed(let reason): return "saving failed: \(reason)"
        case .invalidOperation(let reason): return "invalid operation: \(reason)"
        case .engine(let code):       return "PDFium error \(code)"
        case .engineUnresponsive:
            return "the PDF engine is stuck on an earlier call and cannot take work"
        case .readOnlyFollower:
            return "this viewer is following another session and cannot edit the document"
        case .documentMismatch(let expected, let received):
            return "edit is for a different document (expected \(expected), received \(received))"
        }
    }
}
