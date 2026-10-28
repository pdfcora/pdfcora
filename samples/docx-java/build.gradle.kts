plugins {
    application
}

tasks.withType<JavaCompile> { options.release = 17 }

dependencies { implementation("com.pdfcora:pdfcora-java:0.1.0") }

application { mainClass = "Main" }

// Run from the sample's own folder so sample.docx is found and the output lands here.
tasks.named<JavaExec>("run") { workingDir = projectDir }
