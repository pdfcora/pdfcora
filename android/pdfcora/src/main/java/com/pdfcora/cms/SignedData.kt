package com.pdfcora.cms

/**
 * Walking a PKCS#7 SignedData far enough to verify a PDF signature.
 *
 * Only what verification needs: the certificates, the signer's identity, the algorithms,
 * the signed attributes and the signature value. Everything else in the structure is
 * stepped over rather than modelled.
 */
internal class CmsSignedData(
    /** DER-encoded certificates, in the order the file carries them. */
    val certificates: List<ByteArray>,
    /** Big-endian bytes of the signer's serial number. */
    val signerSerial: ByteArray,
    val digestAlgorithm: String,
    val signatureAlgorithm: String,
    /**
     * The signed attributes, re-tagged as a SET.
     *
     * This is what the signature is computed over. The file stores them `[0] IMPLICIT`,
     * and verifying against those bytes fails for every signature ever made.
     */
    val signedAttrs: ByteArray?,
    /** The `messageDigest` attribute: the digest the signer committed to. */
    val messageDigest: ByteArray?,
    val signature: ByteArray,
) {
    companion object {
        private const val SEQUENCE = 0x30
        private const val SET = 0x31
        private const val OCTET_STRING = 0x04
        private const val OID = 0x06
        private const val INTEGER = 0x02
        private const val CONTEXT_0 = 0xa0

        private const val OID_SIGNED_DATA = "1.2.840.113549.1.7.2"
        private const val OID_MESSAGE_DIGEST = "1.2.840.113549.1.9.4"

        fun parse(pkcs7: ByteArray): CmsSignedData {
            val contentInfo = Der.readTlv(pkcs7, 0)
            if (contentInfo.tag != SEQUENCE) throw Der.Failure("expected ContentInfo")
            val parts = Der.children(pkcs7, contentInfo)

            val contentType = parts.firstOrNull()
            if (contentType == null || contentType.tag != OID ||
                Der.readOid(pkcs7, contentType) != OID_SIGNED_DATA
            ) {
                throw Der.Failure("not a signedData content type")
            }
            if (parts.size < 2 || parts[1].tag != CONTEXT_0) {
                throw Der.Failure("signedData has no content")
            }
            val signedData = Der.children(pkcs7, parts[1]).firstOrNull()
                ?: throw Der.Failure("expected SignedData")
            if (signedData.tag != SEQUENCE) throw Der.Failure("expected SignedData")

            // version, digestAlgorithms, encapContentInfo, [certificates], [crls], signerInfos
            val fields = Der.children(pkcs7, signedData)
            if (fields.size < 4) throw Der.Failure("SignedData is too short")

            val digestAlgorithm = algorithmOid(pkcs7, fields[1], "digestAlgorithms")

            val certificates = mutableListOf<ByteArray>()
            for (field in fields) {
                if (field.tag != CONTEXT_0) continue
                // [0] IMPLICIT CertificateSet. Its children are the certificates.
                for (certificate in Der.children(pkcs7, field)) {
                    if (certificate.tag == SEQUENCE) certificates += Der.encoding(pkcs7, certificate)
                }
            }

            val signerInfos = fields.drop(2).firstOrNull { it.tag == SET }
                ?: throw Der.Failure("no signerInfos")
            val signerInfo = Der.children(pkcs7, signerInfos).firstOrNull()
                ?: throw Der.Failure("no signerInfo")
            if (signerInfo.tag != SEQUENCE) throw Der.Failure("malformed SignerInfo")

            return parseSignerInfo(pkcs7, signerInfo, certificates, digestAlgorithm)
        }

        private fun parseSignerInfo(
            pkcs7: ByteArray,
            signerInfo: Der.Tlv,
            certificates: List<ByteArray>,
            digestAlgorithm: String,
        ): CmsSignedData {
            // version, sid, digestAlgorithm, [0] signedAttrs, signatureAlgorithm, signature
            val fields = Der.children(pkcs7, signerInfo)
            if (fields.size < 5) throw Der.Failure("SignerInfo is too short")

            // sid is IssuerAndSerialNumber. The subjectKeyIdentifier form ([0]) is not
            // used by any PDF signer we have seen and would need the certificate to
            // resolve, so it is refused rather than half-handled.
            if (fields[1].tag != SEQUENCE) {
                throw Der.Failure("subjectKeyIdentifier signer id is not supported")
            }
            val serial = Der.children(pkcs7, fields[1]).firstOrNull { it.tag == INTEGER }
                ?: throw Der.Failure("signer has no serial number")

            val attrsField = fields.firstOrNull { it.tag == CONTEXT_0 }
            val signedAttrs = attrsField?.let { retagAsSet(pkcs7, it) }
            val messageDigest = attrsField?.let { findMessageDigest(pkcs7, it) }

            val algorithmField = if (attrsField != null) {
                val index = fields.indexOfFirst { it.start == attrsField.start }
                fields.getOrNull(index + 1) ?: fields[fields.size - 2]
            } else {
                fields[fields.size - 2]
            }

            val signature = fields.lastOrNull { it.tag == OCTET_STRING }
                ?: throw Der.Failure("no signature value")

            return CmsSignedData(
                certificates = certificates,
                signerSerial = Der.readIntegerBytes(pkcs7, serial),
                digestAlgorithm = digestAlgorithm,
                signatureAlgorithm = algorithmOid(pkcs7, algorithmField, "signatureAlgorithm"),
                signedAttrs = signedAttrs,
                messageDigest = messageDigest,
                signature = Der.content(pkcs7, signature),
            )
        }

        /**
         * Re-encodes `[0] IMPLICIT SignedAttributes` as the `SET OF` the signature
         * covers. Only the identifier octet changes; the length and contents are already
         * correct, so the bytes are copied rather than re-encoded.
         */
        private fun retagAsSet(pkcs7: ByteArray, attrs: Der.Tlv): ByteArray {
            val out = Der.encoding(pkcs7, attrs)
            out[0] = SET.toByte()
            return out
        }

        private fun findMessageDigest(pkcs7: ByteArray, attrs: Der.Tlv): ByteArray? {
            for (attribute in Der.children(pkcs7, attrs)) {
                if (attribute.tag != SEQUENCE) continue
                val parts = Der.children(pkcs7, attribute)
                if (parts.size < 2 || parts[0].tag != OID) continue
                if (Der.readOid(pkcs7, parts[0]) != OID_MESSAGE_DIGEST) continue

                val value = Der.children(pkcs7, parts[1]).firstOrNull()
                if (value != null && value.tag == OCTET_STRING) return Der.content(pkcs7, value)
            }
            return null
        }

        /** AlgorithmIdentifier ::= SEQUENCE { algorithm OID, parameters ANY OPTIONAL } */
        private fun algorithmOid(pkcs7: ByteArray, field: Der.Tlv, what: String): String {
            // digestAlgorithms is a SET OF AlgorithmIdentifier; signatureAlgorithm is one.
            val identifier = if (field.tag == SET) {
                Der.children(pkcs7, field).firstOrNull()
            } else {
                field
            }
            if (identifier == null || identifier.tag != SEQUENCE) {
                throw Der.Failure("malformed $what")
            }
            val oid = Der.children(pkcs7, identifier).firstOrNull()
                ?: throw Der.Failure("$what has no OID")
            if (oid.tag != OID) throw Der.Failure("$what has no OID")
            return Der.readOid(pkcs7, oid)
        }
    }
}
