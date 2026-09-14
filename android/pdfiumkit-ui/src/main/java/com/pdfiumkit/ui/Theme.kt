package com.pdfiumkit.ui

import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.sp

/**
 * How the viewer looks.
 *
 * Tokens are the tested path and mean the same thing on every platform. Compose
 * modifiers may be passed through as well, which is deliberately **outside** the
 * conformance contract: once used, cross-platform parity is the app's to maintain.
 */
data class PdfViewerTheme(
    val accent: Color = Color(0xFF0066CC),
    val background: Color = Color(0xFFFBFBFD),
    val pageBackground: Color = Color.White,
    val pageShadow: Color = Color.Black.copy(alpha = 0.18f),
    val toolbarBackground: Color = Color(0xFFEFEFF3),
    val toolbarForeground: Color = Color(0xFF1D1D1F),
    val selectionStroke: Color = Color(0xFFFF9500),
    val redactionFill: Color = Color.Black.copy(alpha = 0.72f),
    val cornerRadius: Dp = 7.dp,
    val iconSize: TextUnit = 17.sp,
    val toolbarHeight: Dp = 44.dp,
) {
    companion object {
        val Light = PdfViewerTheme()
        val Dark = PdfViewerTheme(
            background = Color(0xFF16161A),
            pageBackground = Color(0xFFEBEBEB),
            toolbarBackground = Color(0xFF26262B),
            toolbarForeground = Color(0xFFF2F2F7),
        )
    }
}
