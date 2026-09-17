import SwiftUI
import PDFCora

/// One control in the viewer's toolbar.
///
/// Built-ins are identical on every platform. `custom` is **platform-native on purpose**:
/// an icon is an SF Symbol here, a vector drawable on Android and an SVG on the web, and
/// a cross-platform icon type would be a lowest common denominator that satisfies none
/// of them.
public struct PdfToolbarItem: Identifiable, Sendable {
    public enum Kind: Sendable, Equatable {
        case tool(PdfTool)
        case undo
        case deleteSelection
        case zoomOut
        case zoomIn
        case fitWidth
        case pageBack
        case pageForward
        case save
        case spacer
        case divider
        case custom(systemImage: String)
    }

    public let id: String
    public let kind: Kind
    public let label: String
    let action: (@Sendable () -> Void)?

    init(id: String, kind: Kind, label: String, action: (@Sendable () -> Void)? = nil) {
        self.id = id
        self.kind = kind
        self.label = label
        self.action = action
    }

    public static func tool(_ tool: PdfTool) -> PdfToolbarItem {
        PdfToolbarItem(id: "tool-\(tool.rawValue)", kind: .tool(tool), label: tool.label)
    }

    public static let undo = PdfToolbarItem(id: "editor-undo", kind: .undo, label: "Undo")
    public static let deleteSelection = PdfToolbarItem(id: "editor-delete", kind: .deleteSelection, label: "Delete")
    public static let zoomOut = PdfToolbarItem(id: "zoom-out", kind: .zoomOut, label: "Zoom out")
    public static let zoomIn = PdfToolbarItem(id: "zoom-in", kind: .zoomIn, label: "Zoom in")
    public static let fitWidth = PdfToolbarItem(id: "zoom-fit", kind: .fitWidth, label: "Fit")
    public static let pageBack = PdfToolbarItem(id: "page-back", kind: .pageBack, label: "Previous page")
    public static let pageForward = PdfToolbarItem(id: "page-forward", kind: .pageForward, label: "Next page")
    public static let save = PdfToolbarItem(id: "editor-save", kind: .save, label: "Save")
    public static let spacer = PdfToolbarItem(id: "spacer", kind: .spacer, label: "")
    public static let divider = PdfToolbarItem(id: "divider", kind: .divider, label: "")

    /// An app-defined button. `systemImage` is an SF Symbol name.
    public static func custom(id: String, label: String, systemImage: String,
                              action: @escaping @Sendable () -> Void) -> PdfToolbarItem {
        PdfToolbarItem(id: id, kind: .custom(systemImage: systemImage), label: label, action: action)
    }

    var systemImage: String {
        switch kind {
        case .tool(let tool): return tool.systemImage
        case .undo: return "arrow.uturn.backward"
        case .deleteSelection: return "trash"
        case .zoomOut: return "minus.magnifyingglass"
        case .zoomIn: return "plus.magnifyingglass"
        case .fitWidth: return "arrow.left.and.right"
        case .pageBack: return "chevron.left"
        case .pageForward: return "chevron.right"
        case .save: return "square.and.arrow.down"
        case .spacer, .divider: return ""
        case .custom(let systemImage): return systemImage
        }
    }
}

public struct PdfToolbarConfiguration: Sendable {
    public var items: [PdfToolbarItem]
    public init(items: [PdfToolbarItem]) { self.items = items }

    public static let `default` = PdfToolbarConfiguration(items: [
        .tool(.select), .tool(.ink), .tool(.note), .tool(.highlight), .tool(.redact),
        .divider, .undo, .deleteSelection,
        .spacer,
        .zoomOut, .fitWidth, .zoomIn,
        .divider, .save,
    ])

    /// Viewing only: no tools, no save.
    public static let viewing = PdfToolbarConfiguration(items: [
        .pageBack, .pageForward, .spacer, .zoomOut, .fitWidth, .zoomIn,
    ])
}

extension PdfTool {
    var label: String {
        switch self {
        case .select: return "Select"
        case .ink: return "Ink"
        case .note: return "Note"
        case .highlight: return "Highlight"
        case .redact: return "Redact"
        }
    }

    var systemImage: String {
        switch self {
        case .select: return "hand.tap"
        case .ink: return "scribble"
        case .note: return "note.text"
        case .highlight: return "highlighter"
        case .redact: return "rectangle.slash"
        }
    }
}
