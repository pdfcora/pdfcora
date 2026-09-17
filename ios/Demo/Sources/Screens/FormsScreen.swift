import SwiftUI
import PDFCora

struct FormsScreen: View {
    @EnvironmentObject private var store: DocumentStore
    @State private var fields: [PdfFormField] = []
    @State private var drafts: [Int: String] = [:]
    @State private var preview: UIImage?

    var body: some View {
        Form {
            if fields.isEmpty {
                Text("This document has no interactive form fields.").foregroundColor(.secondary)
            }
            ForEach(Array(fields.enumerated()), id: \.offset) { _, field in
                row(for: field)
            }
            if let preview {
                Section("Rendered") { Image(uiImage: preview).resizable().scaledToFit() }
            }
        }
        .navigationTitle("Forms")
        .task { await reload() }
    }

    /// Each field type gets the control that suits it — the point of the sealed hierarchy.
    @ViewBuilder
    private func row(for field: PdfFormField) -> some View {
        let index = field.base.annotationIndex
        let name = field.base.name ?? field.base.alternateName ?? "field \(index)"

        switch field {
        case .text(let f):
            HStack {
                Text(name)
                Spacer()
                TextField("value", text: Binding(
                    get: { drafts[index] ?? f.value },
                    set: { drafts[index] = $0 }
                ))
                .multilineTextAlignment(.trailing)
                .onSubmit { Task { await commit(index) } }
            }
        case .checkBox(let f), .radioButton(let f):
            Toggle(name, isOn: Binding(
                get: { f.isChecked },
                set: { newValue in Task { await setChecked(index, newValue) } }
            ))
        case .comboBox(let f), .listBox(let f):
            VStack(alignment: .leading) {
                Text(name)
                Picker(name, selection: Binding(
                    get: { f.selectedIndices.first ?? 0 },
                    set: { newValue in Task { await select(index, newValue) } }
                )) {
                    ForEach(Array(f.options.enumerated()), id: \.offset) { i, option in
                        Text(option.isEmpty ? "(blank)" : option).tag(i)
                    }
                }
                .pickerStyle(.menu)
            }
        case .pushButton:
            HStack { Text(name); Spacer(); Text("button").foregroundColor(.secondary) }
        case .signature:
            HStack { Text(name); Spacer(); Text("signature").foregroundColor(.secondary) }
        case .unknown(let f):
            HStack { Text(name); Spacer(); Text("type \(f.typeCode)").foregroundColor(.secondary) }
        }
    }

    private func commit(_ index: Int) async {
        guard let page = try? await store.document?.page(0), let value = drafts[index] else { return }
        try? await page.setText(value, forFieldAt: index)
        await reload()
    }

    private func setChecked(_ index: Int, _ checked: Bool) async {
        guard let page = try? await store.document?.page(0) else { return }
        try? await page.setChecked(checked, forFieldAt: index)
        await reload()
    }

    private func select(_ index: Int, _ option: Int) async {
        guard let page = try? await store.document?.page(0) else { return }
        try? await page.setOption(option, selected: true, forFieldAt: index)
        await reload()
    }

    private func reload() async {
        guard let document = store.document, let page = try? await document.page(0) else { return }
        fields = (try? await page.formFields()) ?? []
        drafts.removeAll()
        preview = try? await page.render(width: 600, options: [.annotations, .forms])
    }
}
