import Foundation
import CPdfium

/// Fields every form field carries.
public struct PdfFormFieldBase: Equatable, Sendable {
    public let pageIndex: Int
    /// Index of the widget annotation backing this field.
    public let annotationIndex: Int
    public let name: String?
    public let alternateName: String?
    public let rect: PdfRect
    public let flags: PdfFormFieldFlags

    public var isReadOnly: Bool { flags.contains(.readOnly) }
    public var isRequired: Bool { flags.contains(.required) }
}

/// An interactive form field, as a snapshot.
public enum PdfFormField: Equatable, Sendable {
    public struct Text: Equatable, Sendable {
        public let base: PdfFormFieldBase
        public let value: String
        public let isMultiline: Bool
        public let isPassword: Bool
    }
    public struct Toggle: Equatable, Sendable {
        public let base: PdfFormFieldBase
        public let isChecked: Bool
        public let exportValue: String?
    }
    public struct Choice: Equatable, Sendable {
        public let base: PdfFormFieldBase
        public let value: String
        public let options: [String]
        public let selectedIndices: [Int]
    }
    public struct Button: Equatable, Sendable {
        public let base: PdfFormFieldBase
    }
    public struct Other: Equatable, Sendable {
        public let base: PdfFormFieldBase
        public let typeCode: Int
    }

    case text(Text)
    case checkBox(Toggle)
    case radioButton(Toggle)
    case comboBox(Choice)
    case listBox(Choice)
    case pushButton(Button)
    case signature(Button)
    /// A field type this SDK does not model.
    case unknown(Other)

    public var base: PdfFormFieldBase {
        switch self {
        case .text(let f): return f.base
        case .checkBox(let f), .radioButton(let f): return f.base
        case .comboBox(let f), .listBox(let f): return f.base
        case .pushButton(let f), .signature(let f): return f.base
        case .unknown(let f): return f.base
        }
    }
}

extension PdfPage {
    /// Every interactive form field on this page.
    public func formFields() async throws -> [PdfFormField] {
        try await document.formFields(pageIndex: index)
    }

    /// Sets a text field's value.
    public func setText(_ value: String, forFieldAt annotationIndex: Int) async throws {
        try await document.setFormText(pageIndex: index, annotationIndex: annotationIndex, value: value)
    }

    /// Toggles a checkbox or radio button.
    public func toggleField(at annotationIndex: Int) async throws {
        try await document.toggleFormField(pageIndex: index, annotationIndex: annotationIndex)
    }

    /// Sets a checkbox or radio button to an explicit state.
    public func setChecked(_ checked: Bool, forFieldAt annotationIndex: Int) async throws {
        try await document.setFormChecked(pageIndex: index, annotationIndex: annotationIndex, checked: checked)
    }

    /// Selects or deselects one option of a combo or list box.
    public func setOption(_ optionIndex: Int, selected: Bool, forFieldAt annotationIndex: Int) async throws {
        try await document.setFormOption(pageIndex: index, annotationIndex: annotationIndex,
                                         optionIndex: optionIndex, selected: selected)
    }
}

extension PdfDocument {
    func formFields(pageIndex: Int) throws -> [PdfFormField] {
        guard let form else { return [] }
        let page = try loadedPage(pageIndex)
        let count = Int(FPDFPage_GetAnnotCount(page))
        var fields: [PdfFormField] = []

        for i in 0..<max(0, count) {
            guard let annot = FPDFPage_GetAnnot(page, Int32(i)) else { continue }
            defer { FPDFPage_CloseAnnot(annot) }
            guard FPDFAnnot_GetSubtype(annot) == FPDF_ANNOT_WIDGET else { continue }
            fields.append(field(annot, form: form, pageIndex: pageIndex, annotationIndex: i))
        }
        return fields
    }

    private func field(_ annot: FPDF_ANNOTATION, form: FPDF_FORMHANDLE,
                       pageIndex: Int, annotationIndex: Int) -> PdfFormField {
        var rect = FS_RECTF()
        FPDFAnnot_GetRect(annot, &rect)
        let rawFlags = Int(FPDFAnnot_GetFormFieldFlags(form, annot))
        let base = PdfFormFieldBase(
            pageIndex: pageIndex,
            annotationIndex: annotationIndex,
            name: widgetString(annot, form: form, FPDFAnnot_GetFormFieldName),
            alternateName: widgetString(annot, form: form, FPDFAnnot_GetFormFieldAlternateName),
            rect: PdfRect(left: Double(rect.left), bottom: Double(rect.bottom),
                          right: Double(rect.right), top: Double(rect.top)),
            flags: PdfFormFieldFlags(rawValue: rawFlags)
        )
        let value = widgetString(annot, form: form, FPDFAnnot_GetFormFieldValue) ?? ""

        switch FPDFAnnot_GetFormFieldType(form, annot) {
        case FPDF_FORMFIELD_TEXTFIELD:
            return .text(.init(base: base, value: value,
                               isMultiline: base.flags.contains(.multiline),
                               isPassword: base.flags.contains(.password)))
        case FPDF_FORMFIELD_CHECKBOX:
            return .checkBox(.init(base: base, isChecked: FPDFAnnot_IsChecked(form, annot) != 0,
                                   exportValue: widgetString(annot, form: form, FPDFAnnot_GetFormFieldExportValue)))
        case FPDF_FORMFIELD_RADIOBUTTON:
            return .radioButton(.init(base: base, isChecked: FPDFAnnot_IsChecked(form, annot) != 0,
                                      exportValue: widgetString(annot, form: form, FPDFAnnot_GetFormFieldExportValue)))
        case FPDF_FORMFIELD_COMBOBOX:
            let (options, selected) = choices(annot, form: form)
            return .comboBox(.init(base: base, value: value, options: options, selectedIndices: selected))
        case FPDF_FORMFIELD_LISTBOX:
            let (options, selected) = choices(annot, form: form)
            return .listBox(.init(base: base, value: value, options: options, selectedIndices: selected))
        case FPDF_FORMFIELD_PUSHBUTTON:
            return .pushButton(.init(base: base))
        case FPDF_FORMFIELD_SIGNATURE:
            return .signature(.init(base: base))
        case let other:
            return .unknown(.init(base: base, typeCode: Int(other)))
        }
    }

    private func choices(_ annot: FPDF_ANNOTATION, form: FPDF_FORMHANDLE) -> ([String], [Int]) {
        let count = Int(FPDFAnnot_GetOptionCount(form, annot))
        var options: [String] = []
        var selected: [Int] = []
        for i in 0..<max(0, count) {
            let byteCount = FPDFAnnot_GetOptionLabel(form, annot, Int32(i), nil, 0)
            if byteCount > 2 {
                var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
                FPDFAnnot_GetOptionLabel(form, annot, Int32(i), &buffer, byteCount)
                options.append(String(decoding: buffer.dropLast(), as: UTF16.self))
            } else {
                options.append("")
            }
            if FPDFAnnot_IsOptionSelected(form, annot, Int32(i)) != 0 { selected.append(i) }
        }
        return (options, selected)
    }

    private func widgetString(_ annot: FPDF_ANNOTATION, form: FPDF_FORMHANDLE,
                              _ getter: (FPDF_FORMHANDLE?, FPDF_ANNOTATION?, UnsafeMutablePointer<UInt16>?, UInt) -> UInt) -> String? {
        let byteCount = getter(form, annot, nil, 0)
        guard byteCount > 2 else { return nil }
        var buffer = [UInt16](repeating: 0, count: Int(byteCount) / 2)
        _ = getter(form, annot, &buffer, byteCount)
        let text = String(decoding: buffer.dropLast(), as: UTF16.self)
        return text.isEmpty ? nil : text
    }

    // MARK: - Interaction

    /// PDFium applies text edits through the focused-widget path, so focus first,
    /// select everything, then replace.
    func setFormText(pageIndex: Int, annotationIndex: Int, value: String) throws {
        guard let form else { throw PdfError.invalidOperation(reason: "document has no form") }
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(annotationIndex)) else {
            throw PdfError.pageOutOfRange(annotationIndex, count: Int(FPDFPage_GetAnnotCount(page)))
        }
        defer { FPDFPage_CloseAnnot(annot) }

        guard FORM_SetFocusedAnnot(form, annot) != 0 else {
            throw PdfError.invalidOperation(reason: "field could not take focus")
        }
        FORM_SelectAllText(form, page)
        var text = Array(value.utf16) + [0]
        FORM_ReplaceSelection(form, page, &text)
        FORM_ForceToKillFocus(form)
    }

    /// Sets a checkbox or radio button's state.
    ///
    /// PDFium's synthetic-click path needs FFI callbacks this SDK does not install, so
    /// this writes the field value (`V`) and appearance state (`AS`) directly, which is
    /// the PDF data model rather than a simulated interaction.
    func setFormChecked(pageIndex: Int, annotationIndex: Int, checked: Bool) throws {
        guard let form else { throw PdfError.invalidOperation(reason: "document has no form") }
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(annotationIndex)) else {
            throw PdfError.pageOutOfRange(annotationIndex, count: Int(FPDFPage_GetAnnotCount(page)))
        }
        defer { FPDFPage_CloseAnnot(annot) }

        let onValue = widgetString(annot, form: form, FPDFAnnot_GetFormFieldExportValue) ?? "Yes"
        let target = checked ? onValue : "Off"

        var value = Array(target.utf16) + [0]
        guard FPDFAnnot_SetStringValue(annot, "V", &value) != 0,
              FPDFAnnot_SetStringValue(annot, "AS", &value) != 0 else {
            throw PdfError.invalidOperation(reason: "field state could not be set")
        }
        FPDFPage_GenerateContent(page)
    }

    func toggleFormField(pageIndex: Int, annotationIndex: Int) throws {
        guard let form else { throw PdfError.invalidOperation(reason: "document has no form") }
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(annotationIndex)) else {
            throw PdfError.pageOutOfRange(annotationIndex, count: Int(FPDFPage_GetAnnotCount(page)))
        }
        let current = FPDFAnnot_IsChecked(form, annot) != 0
        FPDFPage_CloseAnnot(annot)
        try setFormChecked(pageIndex: pageIndex, annotationIndex: annotationIndex, checked: !current)
    }

    func setFormOption(pageIndex: Int, annotationIndex: Int, optionIndex: Int, selected: Bool) throws {
        guard let form else { throw PdfError.invalidOperation(reason: "document has no form") }
        let page = try loadedPage(pageIndex)
        guard let annot = FPDFPage_GetAnnot(page, Int32(annotationIndex)) else {
            throw PdfError.pageOutOfRange(annotationIndex, count: Int(FPDFPage_GetAnnotCount(page)))
        }
        defer { FPDFPage_CloseAnnot(annot) }

        guard FORM_SetFocusedAnnot(form, annot) != 0 else {
            throw PdfError.invalidOperation(reason: "field could not take focus")
        }
        guard FORM_SetIndexSelected(form, page, Int32(optionIndex), selected ? 1 : 0) != 0 else {
            throw PdfError.invalidOperation(reason: "option \(optionIndex) could not be selected")
        }
        FORM_ForceToKillFocus(form)
    }
}
