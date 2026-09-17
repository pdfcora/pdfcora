import SwiftUI

@main
struct PDFCoraDemoApp: App {
    @StateObject private var store = DocumentStore()

    var body: some Scene {
        WindowGroup {
            // UI tests can open one screen on its own (`-PDFCoraScreen "Accessible Content"`), so an
            // accessibility audit sees that screen and not the list behind it.
            if let name = UserDefaults.standard.string(forKey: "PDFCoraScreen"), let demo = Demo(rawValue: name) {
                SingleScreen(demo: demo).environmentObject(store)
            } else {
                RootView().environmentObject(store)
            }
        }
    }
}

private struct SingleScreen: View {
    let demo: Demo
    @EnvironmentObject private var store: DocumentStore

    var body: some View {
        NavigationView {
            if store.document != nil { RootView.screen(for: demo) } else { ProgressView() }
        }
        .navigationViewStyle(.stack)
        .task { if store.document == nil { await store.load(DocumentStore.samples[0]) } }
    }
}
