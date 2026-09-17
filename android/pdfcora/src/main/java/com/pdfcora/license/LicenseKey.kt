package com.pdfcora.license

import android.util.Base64
import org.json.JSONArray
import org.json.JSONObject
import java.security.KeyFactory
import java.security.Signature
import java.security.spec.X509EncodedKeySpec

enum class PdfLicenseModule(val id: String) {
    EDITING("editing"), FORMS("forms"), SIGNING("signing"), REDACTION("redaction"), AI("ai")
}

enum class PdfLicenseReason(val id: String) {
    NO_KEY("noKey"), MALFORMED("malformed"), BAD_SIGNATURE("badSignature"),
    UNSUPPORTED_VERSION("unsupportedVersion"), REVOKED("revoked"), EXPIRED("expired"), WRONG_APP("wrongApp")
}

sealed interface PdfLicenseStatus {
    data class Licensed(val customer: String, val modules: Set<PdfLicenseModule>) : PdfLicenseStatus
    data class Trial(val reason: PdfLicenseReason, val message: String) : PdfLicenseStatus

    fun covers(module: PdfLicenseModule): Boolean = this is Licensed && module in modules
    val isTrial: Boolean get() = this is Trial
}

internal data class LicenseContext(
    val publicKey: String,
    val revoked: Set<String>,
    val releaseDate: String,
    val appIdentifier: String?,
)

/** `pk1.<payload>.<signature>`, verified offline. See the licensing spec. */
internal object LicenseKey {
    /** The DER header of a P-256 SubjectPublicKeyInfo, before the 65-byte point. */
    private val SPKI_PREFIX = hex("3059301306072a8648ce3d020106082a8648ce3d030107034200")
    private val DATE = Regex("""^\d{4}-\d{2}-\d{2}$""")

    fun evaluate(key: String?, context: LicenseContext): PdfLicenseStatus {
        val trimmed = key?.trim()
        if (trimmed.isNullOrEmpty()) return PdfLicenseStatus.Trial(PdfLicenseReason.NO_KEY, "no license key set")
        val malformed = PdfLicenseStatus.Trial(PdfLicenseReason.MALFORMED, "license key is malformed")

        val parts = trimmed.split(".")
        if (parts.size != 3 || parts[0] != "pk1") return malformed
        val payloadBytes = base64url(parts[1]) ?: return malformed
        val signatureBytes = base64url(parts[2]) ?: return malformed
        val payload = Payload.parse(payloadBytes) ?: return malformed

        if (!verify(context.publicKey, payloadBytes, signatureBytes)) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.BAD_SIGNATURE, "license key signature is invalid")
        }
        if (payload.v != 1) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.UNSUPPORTED_VERSION,
                "license key version ${payload.v} is not supported by this SDK")
        }
        if (payload.id in context.revoked) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.REVOKED, "license key ${payload.id} has been revoked")
        }
        if (context.releaseDate > payload.expires) {
            return PdfLicenseStatus.Trial(PdfLicenseReason.EXPIRED,
                "license key expired on ${payload.expires}, before this SDK was released on ${context.releaseDate}")
        }
        val app = context.appIdentifier
        if (app == null || app !in payload.android) {
            val listed = payload.android.joinToString(", ").ifEmpty { "no Android apps" }
            return PdfLicenseStatus.Trial(PdfLicenseReason.WRONG_APP, "key is for $listed, this app is ${app ?: "unknown"}")
        }
        val modules = PdfLicenseModule.values().filter { it.id in payload.modules }.toSet()
        return PdfLicenseStatus.Licensed(payload.customer, modules)
    }

    private fun verify(publicKey: String, payload: ByteArray, signature: ByteArray): Boolean {
        val point = base64url(publicKey) ?: return false
        if (signature.size != 64) return false
        return try {
            val key = KeyFactory.getInstance("EC").generatePublic(X509EncodedKeySpec(SPKI_PREFIX + point))
            Signature.getInstance("SHA256withECDSA").run {
                initVerify(key)
                update(payload)
                verify(rawToDer(signature))
            }
        } catch (e: Exception) {
            false
        }
    }

    /** WebCrypto and CryptoKit use raw r‖s; java.security wants a DER SEQUENCE of two INTEGERs. */
    private fun rawToDer(raw: ByteArray): ByteArray {
        fun integer(bytes: ByteArray): ByteArray {
            var value = bytes.dropWhile { it == 0.toByte() }.toByteArray()
            if (value.isEmpty()) value = byteArrayOf(0)
            if (value[0] < 0) value = byteArrayOf(0) + value
            return byteArrayOf(0x02, value.size.toByte()) + value
        }
        val body = integer(raw.copyOfRange(0, 32)) + integer(raw.copyOfRange(32, 64))
        return byteArrayOf(0x30, body.size.toByte()) + body
    }

    private fun base64url(text: String): ByteArray? {
        if (!text.all { it.isLetterOrDigit() && it.code < 128 || it == '-' || it == '_' }) return null
        if (text.length % 4 == 1) return null
        return try {
            Base64.decode(text, Base64.URL_SAFE or Base64.NO_PADDING or Base64.NO_WRAP)
        } catch (e: IllegalArgumentException) {
            null
        }
    }

    private fun hex(text: String) = ByteArray(text.length / 2) { text.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

    private class Payload(
        val v: Int, val id: String, val customer: String,
        val modules: List<String>, val android: List<String>, val expires: String,
    ) {
        companion object {
            fun parse(bytes: ByteArray): Payload? = try {
                val json = JSONObject(bytes.decodeToString(throwOnInvalidSequence = true))
                val v = json.get("v")
                val listsValid = listOf("ios", "android", "web").all { !json.has(it) || strings(json.get(it)) != null }
                val serverValid = !json.has("server") || json.get("server") is Boolean
                val expires = json.get("expires")
                if (v !is Int || json.get("id") !is String || json.get("customer") !is String ||
                    strings(json.get("modules")) == null || expires !is String || !DATE.matches(expires) ||
                    !listsValid || !serverValid) null
                else Payload(v, json.getString("id"), json.getString("customer"),
                             strings(json.get("modules"))!!,
                             if (json.has("android")) strings(json.get("android"))!! else emptyList(),
                             expires)
            } catch (e: Exception) {
                null
            }

            private fun strings(value: Any?): List<String>? =
                (value as? JSONArray)?.let { array ->
                    (0 until array.length()).map { array.get(it) as? String ?: return null }
                }
        }
    }
}
