pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "pdfiumkit-android"
include(":pdfiumkit")
include(":pdfiumkit-ai")
include(":pdfiumkit-ui")
include(":demo")
