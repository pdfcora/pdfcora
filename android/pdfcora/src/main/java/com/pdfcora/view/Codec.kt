package com.pdfcora.view

import com.pdfcora.PdfColor
import com.pdfcora.PdfPageRotation
import com.pdfcora.PdfQuad
import com.pdfcora.PdfRedactionTarget
import com.pdfcora.PdfPoint
import com.pdfcora.PdfRect
import org.json.JSONArray
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
            is PdfViewChange.Edit ->
                JSONObject().put("kind", "edit").put("edit", encodeEdit(change.edit))
        })
        event.documentFingerprint?.let { put("documentFingerprint", it) }
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
                "edit" -> PdfViewChange.Edit(decodeEdit(change.getJSONObject("edit")))
                else -> throw PdfViewCodecException("unknown change kind $kind")
            },
            documentFingerprint = raw.optString("documentFingerprint").ifEmpty { null },
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

    private fun rect(r: PdfRect) = JSONObject()
        .put("left", r.left.toDouble()).put("bottom", r.bottom.toDouble())
        .put("right", r.right.toDouble()).put("top", r.top.toDouble())

    private fun rect(o: JSONObject) = PdfRect(
        o.getDouble("left").toFloat(), o.getDouble("bottom").toFloat(),
        o.getDouble("right").toFloat(), o.getDouble("top").toFloat(),
    )

    private fun colour(c: PdfColor) = JSONObject()
        .put("red", c.red).put("green", c.green).put("blue", c.blue).put("alpha", c.alpha)

    private fun colour(o: JSONObject) = PdfColor(
        o.getInt("red"), o.getInt("green"), o.getInt("blue"), o.optInt("alpha", 255),
    )

    private fun point(p: PdfPoint) = JSONObject().put("x", p.x.toDouble()).put("y", p.y.toDouble())
    private fun point(o: JSONObject) = PdfPoint(o.getDouble("x").toFloat(), o.getDouble("y").toFloat())

    private fun <T> JSONArray.map(transform: (JSONObject) -> T): List<T> =
        (0 until length()).map { transform(getJSONObject(it)) }

    fun encodeEdit(edit: PdfEdit): JSONObject = when (edit) {
        is PdfEdit.NoteAdded -> JSONObject()
            .put("kind", "noteAdded").put("page", edit.page).put("rect", rect(edit.rect))
            .put("contents", edit.contents).put("color", colour(edit.color))
        is PdfEdit.InkAdded -> JSONObject()
            .put("kind", "inkAdded").put("page", edit.page)
            .put("strokes", JSONArray(edit.strokes.map { stroke -> JSONArray(stroke.map { point(it) }) }))
            .put("color", colour(edit.color)).put("lineWidth", edit.lineWidth.toDouble())
        is PdfEdit.HighlightAdded -> JSONObject()
            .put("kind", "highlightAdded").put("page", edit.page).put("color", colour(edit.color))
            .put("quads", JSONArray(edit.quads.map {
                JSONObject().put("p1", point(it.p1)).put("p2", point(it.p2))
                    .put("p3", point(it.p3)).put("p4", point(it.p4))
            }))
        is PdfEdit.AnnotationRemoved -> JSONObject()
            .put("kind", "annotationRemoved").put("page", edit.page).put("index", edit.index)
        is PdfEdit.FieldTextSet -> JSONObject()
            .put("kind", "fieldTextSet").put("page", edit.page)
            .put("annotationIndex", edit.annotationIndex).put("value", edit.value)
        is PdfEdit.FieldCheckedSet -> JSONObject()
            .put("kind", "fieldCheckedSet").put("page", edit.page)
            .put("annotationIndex", edit.annotationIndex).put("checked", edit.checked)
        is PdfEdit.FieldOptionSet -> JSONObject()
            .put("kind", "fieldOptionSet").put("page", edit.page)
            .put("annotationIndex", edit.annotationIndex)
            .put("option", edit.option).put("selected", edit.selected)
        is PdfEdit.Redacted -> JSONObject()
            .put("kind", "redacted")
            .put("targets", JSONArray(edit.targets.map { target ->
                when (target) {
                    is PdfRedactionTarget.Region -> JSONObject()
                        .put("kind", "region").put("pageIndex", target.pageIndex)
                        .put("rect", rect(target.rect))
                    is PdfRedactionTarget.TextMatches -> JSONObject()
                        .put("kind", "textMatches").put("query", target.query)
                }
            }))
    }

    fun decodeEdit(raw: JSONObject): PdfEdit {
        val page = raw.optInt("page", 0)
        return when (val kind = raw.getString("kind")) {
            "noteAdded" -> PdfEdit.NoteAdded(page, rect(raw.getJSONObject("rect")),
                                             raw.getString("contents"), colour(raw.getJSONObject("color")))
            "inkAdded" -> PdfEdit.InkAdded(
                page, raw.getJSONArray("strokes").let { strokes ->
                    (0 until strokes.length()).map { strokes.getJSONArray(it).map { point(it) } }
                },
                colour(raw.getJSONObject("color")), raw.getDouble("lineWidth").toFloat(),
            )
            "highlightAdded" -> PdfEdit.HighlightAdded(
                page,
                raw.getJSONArray("quads").map {
                    PdfQuad(point(it.getJSONObject("p1")), point(it.getJSONObject("p2")),
                            point(it.getJSONObject("p3")), point(it.getJSONObject("p4")))
                },
                colour(raw.getJSONObject("color")),
            )
            "annotationRemoved" -> PdfEdit.AnnotationRemoved(page, raw.getInt("index"))
            "fieldTextSet" -> PdfEdit.FieldTextSet(page, raw.getInt("annotationIndex"), raw.getString("value"))
            "fieldCheckedSet" -> PdfEdit.FieldCheckedSet(page, raw.getInt("annotationIndex"), raw.getBoolean("checked"))
            "fieldOptionSet" -> PdfEdit.FieldOptionSet(page, raw.getInt("annotationIndex"),
                                                       raw.getInt("option"), raw.getBoolean("selected"))
            "redacted" -> PdfEdit.Redacted(raw.getJSONArray("targets").map { t ->
                when (val targetKind = t.getString("kind")) {
                    "region" -> PdfRedactionTarget.Region(rect(t.getJSONObject("rect")), t.optInt("pageIndex"))
                    "textMatches" -> PdfRedactionTarget.TextMatches(t.getString("query"))
                    else -> throw PdfViewCodecException("unknown redaction target $targetKind")
                }
            })
            else -> throw PdfViewCodecException("unknown edit kind $kind")
        }
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
