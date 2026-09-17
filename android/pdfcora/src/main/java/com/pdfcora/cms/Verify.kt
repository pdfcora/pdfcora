package com.pdfcora.cms

import com.pdfcora.PdfSignature
import java.io.ByteArrayInputStream
import java.security.MessageDigest
import java.security.cert.CertificateFactory
import java.security.cert.X509Certificate
import java.util.Date

/** A certificate from a signature's chain. */
data class PdfCertificateInfo(
    val commonName: String?,
    /** Big-endian bytes; certificate serials exceed 64 bits. */
    val serialNumber: ByteArray,
    val notBefore: Date,
    val notAfter: Date,
    /** The certificate as DER, for callers that want to inspect it further. */
    val der: ByteArray,
    /**
     * Raw DER of the subject and issuer Names.
     *
     * Kept as bytes so chain building can compare them exactly. Re-encoding a Name to
     * compare it as text is where subtle mismatches come from.
     */
    internal val subject: ByteArray,
    internal val issuer: ByteArray,
) {
    override fun equals(other: Any?) = other is PdfCertificateInfo && der.contentEquals(other.der)
    override fun hashCode() = der.contentHashCode()
}

/**
 * The outcome of verifying a signature.
 *
 * Integrity and trust are deliberately separate outcomes. [Valid] means the bytes have
 * not changed **and** the chain reaches a supplied anchor; a signature that is
 * cryptographically intact but whose issuer is unknown is [Untrusted], not valid.
 *
 * Revocation (CRL/OCSP) is not checked, so [Valid] does not mean the certificate is
 * still in good standing.
 */
sealed class PdfSignatureValidity {
    data class Valid(val signer: PdfCertificateInfo, val timestamp: Date? = null) : PdfSignatureValidity()
    /** The signed bytes changed after signing. */
    object DigestMismatch : PdfSignatureValidity()
    /** Cryptographically intact, but the chain does not reach a trusted anchor. */
    data class Untrusted(val chain: List<PdfCertificateInfo>, val reason: String) : PdfSignatureValidity()
    data class Expired(val at: Date) : PdfSignatureValidity()
    data class Malformed(val reason: String) : PdfSignatureValidity()
    data class Unsupported(val subFilter: String) : PdfSignatureValidity()
}

data class PdfVerifyOptions(
    /** DER-encoded certificates to trust. With none supplied, nothing is trusted. */
    val trustAnchors: List<ByteArray> = emptyList(),
    /** The instant to judge validity at. Defaults to now; set it to make tests stable. */
    val at: Date? = null,
)

internal object CmsVerifier {

    /** Digest algorithms by OID, as they appear in a CMS `digestAlgorithm`. */
    private val digestByOid = mapOf(
        "2.16.840.1.101.3.4.2.1" to "SHA-256",
        "2.16.840.1.101.3.4.2.2" to "SHA-384",
        "2.16.840.1.101.3.4.2.3" to "SHA-512",
        // SHA-1 is listed so a document signed with it is reported as such rather than
        // as malformed. Whether to accept it is a policy decision made further up.
        "1.3.14.3.2.26" to "SHA-1",
    )

    /**
     * rsaEncryption appears as the signatureAlgorithm when the digest is carried
     * separately in digestAlgorithm, which is common in PDF signers.
     */
    private val rsaOids = setOf(
        "1.2.840.113549.1.1.11", "1.2.840.113549.1.1.12", "1.2.840.113549.1.1.13",
        "1.2.840.113549.1.1.5", "1.2.840.113549.1.1.1",
    )
    private val ecdsaOids = setOf(
        "1.2.840.10045.4.3.2", "1.2.840.10045.4.3.3", "1.2.840.10045.4.3.4",
    )

    private val supportedSubFilters = setOf(
        "adbe.pkcs7.detached", "ETSI.CAdES.detached", "adbe.pkcs7.sha1",
    )

    fun verify(
        bytes: ByteArray,
        signature: PdfSignature,
        options: PdfVerifyOptions,
    ): PdfSignatureValidity {
        val cms = try {
            CmsSignedData.parse(signature.contents)
        } catch (e: Exception) {
            return PdfSignatureValidity.Malformed(e.message ?: "unparseable PKCS#7")
        }

        signature.subFilter?.let {
            if (it !in supportedSubFilters) return PdfSignatureValidity.Unsupported(it)
        }

        val certificates = try {
            cms.certificates.map { CertificateReader.parse(it) }
        } catch (e: Exception) {
            return PdfSignatureValidity.Malformed(e.message ?: "unparseable certificate")
        }
        val signer = certificates.firstOrNull { it.serialNumber.contentEquals(cms.signerSerial) }
            ?: certificates.firstOrNull()
            ?: return PdfSignatureValidity.Malformed("no signer certificate")

        // Integrity first, so tampering is never reported as a trust problem.
        try {
            if (!checkDigest(bytes, signature, cms)) return PdfSignatureValidity.DigestMismatch
            if (!checkSignature(cms, signer)) return PdfSignatureValidity.DigestMismatch
        } catch (e: Exception) {
            return PdfSignatureValidity.Malformed(e.message ?: "verification failed")
        }

        val now = options.at ?: Date()
        if (now.before(signer.notBefore) || now.after(signer.notAfter)) {
            return PdfSignatureValidity.Expired(signer.notAfter)
        }

        val chain = CertificateReader.buildChain(signer, certificates)
        val anchors = options.trustAnchors.mapNotNull {
            runCatching { CertificateReader.parse(it) }.getOrNull()
        }
        val trusted = chain.any { link -> anchors.any { it.der.contentEquals(link.der) } }

        if (!trusted) {
            val root = chain.last()
            val reason = when {
                anchors.isEmpty() -> "no trust anchors were supplied"
                CertificateReader.isSelfIssued(root) ->
                    "the chain ends at a self-issued certificate that is not an anchor"
                else -> "the issuer is unknown"
            }
            return PdfSignatureValidity.Untrusted(chain, reason)
        }

        return PdfSignatureValidity.Valid(signer)
    }

    /**
     * Hashes the spans a `/ByteRange` names, in the order it names them.
     *
     * The gap between the ranges is the `/Contents` placeholder holding the signature
     * itself — genuinely outside the signed data.
     */
    fun digestOverRanges(bytes: ByteArray, byteRange: List<Int>, algorithm: String): ByteArray {
        if (byteRange.size < 2 || byteRange.size % 2 != 0) {
            throw Der.Failure("byte range must be offset/length pairs")
        }
        val digest = MessageDigest.getInstance(algorithm)
        for (pair in byteRange.indices step 2) {
            val start = byteRange[pair]
            val length = byteRange[pair + 1]
            if (start < 0 || length < 0 || start + length > bytes.size) {
                throw Der.Failure("byte range $start+$length runs past the file")
            }
            digest.update(bytes, start, length)
        }
        return digest.digest()
    }

    fun checkDigest(bytes: ByteArray, signature: PdfSignature, cms: CmsSignedData): Boolean {
        val expected = cms.messageDigest ?: return false
        val algorithm = digestByOid[cms.digestAlgorithm]
            ?: throw Der.Failure("unsupported digest algorithm ${cms.digestAlgorithm}")
        val actual = digestOverRanges(bytes, signature.byteRange, algorithm)
        return MessageDigest.isEqual(actual, expected)
    }

    /**
     * Verifies the signature over the signed attributes.
     *
     * The signature covers the SET encoding, which [CmsSignedData] already re-tagged. A
     * detached PDF signature always has signed attributes, so their absence is refused
     * rather than guessed at.
     */
    private fun checkSignature(cms: CmsSignedData, signer: PdfCertificateInfo): Boolean {
        val signedAttrs = cms.signedAttrs ?: throw Der.Failure("signature has no signed attributes")
        val digest = (digestByOid[cms.digestAlgorithm] ?: "SHA-256").replace("-", "")

        val algorithm = when (cms.signatureAlgorithm) {
            in rsaOids -> "${digest}withRSA"
            in ecdsaOids -> "${digest}withECDSA"
            else -> throw Der.Failure("unsupported signature algorithm ${cms.signatureAlgorithm}")
        }

        // The public key comes from the platform's certificate parser rather than from
        // re-parsing the SubjectPublicKeyInfo ourselves; JCA already does that correctly.
        val certificate = CertificateFactory.getInstance("X.509")
            .generateCertificate(ByteArrayInputStream(signer.der)) as X509Certificate

        return java.security.Signature.getInstance(algorithm).run {
            initVerify(certificate.publicKey)
            update(signedAttrs)
            verify(cms.signature)
        }
    }
}
