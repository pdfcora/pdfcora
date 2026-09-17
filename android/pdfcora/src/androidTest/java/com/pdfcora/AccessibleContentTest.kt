package com.pdfcora

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.junit.Assert.*
import org.junit.Test
import org.junit.runner.RunWith

/** Mirrors `web/test/accessible.test.ts` and `ios/Tests/PDFCoraTests/AccessibleContentTests.swift`. */
@RunWith(AndroidJUnit4::class)
class AccessibleContentTest {
    private fun asset(path: String) =
        InstrumentationRegistry.getInstrumentation().context.assets.open(path).use { it.readBytes() }

    private fun brief(nodes: List<PdfAccessibleNode>): List<String> = nodes.map {
        val role = it.role.name.lowercase().split('_').mapIndexed { i, w -> if (i == 0) w else w.replaceFirstChar { c -> c.uppercase() } }.joinToString("")
        if (it.children.isEmpty()) "$role${it.level ?: ""}:${it.text}" else "$role[${brief(it.children).joinToString("|")}]"
    }

    @Test fun aTaggedPageReadsInOrder() = runBlocking {
        val document = PdfDocument.open(asset("alt-text/tagged.pdf"))
        assertEquals(listOf(
            "heading1:Annual report 2026",
            "paragraph:Revenue grew in every region this year.",
            "figure:Bar chart of revenue by region",
            "paragraph:Figure 1: Revenue by region.",
            "figure:",
            "paragraph:Figure 2: The new office building in Berlin at dusk.",
            "figure:",
            "paragraph:Staff numbers rose to 120 people.",
        ), brief(document.page(0).accessibleContent()))
        assertEquals(2, document.page(1).accessibleContent().first().level)
    }

    @Test fun listsNestTheirItems() = runBlocking {
        val json = JSONArray(asset("remediation/untagged-expected.json").decodeToString())
        val next = mutableMapOf<Int, Int>()
        val blocks = (0 until json.length()).map { i ->
            val b = json.getJSONObject(i)
            val page = b.getInt("pageIndex")
            val start = next[page] ?: 0
            next[page] = start + b.getInt("objectCount")
            PdfTagBlock(page, PdfTagType.values().first { it.tag == b.getString("type") }, (start until start + b.getInt("objectCount")).toList())
        }
        val tagged = PdfDocument.open(asset("remediation/untagged.pdf")).tagContent(blocks, "T", "en")
        assertEquals(listOf(
            "heading1:Quarterly newsletter",
            "paragraph:Welcome to the autumn issue. This quarter we opened two offices and welcomed forty new colleagues.",
            "heading2:Highlights",
            "list[listItem:• A new office in Berlin|listItem:• A new office in Madrid|listItem:• The staff survey results]",
            "paragraph:The photo below shows the Berlin office.",
        ), brief(tagged.page(0).accessibleContent()).take(5))
    }

    @Test fun anUntaggedPageIsOneParagraphAndFormFieldsFollow() = runBlocking {
        val hello = PdfDocument.open(asset("corpus/hello_world.pdf")).page(0).accessibleContent()
        assertEquals(1, hello.size)
        assertEquals(PdfAccessibleNode.Role.PARAGRAPH, hello[0].role)
        assertTrue(hello[0].text.contains("Hello, world!"))
        val form = PdfDocument.open(asset("corpus/text_form.pdf")).page(0).accessibleContent()
        assertEquals(listOf("Text Box"), form.filter { it.role == PdfAccessibleNode.Role.FORM_FIELD }.map { it.text })
    }
}
