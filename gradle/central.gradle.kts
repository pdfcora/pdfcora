// What Maven Central requires of every published module, shared by the Android and Java
// builds: a complete POM, a local repository to publish into, and signatures.
//
//   -PdistRepo=<dir>            publish into <dir> (scripts/package-all.sh, publish-maven.sh)
//   PDFCORA_SIGNING_KEY         an ASCII-armoured PGP private key; without it nothing is
//   PDFCORA_SIGNING_PASSWORD    signed, which is fine for local builds and not for Central

apply(plugin = "signing")

configure<PublishingExtension> {
    repositories {
        providers.gradleProperty("distRepo").orNull?.let { dist ->
            maven { name = "dist"; url = uri(dist) }
        }
    }
    publications.withType<MavenPublication>().configureEach {
        pom {
            url.set("https://pdfcora.com")
            licenses {
                license {
                    name.set("MIT License")
                    url.set("https://opensource.org/licenses/MIT")
                }
            }
            developers {
                developer {
                    id.set("pdfcora")
                    name.set("PDFCora")
                    url.set("https://pdfcora.com")
                }
            }
            scm {
                url.set("https://github.com/pdfcora/samples")
                connection.set("scm:git:https://github.com/pdfcora/samples.git")
            }
        }
    }
}

// Central requires a javadoc jar. AGP's own javadoc step cannot read sealed classes, so
// Android modules ship the Dokka HTML they already generate for the site.
plugins.withId("com.android.library") {
    val javadocJar = tasks.register<Jar>("dokkaJavadocJar") {
        archiveClassifier.set("javadoc")
        from(tasks.named("dokkaHtml"))
    }
    configure<PublishingExtension> {
        publications.withType<MavenPublication>().configureEach { artifact(javadocJar) }
    }
}

// Central requires a sources jar, and the source is not published, so every module ships
// one holding only a note. Central accepts this for closed-source artifacts.
val sourcesJar = tasks.register<Jar>("placeholderSourcesJar") {
    archiveClassifier.set("sources")
    from(resources.text.fromString("PDFCora is closed source. API reference: https://pdfcora.com/developers.html\n")) {
        rename { "README.txt" }
    }
}
configure<PublishingExtension> {
    publications.withType<MavenPublication>().configureEach { artifact(sourcesJar) }
}

providers.environmentVariable("PDFCORA_SIGNING_KEY").orNull?.let { key ->
    configure<SigningExtension> {
        useInMemoryPgpKeys(key, providers.environmentVariable("PDFCORA_SIGNING_PASSWORD").orNull)
        sign(the<PublishingExtension>().publications)
    }
}
