import Foundation

/// The JSON encoding shared with the web and Android SDKs.
///
/// `conformance/view-state.json` is the artefact all three agree against.
public enum PdfViewCodec {
    /// Bumped when the shape changes incompatibly. Every envelope carries it and the
    /// decoder insists on it, so an older peer fails loudly rather than misreading a
    /// newer message as though it understood it.
    public static let wireVersion = 1

    public enum CodecError: Error, Equatable {
        case unsupportedVersion(Int?)
        case malformed(String)
    }

    public static func encode(_ event: PdfViewEvent) throws -> Data {
        try JSONSerialization.data(withJSONObject: object(from: event), options: [.sortedKeys])
    }

    public static func decode(_ data: Data) throws -> PdfViewEvent {
        guard let raw = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw CodecError.malformed("not an object")
        }
        guard let version = raw["v"] as? Int, version == wireVersion else {
            throw CodecError.unsupportedVersion(raw["v"] as? Int)
        }
        return try event(from: raw)
    }

    // MARK: - Rotation crosses the wire as degrees

    /// PDFium — and so this SDK — holds rotation as a quarter-turn index 0...3. The wire
    /// carries degrees, which is self-describing and what the web SDK's type already is.
    /// A platform that wrote the index would send 1 where a peer expects 90.
    static func degrees(_ rotation: PdfPageRotation) -> Int { rotation.rawValue * 90 }

    static func rotation(fromDegrees degrees: Int) -> PdfPageRotation {
        PdfPageRotation(rawValue: ((degrees % 360) + 360) % 360 / 90) ?? .none
    }

    // MARK: - Mapping

    private static func object(from event: PdfViewEvent) -> [String: Any] {
        var root: [String: Any] = [
            "v": wireVersion,
            "sequence": event.sequence,
            "sessionId": event.sessionId,
            "origin": event.origin.rawValue,
        ]
        if let fingerprint = event.documentFingerprint {
            root["documentFingerprint"] = fingerprint
        }
        switch event.change {
        case .viewport(let state):
            root["change"] = ["kind": "viewport", "state": object(from: state)]
        case .selection(let selection):
            root["change"] = ["kind": "selection", "selection": selection.map(object(from:)) as Any]
        case .tool(let tool):
            root["change"] = ["kind": "tool", "tool": tool.rawValue]
        case .edit(let edit):
            root["change"] = ["kind": "edit", "edit": object(from: edit)]
        }
        return root
    }

    private static func object(from state: PdfViewState) -> [String: Any] {
        [
            "pageIndex": state.pageIndex,
            "center": ["x": state.center.x, "y": state.center.y],
            "zoom": ["scale": state.zoom.scale, "mode": state.zoom.mode.rawValue],
            "rotation": degrees(state.rotation),
            "layout": state.layout.rawValue,
        ]
    }

    private static func object(from edit: PdfEdit) -> [String: Any] {
        func rect(_ r: PdfRect) -> [String: Any] {
            ["left": r.left, "bottom": r.bottom, "right": r.right, "top": r.top]
        }
        func colour(_ c: PdfColor) -> [String: Any] {
            ["red": Int(c.red), "green": Int(c.green), "blue": Int(c.blue), "alpha": Int(c.alpha)]
        }
        func point(_ p: PdfPoint) -> [String: Any] { ["x": p.x, "y": p.y] }

        switch edit {
        case .noteAdded(let page, let r, let contents, let c):
            return ["kind": "noteAdded", "page": page, "rect": rect(r),
                    "contents": contents, "color": colour(c)]
        case .inkAdded(let page, let strokes, let c, let lineWidth):
            return ["kind": "inkAdded", "page": page, "strokes": strokes.map { $0.map(point) },
                    "color": colour(c), "lineWidth": lineWidth]
        case .highlightAdded(let page, let quads, let c):
            return ["kind": "highlightAdded", "page": page, "color": colour(c),
                    "quads": quads.map { ["p1": point($0.p1), "p2": point($0.p2),
                                          "p3": point($0.p3), "p4": point($0.p4)] }]
        case .annotationRemoved(let page, let index):
            return ["kind": "annotationRemoved", "page": page, "index": index]
        case .fieldTextSet(let page, let annotationIndex, let value):
            return ["kind": "fieldTextSet", "page": page,
                    "annotationIndex": annotationIndex, "value": value]
        case .fieldCheckedSet(let page, let annotationIndex, let checked):
            return ["kind": "fieldCheckedSet", "page": page,
                    "annotationIndex": annotationIndex, "checked": checked]
        case .fieldOptionSet(let page, let annotationIndex, let option, let selected):
            return ["kind": "fieldOptionSet", "page": page, "annotationIndex": annotationIndex,
                    "option": option, "selected": selected]
        case .redacted(let targets):
            return ["kind": "redacted", "targets": targets.map { target -> [String: Any] in
                switch target {
                case .region(let r, let pageIndex):
                    return ["kind": "region", "pageIndex": pageIndex, "rect": rect(r)]
                case .textMatches(let query, _):
                    return ["kind": "textMatches", "query": query]
                }
            }]
        }
    }

    static func edit(from raw: [String: Any]) throws -> PdfEdit {
        func number(_ any: Any?) throws -> Double {
            guard let n = (any as? NSNumber)?.doubleValue else { throw CodecError.malformed("number") }
            return n
        }
        func rect(_ any: Any?) throws -> PdfRect {
            guard let r = any as? [String: Any] else { throw CodecError.malformed("rect") }
            return PdfRect(left: try number(r["left"]), bottom: try number(r["bottom"]),
                           right: try number(r["right"]), top: try number(r["top"]))
        }
        func colour(_ any: Any?) throws -> PdfColor {
            guard let c = any as? [String: Any] else { throw CodecError.malformed("color") }
            return PdfColor(red: UInt8(try number(c["red"])), green: UInt8(try number(c["green"])),
                            blue: UInt8(try number(c["blue"])),
                            alpha: UInt8(try number(c["alpha"] ?? 255)))
        }
        func point(_ any: Any) throws -> PdfPoint {
            guard let p = any as? [String: Any] else { throw CodecError.malformed("point") }
            return PdfPoint(x: try number(p["x"]), y: try number(p["y"]))
        }

        guard let kind = raw["kind"] as? String else { throw CodecError.malformed("edit kind") }
        let page = raw["page"] as? Int ?? 0

        switch kind {
        case "noteAdded":
            return .noteAdded(page: page, rect: try rect(raw["rect"]),
                              contents: raw["contents"] as? String ?? "",
                              color: try colour(raw["color"]))
        case "inkAdded":
            let strokes = try (raw["strokes"] as? [[Any]] ?? []).map { try $0.map(point) }
            return .inkAdded(page: page, strokes: strokes, color: try colour(raw["color"]),
                             lineWidth: try number(raw["lineWidth"]))
        case "highlightAdded":
            let quads = try (raw["quads"] as? [[String: Any]] ?? []).map { q in
                PdfQuad(p1: try point(q["p1"] as Any), p2: try point(q["p2"] as Any),
                        p3: try point(q["p3"] as Any), p4: try point(q["p4"] as Any))
            }
            return .highlightAdded(page: page, quads: quads, color: try colour(raw["color"]))
        case "annotationRemoved":
            return .annotationRemoved(page: page, index: raw["index"] as? Int ?? 0)
        case "fieldTextSet":
            return .fieldTextSet(page: page, annotationIndex: raw["annotationIndex"] as? Int ?? 0,
                                 value: raw["value"] as? String ?? "")
        case "fieldCheckedSet":
            return .fieldCheckedSet(page: page, annotationIndex: raw["annotationIndex"] as? Int ?? 0,
                                    checked: raw["checked"] as? Bool ?? false)
        case "fieldOptionSet":
            return .fieldOptionSet(page: page, annotationIndex: raw["annotationIndex"] as? Int ?? 0,
                                   option: raw["option"] as? Int ?? 0,
                                   selected: raw["selected"] as? Bool ?? false)
        case "redacted":
            let targets = try (raw["targets"] as? [[String: Any]] ?? []).map { t -> PdfRedactionTarget in
                switch t["kind"] as? String {
                case "region":
                    return .region(try rect(t["rect"]), pageIndex: t["pageIndex"] as? Int ?? 0)
                case "textMatches":
                    return .textMatches(t["query"] as? String ?? "")
                default:
                    throw CodecError.malformed("unknown redaction target")
                }
            }
            return .redacted(targets: targets)
        default:
            throw CodecError.malformed("unknown edit kind \(kind)")
        }
    }

    private static func object(from selection: PdfSelection) -> [String: Any] {
        switch selection {
        case .region(let page, let rect):
            return ["kind": "region", "page": page,
                    "rect": ["left": rect.left, "bottom": rect.bottom,
                             "right": rect.right, "top": rect.top]]
        case .annotation(let page, let index):
            return ["kind": "annotation", "page": page, "index": index]
        }
    }

    private static func event(from raw: [String: Any]) throws -> PdfViewEvent {
        guard let sequence = raw["sequence"] as? Int,
              let sessionId = raw["sessionId"] as? String,
              let originRaw = raw["origin"] as? String,
              let origin = PdfViewEventOrigin(rawValue: originRaw),
              let change = raw["change"] as? [String: Any],
              let kind = change["kind"] as? String
        else { throw CodecError.malformed("missing envelope fields") }

        switch kind {
        case "viewport":
            guard let stateRaw = change["state"] as? [String: Any] else {
                throw CodecError.malformed("viewport without state")
            }
            return PdfViewEvent(sequence: sequence, sessionId: sessionId, origin: origin,
                                change: .viewport(try state(from: stateRaw)))
        case "selection":
            let selectionRaw = change["selection"] as? [String: Any]
            return PdfViewEvent(sequence: sequence, sessionId: sessionId, origin: origin,
                                change: .selection(try selectionRaw.map(selection(from:))))
        case "tool":
            guard let toolRaw = change["tool"] as? String, let tool = PdfTool(rawValue: toolRaw) else {
                throw CodecError.malformed("unknown tool")
            }
            return PdfViewEvent(sequence: sequence, sessionId: sessionId, origin: origin,
                                change: .tool(tool))
        case "edit":
            guard let editRaw = change["edit"] as? [String: Any] else {
                throw CodecError.malformed("edit without a body")
            }
            return PdfViewEvent(sequence: sequence, sessionId: sessionId, origin: origin,
                                change: .edit(try edit(from: editRaw)),
                                documentFingerprint: raw["documentFingerprint"] as? String)
        default:
            throw CodecError.malformed("unknown change kind \(kind)")
        }
    }

    static func state(from raw: [String: Any]) throws -> PdfViewState {
        guard let pageIndex = raw["pageIndex"] as? Int,
              let centre = raw["center"] as? [String: Any],
              let x = (centre["x"] as? NSNumber)?.doubleValue,
              let y = (centre["y"] as? NSNumber)?.doubleValue,
              let zoomRaw = raw["zoom"] as? [String: Any],
              let scale = (zoomRaw["scale"] as? NSNumber)?.doubleValue,
              let modeRaw = zoomRaw["mode"] as? String,
              let mode = PdfZoomMode(rawValue: modeRaw),
              let rotationDegrees = raw["rotation"] as? Int,
              let layoutRaw = raw["layout"] as? String,
              let layout = PdfPageLayout(rawValue: layoutRaw)
        else { throw CodecError.malformed("bad view state") }

        return PdfViewState(pageIndex: pageIndex,
                            center: PdfPoint(x: x, y: y),
                            zoom: PdfZoom(scale: scale, mode: mode),
                            rotation: rotation(fromDegrees: rotationDegrees),
                            layout: layout)
    }

    private static func selection(from raw: [String: Any]) throws -> PdfSelection {
        guard let kind = raw["kind"] as? String, let page = raw["page"] as? Int else {
            throw CodecError.malformed("bad selection")
        }
        switch kind {
        case "region":
            guard let r = raw["rect"] as? [String: Any],
                  let left = (r["left"] as? NSNumber)?.doubleValue,
                  let bottom = (r["bottom"] as? NSNumber)?.doubleValue,
                  let right = (r["right"] as? NSNumber)?.doubleValue,
                  let top = (r["top"] as? NSNumber)?.doubleValue
            else { throw CodecError.malformed("bad region") }
            return .region(page: page, rect: PdfRect(left: left, bottom: bottom, right: right, top: top))
        case "annotation":
            guard let index = raw["index"] as? Int else { throw CodecError.malformed("bad annotation") }
            return .annotation(page: page, index: index)
        default:
            throw CodecError.malformed("unknown selection kind \(kind)")
        }
    }
}
