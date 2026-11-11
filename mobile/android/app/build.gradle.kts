plugins {
    id("com.android.application")
    id("com.chaquo.python")
}

val mobileRoot: File = rootProject.projectDir.parentFile
val repoRoot: File = mobileRoot.parentFile
val payloadDir = layout.buildDirectory.dir("generated/payload")

android {
    namespace = "com.gambiteer.mobile"
    compileSdk = 36

    defaultConfig {
        applicationId = "com.gambiteer.mobile"
        minSdk = 33
        targetSdk = 36
        versionCode = 2
        versionName = "1.1"
        ndk {
            abiFilters += "arm64-v8a"
        }
    }

    packaging {
        jniLibs {
            // The chess engines are executables named lib*.so. They have to be extracted to the
            // native library directory, the only place Android lets an app execute a file.
            useLegacyPackaging = true
            keepDebugSymbols += setOf("**/libstockfish.so", "**/libfairy.so", "**/liblc0.so")
        }
    }

    sourceSets["main"].assets.directories.add(payloadDir.get().asFile.path)

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    androidResources {
        // The payload holds already-compressed audio and many small JSON files.
        noCompress += listOf("mp3", "gz")
    }
}

chaquopy {
    defaultConfig {
        version = "3.14"
        pip {
            options("--find-links", mobileRoot.resolve("third_party/wheels").path)
            install("-r", "requirements.txt")
        }
    }
    sourceSets {
        getByName("main") {
            srcDir("src/main/python")
            // The desktop backend is used as is: no copy of it lives in this folder.
            srcDir(repoRoot.resolve("backend"))
            include("mobile_boot.py", "app/**/*.py")
        }
    }
}

dependencies {
    implementation("com.google.ai.edge.litertlm:litertlm-android:0.19.1")
}

// Files the backend reads from disk: the phone web build, the opening data and the Maia networks.
val syncPayload by tasks.registering(Sync::class) {
    into(payloadDir.map { it.dir("payload") })
    from(mobileRoot.resolve("web/dist")) { into("web") }
    from(repoRoot.resolve("data/openings")) {
        into("openings")
        include("*.json")
    }
    from(mobileRoot.resolve("third_party/maia")) {
        into("maia")
        // The Android tools unpack and rename assets ending in .gz; Backend.kt removes this suffix.
        rename { "$it.asset" }
    }
    doFirst {
        check(mobileRoot.resolve("web/dist/index.html").isFile) {
            "web/dist is missing: run scripts/build-apk.py, or web/build.mjs first"
        }
    }
}

tasks.named("preBuild") { dependsOn(syncPayload) }
