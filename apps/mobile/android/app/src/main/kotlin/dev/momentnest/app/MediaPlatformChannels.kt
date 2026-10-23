package dev.momentnest.app

import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import androidx.exifinterface.media.ExifInterface
import android.content.ContentUris
import android.provider.MediaStore
import java.io.File
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executors

import android.os.Handler
import android.os.Looper

/// 原生媒体处理归应用持有，避免关闭界面时中断后台推理。
class MediaPlatformChannels(private val app: MomentNestApplication) {
    val executor = Executors.newSingleThreadExecutor()
    private val familyEngine by lazy { FamilyMediaEngine(app) }
    private val contentResolver get() = app.contentResolver
    private fun runOnUiThread(action: () -> Unit) { Handler(Looper.getMainLooper()).post(action) }

    // 优先保留 EXIF 原始拍摄日，没有时使用系统明确记录的拍摄时间。
    fun configure(flutterEngine: FlutterEngine) {
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.momentnest/family")
            .setMethodCallHandler { call, result ->
                if (call.method == "chooseAvatar") {
                    val activity = app.activity
                    if (activity == null) result.error("AVATAR_PICK", "请回到应用后选择头像。", null)
                    else activity.chooseAvatar(result)
                    return@setMethodCallHandler
                }
                executor.execute {
                    try {
                        val value = when (call.method) {
                            "ready" -> familyEngine.ready()
                            "analyze" -> familyEngine.analyze(call.argument<String>("path") ?: "", call.argument<String>("kind") ?: "photo", call.argument<Int>("frames") ?: 4)
                            "watermark" -> {
                                val arguments = call.arguments as? Map<*, *> ?: throw IllegalArgumentException("水印参数无效。")
                                familyEngine.watermark(arguments.entries.associate { entry ->
                                    val key = entry.key as? String ?: throw IllegalArgumentException("水印参数名称无效。")
                                    key to entry.value
                                })
                            }
                            else -> null
                        }
                        runOnUiThread { if (value == null) result.notImplemented() else result.success(value) }
                    } catch (error: Exception) {
                        runOnUiThread { result.error("FAMILY_MEDIA", error.message ?: "媒体处理失败。", null) }
                    } catch (_: OutOfMemoryError) {
                        // 内存不足属于 Error，必须单独返回页面，避免工作线程异常终止进程。
                        familyEngine.close()
                        runOnUiThread { result.error("FAMILY_MEDIA_MEMORY", "手机可用内存不足，暂时无法处理媒体。请关闭其他应用后重试，或换一张分辨率较低的照片。", null) }
                    }
                }
            }
        val networkGuard = LanNetworkGuard(app)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.momentnest/network")
            .setMethodCallHandler { call, result ->
                if (call.method != "bindLan") {
                    result.notImplemented()
                } else {
                    try {
                        networkGuard.bind(call.argument<String>("host") ?: "")
                        result.success(null)
                    } catch (error: Exception) {
                        result.error("LAN_ONLY", error.message ?: "局域网不可用。", null)
                    }
                }
            }
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.momentnest/media")
            .setMethodCallHandler { call, result ->
                if (call.method == "sdkInt") {
                    result.success(android.os.Build.VERSION.SDK_INT)
                    return@setMethodCallHandler
                }
                if (call.method == "fingerprint") {
                    val path = call.argument<String>("path")
                    executor.execute {
                        try {
                            if (path.isNullOrBlank()) throw IllegalArgumentException("缺少原文件路径。")
                            val identity = fingerprintMediaFile(File(path))
                            runOnUiThread { result.success(identity) }
                        } catch (error: Exception) {
                            runOnUiThread { result.error("MEDIA_FINGERPRINT", error.message ?: "原文件指纹读取失败。", null) }
                        }
                    }
                    return@setMethodCallHandler
                }
                if (call.method == "creationDate") {
                    val assetId = call.argument<String>("assetId")
                    val kind = call.argument<String>("kind") ?: "photo"
                    executor.execute {
                        val date = sourceCreationDate(assetId, kind)
                        runOnUiThread { result.success(date) }
                    }
                    return@setMethodCallHandler
                }
                if (call.method != "captureDate") {
                    result.notImplemented()
                    return@setMethodCallHandler
                }
                val path = call.argument<String>("path")
                val assetId = call.argument<String>("assetId")
                val kind = call.argument<String>("kind") ?: "photo"
                executor.execute {
                    var date: String? = null
                    if (kind == "video") {
                        try { date = familyEngine.captureDate(path, assetId, kind) }
                        catch (_: Exception) { /* 无可靠拍摄日期时交给批次规则处理。 */ }
                        val captured = date
                        runOnUiThread { result.success(captured) }
                        return@execute
                    }
                    try {
                        val exif = path?.let { ExifInterface(it) }
                        val value = exif?.getAttribute(ExifInterface.TAG_DATETIME_ORIGINAL)
                        if (value != null && value.length >= 10) {
                            date = LocalDate.parse(value.substring(0, 10).replace(':', '-')).toString()
                        }
                    } catch (_: Exception) { /* 缺少有效元数据时继续查询系统拍摄时间。 */ }
                    if (date == null) {
                        try {
                            val id = assetId?.toLongOrNull()
                            if (id != null) {
                                val uri = ContentUris.withAppendedId(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, id)
                                contentResolver.query(uri, arrayOf(MediaStore.Images.Media.DATE_TAKEN), null, null, null)?.use { cursor ->
                                    if (cursor.moveToFirst()) {
                                        val millis = cursor.getLong(0)
                                        if (millis > 0) date = Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate().toString()
                                    }
                                }
                            }
                        } catch (_: Exception) { /* 返回空值，由批次规则明确回退到上传日。 */ }
                    }
                    val captured = date
                    runOnUiThread { result.success(captured) }
                }
            }
    }

    // 手机创建日使用媒体首次加入系统相册的时间，截图与微信保存图沿用此日期。
    private fun sourceCreationDate(assetId: String?, kind: String): String? {
        val id = assetId?.toLongOrNull() ?: return null
        val base = if (kind == "video") MediaStore.Video.Media.EXTERNAL_CONTENT_URI
            else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        return try {
            contentResolver.query(ContentUris.withAppendedId(base, id), arrayOf(MediaStore.MediaColumns.DATE_ADDED), null, null, null)?.use { cursor ->
                if (!cursor.moveToFirst() || cursor.isNull(0)) return@use null
                val seconds = cursor.getLong(0)
                if (seconds <= 0) null
                else Instant.ofEpochSecond(seconds).atZone(ZoneId.systemDefault()).toLocalDate().toString()
            }
        } catch (_: Exception) { null }
    }

}
