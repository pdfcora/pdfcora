pluginManagement {
    repositories { google(); mavenCentral(); gradlePluginPortal() }
}
dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories { google(); mavenCentral() }
}
rootProject.name = "sample-ui"

// The SDK from this repository, resolved by its published coordinates. An app outside the
// repo would drop this line and depend on the released artifact instead.
includeBuild("../../android")
