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
        switch event.change {
        case .viewport(let state):
            root["change"] = ["kind": "viewport", "state": object(from: state)]
        case .selection(let selection):
            root["change"] = ["kind": "selection", "selection": selection.map(object(from:)) as Any]
        case .tool(let tool):
            root["change"] = ["kind": "tool", "tool": tool.rawValue]
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
