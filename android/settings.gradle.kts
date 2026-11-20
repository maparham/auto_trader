pluginManagement {
    repositories {
        google()
        mavenCentral()
        gradlePluginPortal()
    }
}
dependencyResolutionManagement {
    // Settings-level repositories only: ~/.gradle/init.d/google-maven-mirror.gradle
    // adds its Google mirror here, and a project-level repository would hide these.
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google()
        mavenCentral()
    }
}
rootProject.name = "chartkar-android"
include(":app")
