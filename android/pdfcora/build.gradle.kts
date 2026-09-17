plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
    id("org.jetbrains.dokka")
}

group = "com.pdfcora"
version = "0.1.0"

// PDFium artifacts live in the repo-local vendor/ tree, populated by scripts/fetch-vendor.sh.
val vendorDir = rootProject.projectDir.parentFile.resolve("vendor/android")

android {
    namespace = "com.pdfcora"
    compileSdk = 34

    defaultConfig {
        minSdk = 23
        ndk { abiFilters += listOf("arm64-v8a", "armeabi-v7a", "x86", "x86_64") }
        testInstrumentationRunner = "com.pdfcora.LicensedTestRunner"
        // Tests that leak spinning native threads poison every test after them in the
        // same process. scripts/test-android.sh runs them separately.
        testInstrumentationRunnerArguments["notAnnotation"] = "com.pdfcora.LeaksNativeThreads"
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

    publishing { singleVariant("release") }

    // BuildConfig.DEBUG keeps the license test hook out of the release AAR.
    buildFeatures { buildConfig = true }

    // The shared conformance corpus and expectations, so instrumented tests assert the
    // same contract as the iOS and Web SDKs.
    sourceSets["androidTest"].assets.srcDirs(
        rootProject.projectDir.parentFile.resolve("conformance")
    )
}

dependencies {
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("androidx.annotation:annotation:1.7.1")
    // The view model is pure logic, so it is tested on the JVM rather than on a device:
    // faster, and not hostage to an emulator.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20231013")

    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    androidTestImplementation("org.json:json:20231013")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            groupId = "com.pdfcora"
            artifactId = "pdfcora"
            version = "0.1.0"
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("PDFCora")
                description.set("PDF SDK for Android, built on PDFium")
            }
        }
    }
}

apply(from = rootProject.projectDir.parentFile.resolve("gradle/central.gradle.kts"))
