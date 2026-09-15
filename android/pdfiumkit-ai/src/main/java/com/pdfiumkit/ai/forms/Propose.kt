package com.pdfiumkit.ai.forms

import com.pdfiumkit.PdfDocument
import com.pdfiumkit.PdfDocumentSnapshot
import com.pdfiumkit.PdfFormField
import com.pdfiumkit.PdfRect
import com.pdfiumkit.ai.*
import com.pdfiumkit.setChecked
import com.pdfiumkit.setOption
import com.pdfiumkit.setText
import com.pdfiumkit.snapshot
import org.json.JSONArray
import org.json.JSONObject

const val FORM_NOTICE = "Check every value before filling in the form."

sealed interface PdfFormValue {
    data class Text(val text: String) : PdfFormValue
    data class Option(val index: Int) : PdfFormValue
    object Checked : PdfFormValue
}

data class PdfFormProposal(
    val id: String,
    val pageIndex: Int,
    val annotationIndex: Int,
    val fieldName: String?,
    val key: PdfProfileKey,
    val value: PdfFormValue,
    val source: PdfAiSource,
    val rect: PdfRect,
)

class PdfFormApplied internal constructor(private val snapshot: PdfDocumentSnapshot) {
    /** Reopens the document as it was before apply. */
    suspend fun undo(): PdfDocument = snapshot.open()
}

class PdfFormProposals internal constructor(
    val items: List<PdfFormProposal>,
    val modelUsed: Boolean,
    /** Must be shown with the proposals (HIL). */
    val notice: String,
    private val document: PdfDocument,
) {
    suspend fun apply(accepting: List<String>): PdfFormApplied {
        val known = items.map { it.id }.toSet()
        accepting.firstOrNull { it !in known }?.let { throw UnknownProposalException(it) }
        val snapshot = document.snapshot()
        for (p in items.filter { it.id in accepting }) {
            val page = document.page(p.pageIndex)
            when (val value = p.value) {
                is PdfFormValue.Text -> page.setText(value.text, p.annotationIndex)
                is PdfFormValue.Option -> page.setOption(value.index, true, p.annotationIndex)
                PdfFormValue.Checked -> page.setChecked(true, p.annotationIndex)
            }
        }
        return PdfFormApplied(snapshot)
    }
}

internal object FormProposer {
    val SCHEMA = """{"type":"object","properties":{"fields":{"type":"array","items":{"type":"object","properties":{"id":{"type":"string"},"key":{"type":"string","enum":[${PdfProfileKey.values().joinToString(",") { "\"${it.id}\"" }},"unknown"]}},"required":["id","key"]}}},"required":["fields"]}"""

    fun kindName(field: PdfFormField) = when (field) {
        is PdfFormField.Text -> "text"; is PdfFormField.CheckBox -> "checkBox"; is PdfFormField.RadioButton -> "radioButton"
        is PdfFormField.ComboBox -> "comboBox"; is PdfFormField.ListBox -> "listBox"; is PdfFormField.PushButton -> "pushButton"
        is PdfFormField.Signature -> "signature"; is PdfFormField.Unknown -> "unknown"
    }

    fun isFillable(field: PdfFormField) = !field.base.isReadOnly && (field is PdfFormField.Text || field is PdfFormField.CheckBox ||
        field is PdfFormField.RadioButton || field is PdfFormField.ComboBox || field is PdfFormField.ListBox)

    fun prompt(fields: List<PdfFieldDescription>): String = (listOf(
        "Match each form field below to one of these profile keys, or \"unknown\": ${PdfProfileKey.values().joinToString(", ") { it.id }}.",
        "Reply with JSON: {\"fields\": [{\"id\": \"...\", \"key\": \"...\"}]}.",
        "Fields:",
    ) + fields.map { f ->
        fun quote(s: String?) = JSONObject.quote(s ?: "")
        val options = when (val field = f.field) {
            is PdfFormField.ComboBox -> ", options ${JSONArray(field.options)}"
            is PdfFormField.ListBox -> ", options ${JSONArray(field.options)}"
            else -> ""
        }
        "- id ${f.pageIndex}:${f.field.base.annotationIndex}: name ${quote(f.field.base.name)}, tooltip ${quote(f.field.base.alternateName)}, label ${quote(f.label)}, kind ${kindName(f.field)}$options"
    }).joinToString("\n")

    /** The value to propose, or null when the profile value does not fit the field (FORM-5). */
    fun value(f: PdfFieldDescription, key: PdfProfileKey, raw: String): PdfFormValue? = when (val field = f.field) {
        is PdfFormField.Text -> {
            var value = raw
            val iso = Regex("""^(\d{4})-(\d{2})-(\d{2})$""").find(raw)
            if (key == PdfProfileKey.DATE_OF_BIRTH && iso != null) {
                val (y, m, d) = iso.destructured
                val hint = (Synonyms.formatHint(field.base.alternateName ?: "") ?: Synonyms.formatHint(f.label ?: "")
                    ?: Synonyms.formatHint(field.base.name ?: "") ?: "").uppercase().replace(" ", "")
                value = when (hint) {
                    "TT.MM.JJJJ", "DD.MM.YYYY" -> "$d.$m.$y"
                    "MM/DD/YYYY" -> "$m/$d/$y"
                    "DD/MM/YYYY" -> "$d/$m/$y"
                    else -> raw
                }
            }
            if (value == field.value) null else PdfFormValue.Text(value)
        }
        is PdfFormField.ComboBox -> option(field.options, field.selectedIndices, raw)
        is PdfFormField.ListBox -> option(field.options, field.selectedIndices, raw)
        is PdfFormField.CheckBox -> toggle(field.exportValue, field.isChecked, raw)
        is PdfFormField.RadioButton -> toggle(field.exportValue, field.isChecked, raw)
        else -> null
    }

    private fun option(options: List<String>, selected: List<Int>, raw: String): PdfFormValue? {
        val index = options.indexOfFirst { Synonyms.normalise(it) == Synonyms.normalise(raw) && Synonyms.normalise(it).isNotEmpty() }
        return if (index < 0 || index in selected) null else PdfFormValue.Option(index)
    }

    private fun toggle(export: String?, checked: Boolean, raw: String): PdfFormValue? =
        if (export != null && Synonyms.normalise(export) == Synonyms.normalise(raw) && !checked) PdfFormValue.Checked else null

    fun parse(reply: String): List<Pair<String, String>> {
        val from = reply.indexOf('{'); val to = reply.lastIndexOf('}')
        if (from < 0 || to <= from) return emptyList()
        val fields = try { JSONObject(reply.substring(from, to + 1)).optJSONArray("fields") } catch (e: Exception) { null } ?: return emptyList()
        return (0 until fields.length()).mapNotNull { i ->
            val f = fields.optJSONObject(i) ?: return@mapNotNull null
            if (f.has("id") && f.has("key")) f.getString("id") to f.getString("key") else null
        }
    }
}

suspend fun proposeFormValues(ai: PdfiumAI, profile: Map<PdfProfileKey, String>, pages: IntRange?): PdfFormProposals {
    val document = ai.document
    val fields = FieldDescriber.describe(document, pages).filter { FormProposer.isFillable(it.field) }
    fun id(f: PdfFieldDescription) = "${f.pageIndex}:${f.field.base.annotationIndex}"

    val matched = mutableMapOf<String, Pair<PdfProfileKey, PdfAiSource>>()
    for (f in fields) {
        Synonyms.key(f.field.base.name, f.field.base.alternateName, f.label)?.let { matched[id(f)] = it to PdfAiSource.RULES }
    }

    var modelUsed = false
    val unknown = fields.filter { id(it) !in matched }
    val provider = ai.options.provider
    if (unknown.isNotEmpty() && provider != null) {
        val outcome = resolveRoutes(customProvider = {
            val response = provider.generate(PdfAiRequest(FormProposer.prompt(unknown), schema = FormProposer.SCHEMA))
            FormProposer.parse(response.structured ?: response.text)
        })
        if (outcome is PdfAiOutcome.Answered) {
            modelUsed = true
            val sent = unknown.map { id(it) }.toSet()
            for ((fieldId, key) in outcome.result.value) {
                val profileKey = PdfProfileKey.values().firstOrNull { it.id == key } ?: continue
                if (fieldId in sent && fieldId !in matched) matched[fieldId] = profileKey to outcome.result.source
            }
        }
    }

    val items = fields.mapNotNull { f ->
        val (key, source) = matched[id(f)] ?: return@mapNotNull null
        val raw = profile[key] ?: return@mapNotNull null
        val value = FormProposer.value(f, key, raw) ?: return@mapNotNull null
        PdfFormProposal("${id(f)}:${key.id}", f.pageIndex, f.field.base.annotationIndex, f.field.base.name, key, value, source, f.field.base.rect)
    }
    return PdfFormProposals(items, modelUsed, Trial.text(FORM_NOTICE), document)
}
