package com.pdfiumkit.license

import android.content.Context
import android.util.Log
import com.pdfiumkit.BuildConfig

/** Set at release by scripts/set-release-date.sh. The private key is held outside this repository. */
internal object LicenseBuild {
    const val RELEASE_DATE = "2026-09-15"
    const val PUBLIC_KEY = "BP4TsodWBykQxZzmAYu-OckkjD2s9a4QXlG_kCjIUsdjRdIetrVP_Zu3nJ2RS7IIooaqHpjlFgu0gGRxPg-s6cg"
    val REVOKED: Set<String> = emptySet()
}

/** The SDK's license. Without a key covering a feature, the feature still works and its output carries a watermark. */
object PdfLicense {
    private var context = LicenseContext(LicenseBuild.PUBLIC_KEY, LicenseBuild.REVOKED, LicenseBuild.RELEASE_DATE, null)
    private var key: String? = null
    @Volatile private var current: PdfLicenseStatus =
        PdfLicenseStatus.Trial(PdfLicenseReason.NO_KEY, "no license key set")
    @Volatile private var warned = false

    /** Sets the license key. Call before opening documents. Never throws. */
    @Synchronized
    fun setKey(context: Context, key: String) {
        this.context = this.context.copy(appIdentifier = context.packageName)
        this.key = key
        current = LicenseKey.evaluate(key, this.context)
    }

    val status: PdfLicenseStatus get() = current

    /** Logs once per process, the first time anything is watermarked. */
    internal fun noteWatermark(detail: String) {
        if (warned) return
        warned = true
        Log.w("PdfiumKit", "output is watermarked — $detail")
    }

    /**
     * Test hook. Kotlin `internal` is still a public JVM method, callable from Java as
     * `configureForTesting$pdfiumkit_release`, so the release build ignores it: otherwise
     * an app could install its own public key and license itself.
     */
    @Synchronized
    internal fun configureForTesting(
        publicKey: String? = null, revoked: Set<String>? = null, releaseDate: String? = null,
        appIdentifier: String? = null, key: String? = null, setKey: Boolean = false,
    ): PdfLicenseStatus {
        if (!BuildConfig.DEBUG) return current
        context = context.copy(
            publicKey = publicKey ?: context.publicKey,
            revoked = revoked ?: context.revoked,
            releaseDate = releaseDate ?: context.releaseDate,
            appIdentifier = appIdentifier ?: context.appIdentifier,
        )
        if (setKey) this.key = key
        current = LicenseKey.evaluate(this.key, context)
        return current
    }
}
