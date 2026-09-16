plugins {
    `java-library`
    `maven-publish`
}

group = "com.pdfiumkit"
// PKG-1: released alongside the core with a matching version.
version = "0.1.0"

// The Maven artifactId is pdfiumkit; without this the jar is named after the Gradle
// project instead, and the loose jar would not match the coordinates it publishes under.
base { archivesName = "pdfiumkit" }

java {
    // JNI, not the Foreign Function API, so the SDK runs on the JDK enterprises have.
    toolchain { languageVersion = JavaLanguageVersion.of(17) }
    withSourcesJar()
    withJavadocJar()
}

repositories { mavenCentral() }

// The sources are UTF-8. Without this, a JVM whose default encoding is not (a plain
// Linux container, for instance) fails to compile them.
tasks.withType<JavaCompile>().configureEach {
    options.encoding = "UTF-8"
}
tasks.withType<Javadoc>().configureEach {
    options.encoding = "UTF-8"
}

dependencies {
    testImplementation(platform("org.junit:junit-bom:5.10.2"))
    testImplementation("org.junit.jupiter:junit-jupiter")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// The engine libraries are built by scripts/build-jni.sh into src/main/resources/native.
// They are deliberately not committed: they are large, and they are built from the
// vendored engine like every other platform's binaries.
tasks.processResources {
    val native = layout.projectDirectory.dir("src/main/resources/native")
    if (!native.asFile.exists()) {
        logger.warn("no native engine in src/main/resources/native; run ./scripts/build-jni.sh")
    }
}

tasks.test {
    useJUnitPlatform()
    testLogging { events("passed", "failed", "skipped") }
    // The conformance fixtures every platform is tested against.
    systemProperty("pdfiumkit.conformance", rootProject.projectDir.parentFile.resolve("conformance").absolutePath)
}

publishing {
    repositories {
        // scripts/package-all.sh passes a directory to publish into, the same way the
        // Android module does, so a release can be tried before it is uploaded.
        providers.gradleProperty("distRepo").orNull?.let { dist ->
            maven { name = "dist"; url = uri(dist) }
        }
    }
    publications {
        create<MavenPublication>("maven") {
            artifactId = "pdfiumkit"
            from(components["java"])
            pom {
                name = "PdfiumKit for Java"
                description = "PDF SDK for the JVM, built on PDFium"
            }
        }
    }
}
