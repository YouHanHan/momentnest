package dev.momentnest.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import io.flutter.plugin.common.MethodChannel

/// 仅在用户任务运行期间保留执行资源，停止或超时后立即释放。
class BackgroundWorkService : Service() {
    private val tasks = linkedMapOf<String, String>()
    private val handler = Handler(Looper.getMainLooper())
    private var cpuLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private val renewLocks = object : Runnable {
        override fun run() {
            if (tasks.isEmpty()) return
            cpuLock?.acquire(10 * 60 * 1000L)
            handler.postDelayed(this, 5 * 60 * 1000L)
        }
    }

    override fun onCreate() {
        super.onCreate()
        instance = this
        getSystemService(NotificationManager::class.java).createNotificationChannel(
            NotificationChannel(CHANNEL, "同步与人脸整理", NotificationManager.IMPORTANCE_LOW).apply {
                description = "显示照片同步、备份核对和人脸查找进度"
                setShowBadge(false)
            }
        )
        cpuLock = getSystemService(PowerManager::class.java)
            .newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "MomentNest:BackgroundWork")
            .apply { setReferenceCounted(false) }
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        instance = this
        if (intent?.action == PAUSE) {
            interrupt("已从通知栏暂停任务，进度已保留，可回到应用继续。")
            return START_NOT_STICKY
        }
        val task = intent?.getStringExtra("task")
        val reply = pendingStarts.remove(task)
        if (task !in TASKS || (application as MomentNestApplication).engine == null) {
            reply?.error("BACKGROUND_START", "请打开应用后再开始任务。", null)
            if (tasks.isEmpty()) stopSelf()
            return START_NOT_STICKY
        }
        addTask(task!!, intent?.getStringExtra("text") ?: "正在准备", reply)
        return START_NOT_STICKY
    }

    private fun addTask(task: String, text: String, reply: MethodChannel.Result?) {
        tasks[task] = text.take(160)
        try {
            refreshForeground()
            handler.removeCallbacks(renewLocks)
            renewLocks.run()
            refreshWifiLock()
            reply?.success(true)
        } catch (error: Exception) {
            interrupt("系统无法启动后台任务，进度已保留，请回到应用重试。")
            reply?.error("BACKGROUND_START", error.message ?: "系统不允许后台运行。", null)
            return
        }
        handler.post { (application as MomentNestApplication).activity?.requestTaskNotifications() }
    }

    private fun refreshForeground() {
        val open = PendingIntent.getActivity(this, 0,
            Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val pause = PendingIntent.getService(this, 1,
            Intent(this, BackgroundWorkService::class.java).setAction(PAUSE),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
        val lines = tasks.map { (task, text) -> "${label(task)}：$text" }
        val notification = Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.ic_background_work)
            .setContentTitle("拾光匣 · 任务进行中")
            .setContentText(lines.firstOrNull() ?: "正在准备")
            .setStyle(Notification.BigTextStyle().bigText(lines.joinToString("\n")))
            .setContentIntent(open)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .setCategory(Notification.CATEGORY_PROGRESS)
            .setVisibility(Notification.VISIBILITY_PRIVATE)
            .addAction(Notification.Action.Builder(null, "暂停任务", pause).build())
            .build()
        if (Build.VERSION.SDK_INT >= 29) {
            var type = 0
            if (tasks.keys.any { it != "faceScan" } || Build.VERSION.SDK_INT < 35) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC
            }
            if (Build.VERSION.SDK_INT >= 35 && "faceScan" in tasks) {
                type = type or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROCESSING
            }
            startForeground(NOTIFICATION, notification, type)
        } else {
            startForeground(NOTIFICATION, notification)
        }
    }

    @Suppress("DEPRECATION")
    private fun refreshWifiLock() {
        val networking = tasks.keys.any { it != "faceScan" }
        if (networking && wifiLock == null) {
            wifiLock = (applicationContext.getSystemService(Context.WIFI_SERVICE) as WifiManager)
                .createWifiLock(WifiManager.WIFI_MODE_FULL_HIGH_PERF, "MomentNest:Transfer")
                .apply { setReferenceCounted(false); acquire() }
        } else if (!networking) {
            wifiLock?.let { if (it.isHeld) it.release() }
            wifiLock = null
        }
    }

    private fun finishTask(task: String) {
        if (tasks.remove(task) == null) return
        if (tasks.isEmpty()) {
            releaseAndStop()
        } else {
            try {
                refreshForeground()
                refreshWifiLock()
            } catch (_: Exception) {
                interrupt("后台服务不可用，任务已暂停，进度已保留。")
            }
        }
    }

    /// Android 15 的服务配额用尽时立即停止，不依赖业务异步收尾完成。
    override fun onTimeout(startId: Int, fgsType: Int) {
        interrupt("已达到系统后台运行时限，进度已保留，请打开应用后继续。")
    }

    private fun interrupt(reason: String) {
        (application as MomentNestApplication).backgroundChannel?.invokeMethod("interrupted", mapOf("reason" to reason))
        tasks.clear()
        releaseAndStop()
    }

    private fun releaseLocks() {
        handler.removeCallbacks(renewLocks)
        cpuLock?.let { if (it.isHeld) it.release() }
        wifiLock?.let { if (it.isHeld) it.release() }
        wifiLock = null
    }

    private fun releaseAndStop() {
        releaseLocks()
        stopForeground(STOP_FOREGROUND_REMOVE)
        if (instance === this) instance = null
        stopSelf()
    }

    override fun onDestroy() {
        if (tasks.isNotEmpty()) {
            (application as MomentNestApplication).backgroundChannel?.invokeMethod("interrupted",
                mapOf("reason" to "后台服务已停止，进度已保留，请回到应用继续。"))
        }
        tasks.clear()
        releaseLocks()
        if (instance === this) instance = null
        super.onDestroy()
    }

    companion object {
        private const val CHANNEL = "momentnest-background-work"
        private const val NOTIFICATION = 5043
        private const val PAUSE = "dev.momentnest.PAUSE_BACKGROUND_WORK"
        private val TASKS = setOf("preparation", "transfer", "backupCheck", "faceScan")
        private var instance: BackgroundWorkService? = null
        private val pendingStarts = mutableMapOf<String?, MethodChannel.Result>()

        private fun label(task: String) = when (task) {
            "transfer" -> "照片同步"
            "faceScan" -> "查找人脸"
            "backupCheck" -> "备份核对"
            else -> "准备同步"
        }

        fun handle(app: MomentNestApplication, call: io.flutter.plugin.common.MethodCall, result: MethodChannel.Result) {
            if (call.method == "stopAll") {
                instance?.tasks?.clear()
                instance?.releaseAndStop()
                result.success(null)
                return
            }
            val task = call.argument<String>("task")
            if (task !in TASKS) {
                result.error("BACKGROUND_ARGUMENT", "后台任务类型无效。", null)
                return
            }
            when (call.method) {
                "start" -> {
                    val text = call.argument<String>("text") ?: "正在准备"
                    val service = instance
                    if (service != null) {
                        service.addTask(task!!, text, result)
                    } else if (app.activity?.taskForeground != true) {
                        result.error("BACKGROUND_START", "请回到应用后再开始任务。", null)
                    } else {
                        pendingStarts[task] = result
                        try {
                            app.startForegroundService(Intent(app, BackgroundWorkService::class.java)
                                .putExtra("task", task).putExtra("text", text.take(160)))
                        } catch (error: Exception) {
                            pendingStarts.remove(task)
                            result.error("BACKGROUND_START", error.message ?: "系统不允许后台运行。", null)
                        }
                    }
                }
                "update" -> {
                    val service = instance
                    if (service == null || !service.tasks.containsKey(task)) {
                        result.error("BACKGROUND_STOPPED", "后台服务已停止。", null)
                    } else {
                        service.tasks[task!!] = (call.argument<String>("text") ?: "正在处理").take(160)
                        try {
                            service.refreshForeground()
                            result.success(null)
                        } catch (error: Exception) {
                            service.interrupt("后台服务不可用，任务已暂停，进度已保留。")
                            result.error("BACKGROUND_STOPPED", error.message, null)
                        }
                    }
                }
                "finish" -> { instance?.finishTask(task!!); result.success(null) }
                else -> result.notImplemented()
            }
        }
    }
}
