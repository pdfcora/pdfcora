package com.pdfcora.sign

import com.pdfcora.PdfError
import com.pdfcora.cms.Der
import com.pdfcora.cms.DerEncode
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.security.MessageDigest
import java.security.SecureRandom
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext

/**
 * RFC 3161 timestamping, which raises a signature from PAdES B-B to B-T.
 *
 * A timestamp is a second signature, made by an authority over the first one's signature
 * value. It proves the signing happened before a given instant, so the signature stays
 * verifiable after the signer's certificate expires.
 *
 * The token is embedded as an *unsigned* attribute: it is created after the signature
 * exists and therefore cannot be inside what the signature covers.
 */
internal object Timestamp {

    private const val OID_SHA256 = "2.16.840.1.101.3.4.2.1"
    /** id-aa-timeStampToken */
    private const val OID_TOKEN = "1.2.840.113549.1.9.16.2.14"

    /**
     * A TimeStampReq over [data]'s digest.
     *
     * certReq is set so the authority returns its certificate; without it a verifier has
     * nothing to check the token against.
     */
    fun request(data: ByteArray): ByteArray {
        val digest = MessageDigest.getInstance("SHA-256").digest(data)
        val nonce = ByteArray(8).also { SecureRandom().nextBytes(it) }
        // A nonce ties the response to this request, so a replay is detectable.
        nonce[0] = (nonce[0].toInt() and 0x7f).toByte()

        return DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.sequence(
                DerEncode.sequence(DerEncode.oid(OID_SHA256)),
                DerEncode.octetString(digest),
            ),
            DerEncode.integer(nonce),
            DerEncode.boolean(true),
        )
    }

    /**
     * Extracts the token from a TimeStampResp, or explains why there is none.
     *
     * PKIStatus 0 is granted and 1 is granted with modifications; anything else is a
     * refusal and must not produce a half-signed document.
     */
    fun token(response: ByteArray): ByteArray {
        val outer = runCatching { Der.readTlv(response, 0) }
            .getOrElse { throw PdfError.SaveFailed("timestamp: unreadable response") }
        if (outer.tag != DerEncode.SEQUENCE) {
            throw PdfError.SaveFailed("timestamp: response is not a SEQUENCE")
        }

        val parts = Der.children(response, outer)
        val statusInfo = parts.firstOrNull()
            ?: throw PdfError.SaveFailed("timestamp: response has no status")
        val statusValue = Der.children(response, statusInfo).firstOrNull()
        if (statusValue == null || statusValue.tag != DerEncode.INTEGER) {
            throw PdfError.SaveFailed("timestamp: response status is not an INTEGER")
        }
        val status = Der.content(response, statusValue).fold(0) { acc, b -> acc * 256 + (b.toInt() and 0xff) }
        if (status != 0 && status != 1) {
            throw PdfError.SaveFailed("timestamp: the authority refused the request, PKIStatus $status")
        }

        val token = parts.getOrNull(1)
            ?: throw PdfError.SaveFailed("timestamp: the response carries no token")
        return response.copyOfRange(token.start, token.end)
    }

    /**
     * Puts a token into a CMS SignedData's first SignerInfo.
     *
     * The wrappers around the SignerInfo are re-encoded rather than patched: their
     * lengths change, and a length crossing the 127-byte boundary changes width too, so
     * editing bytes in place would corrupt the structure.
     */
    fun embed(token: ByteArray, cms: ByteArray): ByteArray {
        val contentInfo = Der.readTlv(cms, 0)
        val top = Der.children(cms, contentInfo)
        if (top.size < 2) throw PdfError.SaveFailed("timestamp: not a CMS ContentInfo")

        val signedData = Der.children(cms, top[1]).firstOrNull()
            ?: throw PdfError.SaveFailed("timestamp: ContentInfo has no SignedData")

        val fields = Der.children(cms, signedData)
        val signerInfosIndex = fields.indices.firstOrNull { it > 1 && fields[it].tag == DerEncode.SET }
            ?: throw PdfError.SaveFailed("timestamp: SignedData has no signerInfos")

        val signerInfos = Der.children(cms, fields[signerInfosIndex])
        val first = signerInfos.firstOrNull()
            ?: throw PdfError.SaveFailed("timestamp: signerInfos is empty")
        if (first.tag != DerEncode.SEQUENCE) {
            throw PdfError.SaveFailed("timestamp: malformed SignerInfo")
        }
        if (Der.children(cms, first).any { it.tag == DerEncode.CONTEXT_1 }) {
            throw PdfError.SaveFailed("timestamp: the SignerInfo already carries unsigned attributes")
        }

        val attribute = DerEncode.sequence(DerEncode.oid(OID_TOKEN), DerEncode.set(token))
        val unsignedAttrs = DerEncode.tlv(DerEncode.CONTEXT_1, attribute)

        val newSignerInfo = DerEncode.sequence(Der.content(cms, first) + unsignedAttrs)
        val rest = ByteArrayOutputStream()
        signerInfos.drop(1).forEach { rest.write(cms, it.start, it.end - it.start) }
        val newSignerInfos = DerEncode.set(rest.toByteArray() + newSignerInfo)

        val body = ByteArrayOutputStream()
        fields.forEachIndexed { index, field ->
            if (index == signerInfosIndex) body.write(newSignerInfos)
            else body.write(cms, field.start, field.end - field.start)
        }

        return DerEncode.sequence(
            cms.copyOfRange(top[0].start, top[0].end),
            DerEncode.tlv(DerEncode.CONTEXT_0, DerEncode.sequence(body.toByteArray())),
        )
    }

    /** Requests a token from [url] and embeds it. */
    suspend fun apply(cms: ByteArray, signatureValue: ByteArray, url: String): ByteArray =
        withContext(Dispatchers.IO) {
            val body = request(signatureValue)
            val connection = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                doOutput = true
                connectTimeout = 30_000
                readTimeout = 30_000
                setRequestProperty("Content-Type", "application/timestamp-query")
            }

            val response = try {
                connection.outputStream.use { it.write(body) }
                if (connection.responseCode !in 200..299) {
                    throw PdfError.SaveFailed(
                        "timestamp: the authority returned HTTP ${connection.responseCode}",
                    )
                }
                connection.inputStream.use { it.readBytes() }
            } catch (e: PdfError) {
                throw e
            } catch (e: Exception) {
                // A document with no timestamp is better than one with a broken
                // signature, so the caller is told rather than handed a half-signed file.
                throw PdfError.SaveFailed("timestamp: could not reach the authority: ${e.message}")
            } finally {
                connection.disconnect()
            }

            embed(token(response), cms)
        }
}
