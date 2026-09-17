dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { mavenCentral() }
}
rootProject.name = "sample-pipeline-java"

// The SDK from this repository. The substitution is spelled out because the Gradle
// project is named for its folder while the SDK publishes as com.pdfcora:pdfcora.
includeBuild("../../java") {
    dependencySubstitution {
        substitute(module("com.pdfcora:pdfcora")).using(project(":"))
    }
}
