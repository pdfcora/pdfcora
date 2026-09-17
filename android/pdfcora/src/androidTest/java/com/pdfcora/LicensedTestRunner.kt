package com.pdfcora

import android.os.Bundle
import androidx.test.runner.AndroidJUnitRunner

/** Every instrumented test runs licensed for every module; license tests change it locally. */
class LicensedTestRunner : AndroidJUnitRunner() {
    override fun onStart() {
        LicenseFixture.installFullKey()
        super.onStart()
    }
}
