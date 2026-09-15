package com.pdfiumkit.sign

import com.pdfiumkit.PdfDocument
import com.pdfiumkit.Native
import com.pdfiumkit.PdfError
import com.pdfiumkit.cms.CertificateReader
import com.pdfiumkit.cms.CmsSignedData
import com.pdfiumkit.cms.DerEncode
import com.pdfiumkit.license.PdfLicenseModule
import java.io.ByteArrayInputStream
import java.io.ByteArrayOutputStream
import java.security.KeyStore
import java.security.MessageDigest
import java.security.PrivateKey
import java.security.Signature
import java.security.cert.X509Certificate

/**
 * Produces a detached CMS SignedData over `data`.
 *
 * Given the data rather than a digest: every CMS API wants the content, computes the
 * digest itself and puts it in the signed attributes. Passing only a digest would force
 * each implementation to hand-build them.
 */
interface CmsSigner {
    suspend fun sign(data: ByteArray): ByteArray
}

data class PdfSignOptions(
    val signer: CmsSigner,
    val reason: String? = null,
    val contactInfo: String? = null,
    val fieldName: String? = null,
    val pageIndex: Int = 0,
    /** Bytes reserved for the signature. 8192 fits RSA-2048 with a timestamp. */
    val reservedBytes: Int = 8192,
    /**
     * ETSI.CAdES.detached is PAdES and requires the signer to produce CAdES-BES. Strict
     * verifiers reject a plain PKCS#7 under it even when the signature is sound.
     */
    val subFilter: String = "ETSI.CAdES.detached",
    /**
     * An RFC 3161 authority, raising the signature from PAdES B-B to B-T. Absent by
     * default: it needs a network call, and a signature without one is still valid.
     */
    val timestampUrl: String? = null,
)

/**
 * Signs the document, returning the signed bytes.
 *
 * The original bytes are never modified: the signature is appended as an incremental
 * update, so any signature already present keeps verifying. Without a signing license the
 * bytes are first watermarked, which is a full rewrite, so earlier signatures in the
 * result no longer verify.
 */
suspend fun PdfDocument.sign(options: PdfSignOptions): ByteArray {
    use(PdfLicenseModule.SIGNING)
    val base = if (!needsWatermark) originalBytes() else onDocument {
        noteWatermarked()
        Native.stampWatermark(originalBytes()).also {
            if (it.isEmpty()) throw PdfError.SaveFailed("the document could not be watermarked")
        }
    }
    val placed = SignatureField.place(
        base,
        SignatureField.Options(
            reservedBytes = options.reservedBytes,
            reason = options.reason,
            contactInfo = options.contactInfo,
            fieldName = options.fieldName,
            pageIndex = options.pageIndex,
            subFilter = options.subFilter,
        ),
    )

    // The signed content is the file with the placeholder cut out — exactly what the byte
    // range names, and exactly what a verifier will re-assemble.
    val content = concatRanges(placed.bytes, placed.byteRange)
    var cms = options.signer.sign(content)
    if (cms.isEmpty()) throw PdfError.SaveFailed("sign: the signer returned nothing")

    options.timestampUrl?.let { url ->
        // Any failure here throws, so a document is never returned with a timestamp that
        // was requested and silently not applied.
        cms = Timestamp.apply(cms, CmsSignedData.parse(cms).signature, url)
    }

    if (cms.size > options.reservedBytes) {
        // Truncating would produce a file that opens and fails to verify, with no clue why.
        throw PdfError.SaveFailed(
            "sign: the signature is ${cms.size} bytes but only ${options.reservedBytes} " +
                "were reserved; pass a larger reservedBytes",
        )
    }

    return patchContents(placed.bytes, placed.contentsAt, cms)
}

/** Writes the signature into the placeholder as hex, leaving the rest as zeros. */
private fun patchContents(bytes: ByteArray, contentsAt: Int, cms: ByteArray): ByteArray {
    val out = bytes.copyOf()
    // contentsAt points at '<'; the hex begins one byte later and the space is already
    // '0', so only the signature's own digits are written.
    var cursor = contentsAt + 1
    for (byte in cms) {
        val value = byte.toInt() and 0xff
        out[cursor++] = HEX[value shr 4]
        out[cursor++] = HEX[value and 0x0f]
    }
    return out
}

private val HEX = "0123456789ABCDEF".toByteArray(Charsets.ISO_8859_1)

private fun concatRanges(bytes: ByteArray, byteRange: List<Int>): ByteArray {
    val out = ByteArrayOutputStream()
    for (pair in byteRange.indices step 2) {
        out.write(bytes, byteRange[pair], byteRange[pair + 1])
    }
    return out.toByteArray()
}

/**
 * Signs with a PKCS#12 identity, using JCA.
 *
 * Unlike web, Android needs no app-supplied CMS: the platform can build one. The CAdES
 * signingCertificateV2 attribute is added so the default ETSI.CAdES.detached sub-filter
 * is honest about what the CMS contains. No Bouncy Castle.
 */
class Pkcs12Signer(pkcs12: ByteArray, password: String) : CmsSigner {

    private val key: PrivateKey
    private val certificate: X509Certificate

    init {
        val store = KeyStore.getInstance("PKCS12")
        store.load(ByteArrayInputStream(pkcs12), password.toCharArray())
        val alias = store.aliases().toList().firstOrNull { store.isKeyEntry(it) }
            ?: throw PdfError.SaveFailed("sign: the PKCS#12 has no key entry")
        key = store.getKey(alias, password.toCharArray()) as PrivateKey
        certificate = store.getCertificate(alias) as X509Certificate
    }

    override suspend fun sign(data: ByteArray): ByteArray =
        CmsBuilder.signedData(data, certificate.encoded) { signedAttrs ->
            Signature.getInstance("SHA256withRSA").run {
                initSign(key)
                update(signedAttrs)
                sign()
            }
        }
}

/**
 * Building a detached CMS SignedData.
 *
 * The signature covers the signed attributes, which carry the digest of the content
 * rather than the content itself; that is what makes the CMS detached.
 */
internal object CmsBuilder {

    private const val OID_SIGNED_DATA = "1.2.840.113549.1.7.2"
    private const val OID_DATA = "1.2.840.113549.1.7.1"
    private const val OID_SHA256 = "2.16.840.1.101.3.4.2.1"
    private const val OID_RSA = "1.2.840.113549.1.1.1"
    private const val OID_CONTENT_TYPE = "1.2.840.113549.1.9.3"
    private const val OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"
    /** id-aa-signingCertificateV2, which CAdES-BES requires. */
    private const val OID_SIGNING_CERTIFICATE_V2 = "1.2.840.113549.1.9.16.2.47"

    fun signedData(
        content: ByteArray,
        certificate: ByteArray,
        sign: (ByteArray) -> ByteArray,
    ): ByteArray {
        val parsed = CertificateReader.parse(certificate)
        val sha256 = MessageDigest.getInstance("SHA-256")
        val contentDigest = sha256.digest(content)
        val certificateDigest = MessageDigest.getInstance("SHA-256").digest(certificate)

        val attributes = DerEncode.set(
            attribute(OID_CONTENT_TYPE, DerEncode.oid(OID_DATA)),
            attribute(OID_MESSAGE_DIGEST, DerEncode.octetString(contentDigest)),
            // ESSCertIDv2 with the default SHA-256 hash algorithm omitted, as allowed.
            attribute(
                OID_SIGNING_CERTIFICATE_V2,
                DerEncode.sequence(
                    DerEncode.sequence(DerEncode.sequence(DerEncode.octetString(certificateDigest))),
                ),
            ),
        )

        // The signature covers the SET encoding, which is why the attributes are built
        // once here and reused rather than re-encoded.
        val signature = sign(attributes)

        val signerInfo = DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.sequence(parsed.issuer, DerEncode.integer(parsed.serialNumber)),
            DerEncode.sequence(DerEncode.oid(OID_SHA256)),
            // [0] IMPLICIT in the file, though the signature covered the SET form.
            DerEncode.tlv(DerEncode.CONTEXT_0, attributes.copyOfRange(headerLength(attributes), attributes.size)),
            DerEncode.sequence(DerEncode.oid(OID_RSA)),
            DerEncode.octetString(signature),
        )

        val body = DerEncode.sequence(
            DerEncode.integer(1),
            DerEncode.set(DerEncode.sequence(DerEncode.oid(OID_SHA256))),
            DerEncode.sequence(DerEncode.oid(OID_DATA)),       // detached: no eContent
            DerEncode.tlv(DerEncode.CONTEXT_0, certificate),
            DerEncode.set(signerInfo),
        )

        return DerEncode.sequence(
            DerEncode.oid(OID_SIGNED_DATA),
            DerEncode.tlv(DerEncode.CONTEXT_0, body),
        )
    }

    private fun attribute(oid: String, value: ByteArray) =
        DerEncode.sequence(DerEncode.oid(oid), DerEncode.set(value))

    /** How many bytes the tag and length occupy, so the SET's content can be re-tagged. */
    private fun headerLength(encoded: ByteArray): Int {
        if (encoded.size < 2) return encoded.size
        val first = encoded[1].toInt() and 0xff
        return if (first < 0x80) 2 else 2 + (first and 0x7f)
    }
}
