package com.pdfcora.cms

import java.util.Calendar
import java.util.Date
import java.util.TimeZone

/**
 * Reading an X.509 certificate far enough to verify a signature and judge trust.
 *
 * Names are kept as their raw DER so issuer and subject can be compared byte for byte,
 * which is what chain building requires.
 */
internal object CertificateReader {

    private const val SEQUENCE = 0x30
    private const val SET = 0x31
    private const val OID = 0x06
    private const val CONTEXT_0 = 0xa0
    private const val UTC_TIME = 0x17

    private const val OID_COMMON_NAME = "2.5.4.3"

    fun parse(der: ByteArray): PdfCertificateInfo {
        val certificate = Der.readTlv(der, 0)
        if (certificate.tag != SEQUENCE) throw Der.Failure("certificate is not a SEQUENCE")

        val tbs = Der.children(der, certificate).firstOrNull()
            ?: throw Der.Failure("certificate has no tbsCertificate")
        if (tbs.tag != SEQUENCE) throw Der.Failure("certificate has no tbsCertificate")

        val fields = Der.children(der, tbs)
        // version is [0] EXPLICIT and optional; everything after it shifts by one.
        val base = if (fields.firstOrNull()?.tag == CONTEXT_0) 1 else 0
        if (fields.size <= base + 5) throw Der.Failure("tbsCertificate is missing required fields")

        val validity = Der.children(der, fields[base + 3])
        if (validity.size < 2) throw Der.Failure("certificate has no validity period")

        return PdfCertificateInfo(
            commonName = findCommonName(der, fields[base + 4]),
            serialNumber = Der.readIntegerBytes(der, fields[base]),
            notBefore = parseTime(der, validity[0]),
            notAfter = parseTime(der, validity[1]),
            der = der,
            subject = Der.encoding(der, fields[base + 4]),
            issuer = Der.encoding(der, fields[base + 2]),
        )
    }

    /** Name ::= SEQUENCE OF RelativeDistinguishedName (SET OF AttributeTypeAndValue). */
    private fun findCommonName(der: ByteArray, name: Der.Tlv): String? {
        for (rdn in Der.children(der, name)) {
            if (rdn.tag != SET) continue
            for (attribute in Der.children(der, rdn)) {
                val parts = Der.children(der, attribute)
                if (parts.size < 2 || parts[0].tag != OID) continue
                if (Der.readOid(der, parts[0]) != OID_COMMON_NAME) continue
                return String(Der.content(der, parts[1]), Charsets.UTF_8)
            }
        }
        return null
    }

    /**
     * UTCTime is `YYMMDDHHMMSSZ`, windowed at 2049 per RFC 5280; GeneralizedTime is
     * `YYYYMMDDHHMMSSZ`. Only the Z forms appear in certificates.
     */
    private fun parseTime(der: ByteArray, tlv: Der.Tlv): Date {
        val text = String(Der.content(der, tlv), Charsets.UTF_8)
        val isUtcTime = tlv.tag == UTC_TIME
        val digits = text.takeWhile { it.isDigit() }
        if (digits.length < if (isUtcTime) 10 else 12) {
            throw Der.Failure("unparseable certificate time $text")
        }

        fun part(start: Int, length: Int): Int =
            digits.substring(start, start + length).toIntOrNull() ?: 0

        val calendar = Calendar.getInstance(TimeZone.getTimeZone("UTC")).apply { clear() }
        if (isUtcTime) {
            val year = part(0, 2)
            calendar.set(
                if (year >= 50) 1900 + year else 2000 + year,
                part(2, 2) - 1, part(4, 2), part(6, 2), part(8, 2),
                if (digits.length >= 12) part(10, 2) else 0,
            )
        } else {
            calendar.set(
                part(0, 4), part(4, 2) - 1, part(6, 2), part(8, 2), part(10, 2),
                if (digits.length >= 14) part(12, 2) else 0,
            )
        }
        return calendar.time
    }

    /** A certificate that issued itself, which a chain cannot climb past. */
    fun isSelfIssued(certificate: PdfCertificateInfo): Boolean =
        certificate.subject.contentEquals(certificate.issuer)

    /**
     * Orders certificates from the signer upward, following issuer links.
     *
     * Stops at a self-issued certificate or when no issuer is present, so a cycle in a
     * malformed bundle cannot loop forever.
     */
    fun buildChain(
        signer: PdfCertificateInfo,
        pool: List<PdfCertificateInfo>,
    ): List<PdfCertificateInfo> {
        val chain = mutableListOf(signer)
        val seen = mutableSetOf(signer.der.contentHashCode())
        var current = signer

        while (!isSelfIssued(current)) {
            val issuer = pool.firstOrNull { it.subject.contentEquals(current.issuer) } ?: break
            if (!seen.add(issuer.der.contentHashCode())) break
            chain += issuer
            current = issuer
        }
        return chain
    }
}
