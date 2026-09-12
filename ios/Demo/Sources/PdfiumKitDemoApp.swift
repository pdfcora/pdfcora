import SwiftUI

@main
struct PdfiumKitDemoApp: App {
    @StateObject private var store = DocumentStore()

    var body: some Scene {
        WindowGroup {
            RootView().environmentObject(store)
        }
    }
}
