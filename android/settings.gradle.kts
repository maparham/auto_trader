pluginManagement {
    // dl.google.com serves no plugin markers from this network; resolve the
    // google-services plugin by its module, which the Google mirror has.
    resolutionStrategy {
        eachPlugin {
            if (requested.id.id == "com.google.gms.google-services") {
                useModule("com.google.gms:google-services:${requested.version}")
            }
        }
    }
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
