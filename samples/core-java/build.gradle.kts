plugins {
    application
}

java { toolchain { languageVersion = JavaLanguageVersion.of(17) } }

dependencies { implementation("com.pdfiumkit:pdfiumkit:0.1.0") }

application { mainClass = "Main" }

// Run from the sample's own folder so sample.pdf is found and the output lands here.
tasks.named<JavaExec>("run") { workingDir = projectDir }
