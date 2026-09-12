plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

// PDFium artifacts live in the repo-local vendor/ tree, populated by scripts/fetch-vendor.sh.
val vendorDir = rootProject.projectDir.parentFile.resolve("vendor/android")

android {
    namespace = "com.pdfiumkit"
    compileSdk = 34

    defaultConfig {
        minSdk = 23
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64") }
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        externalNativeBuild {
            cmake {
                arguments += listOf(
                    "-DPDFIUM_VENDOR_DIR=${vendorDir.absolutePath}",
                    "-DANDROID_STL=c++_static",
                )
            }
        }
    }

    externalNativeBuild {
        cmake {
            path = file("src/main/cpp/CMakeLists.txt")
            version = "3.22.1"
        }
    }

    buildTypes {
        release { isMinifyEnabled = false }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    packaging { jniLibs { useLegacyPackaging = false } }

    // The shared conformance corpus and expectations, so instrumented tests assert the
    // same contract as the iOS and Web SDKs.
    sourceSets["androidTest"].assets.srcDirs(
        rootProject.projectDir.parentFile.resolve("conformance")
    )
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.annotation:annotation:1.7.1")
    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("org.json:json:20231013")
}
