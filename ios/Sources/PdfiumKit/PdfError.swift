import CPdfium

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
        }
    }
}
