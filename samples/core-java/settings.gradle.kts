dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { mavenCentral() }
}
rootProject.name = "sample-core-java"

// The SDK from this repository, resolved by its published coordinates. An app outside
// the repo would drop this line and depend on the released artifact instead.
// The substitution is spelled out because the Gradle project is named for its folder
// while the SDK publishes as com.pdfcora:pdfcora.
includeBuild("../../java") {
    dependencySubstitution {
        substitute(module("com.pdfcora:pdfcora")).using(project(":"))
    }
}
