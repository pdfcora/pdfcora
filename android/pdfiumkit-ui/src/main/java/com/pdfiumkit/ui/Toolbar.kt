package com.pdfiumkit.ui

import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.*
import com.pdfiumkit.view.PdfTool

/**
 * One control in the viewer's toolbar.
 *
 * Built-ins are identical on every platform. [custom] is **platform-native on purpose**:
 * an icon is an `ImageVector` here, an SF Symbol on Apple and an SVG on the web, and a
 * cross-platform icon type would be a lowest common denominator that satisfies none of
 * them.
 */
sealed class PdfToolbarItem(val id: String, val label: String) {
    class Tool(val tool: PdfTool) : PdfToolbarItem("tool-${tool.wire}", tool.label)
    object Undo : PdfToolbarItem("editor-undo", "Undo")
    object DeleteSelection : PdfToolbarItem("editor-delete", "Delete")
    object ZoomOut : PdfToolbarItem("zoom-out", "Zoom out")
    object ZoomIn : PdfToolbarItem("zoom-in", "Zoom in")
    object FitWidth : PdfToolbarItem("zoom-fit", "Fit")
    object PageBack : PdfToolbarItem("page-back", "Previous page")
    object PageForward : PdfToolbarItem("page-forward", "Next page")
    object Save : PdfToolbarItem("editor-save", "Save")
    object Spacer : PdfToolbarItem("spacer", "")
    object Divider : PdfToolbarItem("divider", "")

    /** An app-defined button. */
    class Custom(
        id: String,
        label: String,
        val image: ImageVector,
        val action: () -> Unit,
    ) : PdfToolbarItem(id, label)

    val icon: ImageVector
        get() = when (this) {
            is Tool -> when (tool) {
                PdfTool.SELECT -> Icons.Filled.TouchApp
                PdfTool.INK -> Icons.Filled.Gesture
                PdfTool.NOTE -> Icons.Filled.StickyNote2
                PdfTool.HIGHLIGHT -> Icons.Filled.Highlight
                PdfTool.REDACT -> Icons.Filled.HideImage
            }
            Undo -> Icons.Filled.Undo
            DeleteSelection -> Icons.Filled.Delete
            ZoomOut -> Icons.Filled.ZoomOut
            ZoomIn -> Icons.Filled.ZoomIn
            FitWidth -> Icons.Filled.FitScreen
            PageBack -> Icons.Filled.ChevronLeft
            PageForward -> Icons.Filled.ChevronRight
            Save -> Icons.Filled.Save
            is Custom -> image
            Spacer, Divider -> Icons.Filled.MoreHoriz
        }
}

data class PdfToolbarConfiguration(val items: List<PdfToolbarItem>) {
    companion object {
        val Default = PdfToolbarConfiguration(listOf(
            PdfToolbarItem.Tool(PdfTool.SELECT), PdfToolbarItem.Tool(PdfTool.INK),
            PdfToolbarItem.Tool(PdfTool.NOTE), PdfToolbarItem.Tool(PdfTool.HIGHLIGHT),
            PdfToolbarItem.Tool(PdfTool.REDACT),
            PdfToolbarItem.Divider, PdfToolbarItem.Undo, PdfToolbarItem.DeleteSelection,
            PdfToolbarItem.Spacer,
            PdfToolbarItem.ZoomOut, PdfToolbarItem.FitWidth, PdfToolbarItem.ZoomIn,
            PdfToolbarItem.Divider, PdfToolbarItem.Save,
        ))

        /** Viewing only: no tools, no save. */
        val Viewing = PdfToolbarConfiguration(listOf(
            PdfToolbarItem.PageBack, PdfToolbarItem.PageForward, PdfToolbarItem.Spacer,
            PdfToolbarItem.ZoomOut, PdfToolbarItem.FitWidth, PdfToolbarItem.ZoomIn,
        ))
    }
}

private val PdfTool.label: String
    get() = name.lowercase().replaceFirstChar { it.uppercase() }
