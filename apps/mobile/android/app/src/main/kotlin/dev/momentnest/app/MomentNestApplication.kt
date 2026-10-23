package dev.momentnest.app

import android.app.Application
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.embedding.engine.dart.DartExecutor
import io.flutter.plugin.common.MethodChannel

/// 引擎和媒体通道归应用持有，界面离开后前台服务继续使用同一队列。
class MomentNestApplication : Application() {
    var engine: FlutterEngine? = null
        private set
    var activity: MainActivity? = null
    var backgroundChannel: MethodChannel? = null
        private set
    val media by lazy { MediaPlatformChannels(this) }

    fun obtainEngine(): FlutterEngine {
        engine?.let { return it }
        val created = FlutterEngine(this)
        engine = created
        media.configure(created)
        backgroundChannel = MethodChannel(created.dartExecutor.binaryMessenger, "dev.momentnest/background").apply {
            setMethodCallHandler { call, result -> BackgroundWorkService.handle(this@MomentNestApplication, call, result) }
        }
        created.dartExecutor.executeDartEntrypoint(DartExecutor.DartEntrypoint.createDefault())
        return created
    }
}
