plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.dokka")
    id("maven-publish")
}

group = "com.pdfcora"
// PKG-1: released alongside the core with a matching version. scripts/check-core-deps.sh
// fails the build if these drift apart.
version = "0.1.0"

android {
    namespace = "com.pdfcora.ai"
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

    // The contract answers are tested on, shared with the iOS and Web suites.
    sourceSets["androidTest"].assets.srcDirs(
        rootProject.projectDir.parentFile.resolve("conformance/fixtures"),
        rootProject.projectDir.parentFile.resolve("conformance/redaction"),
        rootProject.projectDir.parentFile.resolve("conformance/forms"),
        rootProject.projectDir.parentFile.resolve("conformance/alt-text"),
        rootProject.projectDir.parentFile.resolve("conformance/remediation"),
        rootProject.projectDir.parentFile.resolve("conformance/diff"),
    )
}

dependencies {
    // PKG-4: only the core's public API.
    api(project(":pdfcora"))
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")

    // On-device summaries. Needs API 26 while this module promises 23, so the manifest
    // overrides its floor and every call is guarded (PKG-3). Allowed here, never in the
    // core: scripts/check-core-deps.sh checks the core's resolved graph.
    implementation("com.google.mlkit:genai-summarization:1.0.0-beta1")
    implementation("com.google.mlkit:genai-image-description:1.0.0-beta1")

    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("org.json:json:20231013")

    androidTestImplementation("androidx.test.ext:junit:1.1.5")
    androidTestImplementation("androidx.test:runner:1.5.2")
    androidTestImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
}

publishing {
    publications {
        register<MavenPublication>("release") {
            artifactId = "pdfcora-ai"
            afterEvaluate { from(components["release"]) }
            pom {
                name.set("PDFCora AI")
                description.set("On-device AI for PDFCora")
            }
        }
    }
}

apply(from = rootProject.projectDir.parentFile.resolve("gradle/central.gradle.kts"))
