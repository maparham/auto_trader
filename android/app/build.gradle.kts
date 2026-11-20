import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

// FCM push needs the Firebase config (app/google-services.json, gitignored,
// from the Firebase console). Without it the app builds and runs with push
// off: the bridge's fcm_token answers null and nothing registers.
if (file("google-services.json").exists()) {
    apply(plugin = "com.google.gms.google-services")
}

// Release signing reads the upload key from android/keystore.properties
// (gitignored; password, keyAlias, storeFile). Without it a release build is
// left unsigned, so a checkout with no key still builds. Debug builds use the
// debug key; both fingerprints are in chartkar.app's assetlinks.json.
val keystoreProperties = Properties().apply {
    val f = rootProject.file("keystore.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}

// `-PstartUrl=http://localhost:5173` points a debug build at a dev server
// (run `adb reverse tcp:5173 tcp:5173 && adb reverse tcp:8000 tcp:8000`).
val startUrl = (project.findProperty("startUrl") as String?) ?: "https://chartkar.app"

android {
    namespace = "app.chartkar.android"
    compileSdk = 36

    defaultConfig {
        applicationId = "app.chartkar.android"
        minSdk = 24
        targetSdk = 36
        // Above the Tauri app's 1000, so this build updates it in place.
        versionCode = 1001
        versionName = "0.2.0"
        buildConfigField("String", "START_URL", "\"$startUrl\"")
        manifestPlaceholders["usesCleartextTraffic"] = "false"
    }

    if (!keystoreProperties.isEmpty) {
        signingConfigs {
            create("release") {
                keyAlias = keystoreProperties.getProperty("keyAlias")
                keyPassword = keystoreProperties.getProperty("password")
                storeFile = file(keystoreProperties.getProperty("storeFile"))
                storePassword = keystoreProperties.getProperty("password")
            }
        }
    }

    buildTypes {
        getByName("debug") {
            // A debug build may point at http://localhost:5173, and installs
            // beside the real app instead of replacing it. Its App Link does
            // not verify (assetlinks.json names only the release id), so
            // browser sign-in needs the release build.
            applicationIdSuffix = ".dev"
            resValue("string", "app_name", "Chartkar dev")
            manifestPlaceholders["usesCleartextTraffic"] = "true"
        }
        getByName("release") {
            resValue("string", "app_name", "Chartkar")
            if (!keystoreProperties.isEmpty) signingConfig = signingConfigs.getByName("release")
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation(platform("com.google.firebase:firebase-bom:33.7.0"))
    implementation("com.google.firebase:firebase-messaging")
    testImplementation("junit:junit:4.13.2")
}
