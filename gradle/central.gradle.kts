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
            url.set("https://pdfcora.pages.dev")
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
                    url.set("https://pdfcora.pages.dev")
                }
            }
            scm {
                url.set("https://github.com/pdfcora/pdfcora")
                connection.set("scm:git:https://github.com/pdfcora/pdfcora.git")
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

// The binaries link PDFium and its bundled libraries, whose licences ask for their notices
// to travel with them, so every jar carries LICENSE.md and NOTICE.md under META-INF.
val legalFiles = rootProject.projectDir.parentFile.let { listOf(it.resolve("LICENSE.md"), it.resolve("NOTICE.md")) }
plugins.withId("java") {
    tasks.named<Jar>("jar") { from(legalFiles) { into("META-INF") } }
}
plugins.withId("com.android.library") {
    // Java resources of a library end up in the AAR's classes.jar.
    val legalDir = layout.buildDirectory.dir("generated/legal")
    val copyLegal = tasks.register<Copy>("copyLegalFiles") {
        from(legalFiles)
        into(legalDir.map { it.dir("META-INF") })
    }
    // Reflection, because a script applied with `apply(from = …)` cannot see AGP's types.
    (extensions.getByName("android") as ExtensionAware).let { android ->
        @Suppress("UNCHECKED_CAST")
        val sourceSets = android.javaClass.getMethod("getSourceSets").invoke(android) as NamedDomainObjectContainer<Any>
        val resources = sourceSets.getByName("main").javaClass.getMethod("getResources").invoke(sourceSets.getByName("main"))
        resources.javaClass.getMethod("srcDir", Any::class.java).invoke(resources, legalDir)
    }
    tasks.matching { it.name == "preBuild" }.configureEach { dependsOn(copyLegal) }
}

providers.environmentVariable("PDFCORA_SIGNING_KEY").orNull?.let { key ->
    configure<SigningExtension> {
        useInMemoryPgpKeys(key, providers.environmentVariable("PDFCORA_SIGNING_PASSWORD").orNull)
        sign(the<PublishingExtension>().publications)
    }
}
