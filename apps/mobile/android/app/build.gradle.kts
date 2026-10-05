import java.util.Properties

plugins {
    id("com.android.application")
    id("kotlin-android")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
}

// 私钥和密码只从本机忽略目录读取，调试构建继续使用原调试签名。
val releaseSigningProperties = Properties()
val releaseSigningFile = rootProject.file("../../../.local/momentnest-signing/release.properties")
if (releaseSigningFile.exists()) {
    releaseSigningFile.inputStream().use { releaseSigningProperties.load(it) }
}

android {
    namespace = "dev.momentnest.app"
    compileSdk = flutter.compileSdkVersion
    ndkVersion = flutter.ndkVersion

    // 离线人物模型随 APK 打包，运行时无需联网下载。
    sourceSets.getByName("main").assets.srcDir(rootProject.file("../../../models"))

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    kotlinOptions {
        jvmTarget = JavaVersion.VERSION_17.toString()
    }

    defaultConfig {
        // TODO: Specify your own unique Application ID (https://developer.android.com/studio/build/application-id.html).
        applicationId = "dev.momentnest.app"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = 26
        targetSdk = flutter.targetSdkVersion
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    signingConfigs {
        create("release") {
            storeFile = releaseSigningProperties.getProperty("storeFile")?.let { rootProject.file(it) }
            storePassword = releaseSigningProperties.getProperty("storePassword")
            keyAlias = releaseSigningProperties.getProperty("keyAlias")
            keyPassword = releaseSigningProperties.getProperty("keyPassword")
        }
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            // 上方模板注释保留；正式包使用正式证书，缺少配置时构建失败，不回退调试签名。
            signingConfig = signingConfigs.getByName("release")
        }
    }
}

flutter {
    source = "../.."
}

dependencies {
    implementation("androidx.exifinterface:exifinterface:1.4.1")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
}
