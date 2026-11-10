buildscript {
    repositories {
        google()
        mavenCentral()
    }
    dependencies {
        // AGP 9.5 bundles Kotlin 2.2, which cannot read LiteRT-LM's Kotlin 2.4 metadata.
        classpath("org.jetbrains.kotlin:kotlin-gradle-plugin:2.4.0")
    }
}

plugins {
    id("com.android.application") version "9.5.1" apply false
    id("com.chaquo.python") version "17.2.0" apply false
}
