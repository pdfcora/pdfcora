import Foundation
import SwiftUI
import PdfiumKit

/// Holds the document every screen works against, and the list of bundled samples.
@MainActor
final class DocumentStore: ObservableObject {
    struct Sample: Identifiable, Hashable {
        let id = UUID()
        let title: String
        let resource: String
    }

    static let samples = [
        Sample(title: "Hello World", resource: "sample"),
        Sample(title: "Text Form", resource: "form"),
        Sample(title: "Checkboxes", resource: "checkboxes"),
        Sample(title: "Dropdowns", resource: "dropdowns"),
        Sample(title: "Annotated", resource: "annotated"),
        Sample(title: "Signed", resource: "signed"),
    ]

    @Published private(set) var document: PdfDocument?
    @Published private(set) var pageCount = 0
    @Published private(set) var title = "No document"
    @Published var error: String?

    func load(_ sample: Sample) async {
        guard let url = Bundle.main.url(forResource: sample.resource, withExtension: "pdf") else {
            error = "Bundled resource \(sample.resource).pdf is missing"
            return
        }
        await load(url: url, title: sample.title)
    }

    func load(url: URL, title: String) async {
        do {
            let needsScope = url.startAccessingSecurityScopedResource()
            defer { if needsScope { url.stopAccessingSecurityScopedResource() } }

            let data = try Data(contentsOf: url)
            let document = try await PdfDocument(data: data)
            let count = await document.pageCount

            if let previous = self.document { await previous.close() }
            self.document = document
            self.pageCount = count
            self.title = title
            self.error = nil
        } catch let error as PdfError {
            self.error = error.description
        } catch {
            self.error = error.localizedDescription
        }
    }
}
