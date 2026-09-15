import SwiftUI
import PdfiumKit

/// The toolbar, which **must not clip**.
///
/// Every item has a fixed width, so a plain `HStack` overflows rather than wrapping and
/// SwiftUI silently cuts off whatever does not fit. That already happened once in this
/// project's demo: a fifth tool pushed the zoom and save buttons off the edge, and it
/// surfaced as two unrelated-looking test failures because the buttons existed and the
/// taps went nowhere. A *configurable* toolbar makes it likelier, since apps add items —
/// so this scrolls horizontally instead.
struct PdfToolbarView: View {
    let items: [PdfToolbarItem]
    let theme: PdfViewerTheme
    let tool: PdfTool
    let canUndo: Bool
    let hasSelection: Bool
    var reviewing = false
    let perform: (PdfToolbarItem) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(items) { item in content(for: item) }
            }
            .padding(.horizontal, 8)
            .frame(minWidth: 0, maxWidth: .infinity, alignment: .leading)
        }
        .frame(height: CGFloat(theme.toolbarHeight))
        .background(theme.toolbarBackground)
    }

    @ViewBuilder
    private func content(for item: PdfToolbarItem) -> some View {
        switch item.kind {
        case .spacer:
            Spacer(minLength: 12)
        case .divider:
            Divider().frame(height: 24)
        default:
            Button { perform(item) } label: {
                Image(systemName: item.systemImage)
                    .font(.system(size: CGFloat(theme.iconSize)))
                    .frame(width: 34, height: 30)
                    .background(isActive(item) ? theme.accent.opacity(0.18) : .clear)
                    .clipShape(RoundedRectangle(cornerRadius: CGFloat(theme.cornerRadius)))
            }
            .foregroundColor(theme.toolbarForeground)
            .disabled(isDisabled(item))
            .accessibilityLabel(item.label)
            .accessibilityIdentifier(item.id)
        }
    }

    private func isActive(_ item: PdfToolbarItem) -> Bool {
        if case .tool(let selected) = item.kind { return selected == tool }
        return false
    }

    private func isDisabled(_ item: PdfToolbarItem) -> Bool {
        switch item.kind {
        case .undo: return !canUndo
        case .deleteSelection: return !hasSelection
        case .tool: return reviewing
        default: return false
        }
    }
}
