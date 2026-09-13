plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("maven-publish")
}

group = "com.pdfiumkit"
// PKG-1: released alongside the core with a matching version. scripts/check-core-deps.sh
// fails the build if these drift apart.
version = "0.1.0"

android {
    namespace = "com.pdfiumkit.ai"
    compileSdk = 34

    // PKG-3: adding this module must not raise an app's floor. Matches the core.
    defaultConfig {
        minSdk = 23
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    publishing { singleVariant("release") { withSourcesJar() } }
}

dependencies {
    // PKG-4: only the core's public API.
    api(project(":pdfiumkit"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // No ML Kit, no Play services, no AICore. Those arrive with the feature that needs
    // them, in a later phase — adding one now would only risk PKG-2 for no benefit.

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}
