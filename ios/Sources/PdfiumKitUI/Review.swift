import SwiftUI
import PdfiumKit

/// Puts the viewer in review mode: marks over the page that a tap cycles, and a bar that
/// always shows `notice`. The component does not apply anything; `onApply` does.
public struct PdfReviewConfiguration {
    public var marks: [PdfMark]
    public var notice: String
    public var applyLabel: String
    public var onApply: ([String]) -> Void
    public var onCancel: (() -> Void)?

    public init(marks: [PdfMark], notice: String, applyLabel: String = "Apply",
                onApply: @escaping ([String]) -> Void, onCancel: (() -> Void)? = nil) {
        self.marks = marks
        self.notice = notice
        self.applyLabel = applyLabel
        self.onApply = onApply
        self.onCancel = onCancel
    }
}

struct PdfReviewBar: View {
    let configuration: PdfReviewConfiguration
    let marks: [PdfMark]
    let theme: PdfViewerTheme
    let setAll: (PdfMarkState) -> Void
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(configuration.notice).font(.caption).accessibilityIdentifier("review-notice")
            // At accessibility text sizes the buttons stack under the counts rather than run off the edge.
            Group {
                if dynamicTypeSize.isAccessibilitySize {
                    VStack(alignment: .leading, spacing: 6) {
                        counts
                        buttonList
                    }
                } else {
                    HStack {
                        counts
                        Spacer()
                        buttonList
                    }
                }
            }
            .font(.caption)
        }
        .padding(8)
        .background(theme.toolbarBackground)
    }

    private var counts: some View {
        Text("\(marks.filter { $0.state == .accepted }.count) accepted · \(marks.filter { $0.state == .pending }.count) pending")
            .accessibilityIdentifier("review-counts")
    }

    @ViewBuilder
    private var buttonList: some View {
        Button("Accept all") { setAll(.accepted) }.accessibilityIdentifier("review-accept-all")
        Button("Reject all") { setAll(.rejected) }.accessibilityIdentifier("review-reject-all")
        Button(configuration.applyLabel) {
            configuration.onApply(marks.filter { $0.state == .accepted }.map(\.id))
        }.accessibilityIdentifier("review-apply")
        if let cancel = configuration.onCancel {
            Button("Cancel", action: cancel).accessibilityIdentifier("review-cancel")
        }
    }
}
