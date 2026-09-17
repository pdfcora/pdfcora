plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.compose")
    id("org.jetbrains.dokka")
    id("maven-publish")
}

group = "com.pdfcora"
// PKG-1: released alongside the core with a matching version.
version = "0.1.0"

android {
    namespace = "com.pdfcora.ui"
    compileSdk = 34

    // Must not raise an app's floor. Matches the core.
    defaultConfig {
        minSdk = 23
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    buildFeatures { compose = true }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions { jvmTarget = "17" }

    publishing { singleVariant("release") }

    // The test APK otherwise targets minSdk, and Android 16 covers it with a warning
    // dialog that hides the composition under test.
    testOptions { targetSdk = 34 }

    sourceSets["androidTest"].assets.srcDirs(
        rootProject.projectDir.parentFile.resolve("conformance/corpus"),
        rootProject.projectDir.parentFile.resolve("conformance/alt-text"),
    )
}

dependencies {
    api(project(":pdfcora"))
    implementation(platform("androidx.compose:compose-bom:2024.06.00"))
    implementation("androidx.compose.ui:ui")
    implementation("androidx.compose.foundation:foundation")
    implementation("androidx.compose.material3:material3")
    implementation("androidx.compose.material:material-icons-extended")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    androidTestImplementation(platform("androidx.compose:compose-bom:2024.06.00"))
    androidTestImplementation("androidx.compose.ui:ui-test-junit4")
    androidTestImplementation("com.google.android.apps.common.testing.accessibility.framework:accessibility-test-framework:4.1.1")
    // The framework declares Guava at runtime only; its result types are Guava collections.
    androidTestImplementation("com.google.guava:guava:31.0.1-android")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
    // The version the Compose BOM brings calls an InputManager method Android 16 removed.
    androidTestImplementation("androidx.test.espresso:espresso-core:3.7.0")
    debugImplementation("androidx.compose.ui:ui-test-manifest")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            artifactId = "pdfcora-ui"
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("PDFCora UI")
                description.set("Compose viewer, toolbar and review bar for PDFCora")
            }
        }
    }
}

apply(from = rootProject.projectDir.parentFile.resolve("gradle/central.gradle.kts"))
