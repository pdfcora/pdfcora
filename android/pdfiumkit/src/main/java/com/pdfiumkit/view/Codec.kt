package com.pdfiumkit.view

import com.pdfiumkit.PdfPageRotation
import com.pdfiumkit.PdfPoint
import com.pdfiumkit.PdfRect
import org.json.JSONObject

class PdfViewCodecException(message: String) : IllegalArgumentException(message)

/**
 * The JSON encoding shared with the iOS and web SDKs.
 *
 * `conformance/view-state.json` is the artefact all three agree against.
 */
object PdfViewCodec {
    /**
     * Bumped when the shape changes incompatibly. Every envelope carries it and the
     * decoder insists on it, so an older peer fails loudly rather than misreading a
     * newer message as though it understood it.
     */
    const val WIRE_VERSION = 1

    /**
     * PDFium — and so this SDK — holds rotation as a quarter-turn index 0..3. The wire
     * carries degrees, which is self-describing and what the web SDK's type already is.
     * A platform that wrote the index would send 1 where a peer expects 90.
     */
    fun degrees(rotation: PdfPageRotation): Int = rotation.raw * 90

    fun rotationFromDegrees(degrees: Int): PdfPageRotation =
        PdfPageRotation.fromRaw(((degrees % 360) + 360) % 360 / 90)

    fun encode(event: PdfViewEvent): String = JSONObject().apply {
        put("v", WIRE_VERSION)
        put("sequence", event.sequence)
        put("sessionId", event.sessionId)
        put("origin", event.origin.wire)
        put("change", when (val change = event.change) {
            is PdfViewChange.Viewport ->
                JSONObject().put("kind", "viewport").put("state", encodeState(change.state))
            is PdfViewChange.Selection ->
                JSONObject().put("kind", "selection")
                    .put("selection", change.selection?.let { encodeSelection(it) } ?: JSONObject.NULL)
            is PdfViewChange.Tool ->
                JSONObject().put("kind", "tool").put("tool", change.tool.wire)
        })
    }.toString()

    fun decode(wire: String): PdfViewEvent {
        val raw = JSONObject(wire)
        if (!raw.has("v") || raw.getInt("v") != WIRE_VERSION) {
            throw PdfViewCodecException(
                "unsupported view event version ${raw.opt("v")}, expected $WIRE_VERSION",
            )
        }
        val change = raw.getJSONObject("change")
        return PdfViewEvent(
            sequence = raw.getInt("sequence"),
            sessionId = raw.getString("sessionId"),
            origin = PdfViewEventOrigin.fromWire(raw.getString("origin"))
                ?: throw PdfViewCodecException("unknown origin"),
            change = when (val kind = change.getString("kind")) {
                "viewport" -> PdfViewChange.Viewport(decodeState(change.getJSONObject("state")))
                "selection" -> PdfViewChange.Selection(
                    change.optJSONObject("selection")?.let { decodeSelection(it) },
                )
                "tool" -> PdfViewChange.Tool(
                    PdfTool.fromWire(change.getString("tool"))
                        ?: throw PdfViewCodecException("unknown tool"),
                )
                else -> throw PdfViewCodecException("unknown change kind $kind")
            },
        )
    }

    fun encodeState(state: PdfViewState): JSONObject = JSONObject().apply {
        put("pageIndex", state.pageIndex)
        put("center", JSONObject().put("x", state.center.x.toDouble()).put("y", state.center.y.toDouble()))
        put("zoom", JSONObject().put("scale", state.zoom.scale.toDouble()).put("mode", state.zoom.mode.wire))
        put("rotation", degrees(state.rotation))
        put("layout", state.layout.wire)
    }

    fun decodeState(raw: JSONObject): PdfViewState {
        val centre = raw.getJSONObject("center")
        val zoom = raw.getJSONObject("zoom")
        return PdfViewState(
            pageIndex = raw.getInt("pageIndex"),
            center = PdfPoint(centre.getDouble("x").toFloat(), centre.getDouble("y").toFloat()),
            zoom = PdfZoom(
                zoom.getDouble("scale").toFloat(),
                PdfZoomMode.fromWire(zoom.getString("mode"))
                    ?: throw PdfViewCodecException("unknown zoom mode"),
            ),
            rotation = rotationFromDegrees(raw.getInt("rotation")),
            layout = PdfPageLayout.fromWire(raw.getString("layout"))
                ?: throw PdfViewCodecException("unknown layout"),
        )
    }

    private fun encodeSelection(selection: PdfSelection): JSONObject = when (selection) {
        is PdfSelection.Region -> JSONObject()
            .put("kind", "region").put("page", selection.page)
            .put("rect", JSONObject()
                .put("left", selection.rect.left.toDouble())
                .put("bottom", selection.rect.bottom.toDouble())
                .put("right", selection.rect.right.toDouble())
                .put("top", selection.rect.top.toDouble()))
        is PdfSelection.Annotation -> JSONObject()
            .put("kind", "annotation").put("page", selection.page).put("index", selection.index)
    }

    private fun decodeSelection(raw: JSONObject): PdfSelection = when (val kind = raw.getString("kind")) {
        "region" -> {
            val r = raw.getJSONObject("rect")
            PdfSelection.Region(
                raw.getInt("page"),
                PdfRect(
                    r.getDouble("left").toFloat(), r.getDouble("bottom").toFloat(),
                    r.getDouble("right").toFloat(), r.getDouble("top").toFloat(),
                ),
            )
        }
        "annotation" -> PdfSelection.Annotation(raw.getInt("page"), raw.getInt("index"))
        else -> throw PdfViewCodecException("unknown selection kind $kind")
    }
}
