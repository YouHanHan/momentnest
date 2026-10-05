package dev.jinchuan.jinchuan_mobile

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import androidx.exifinterface.media.ExifInterface
import android.content.ContentUris
import android.content.Intent
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.provider.MediaStore
import java.io.File
import java.util.UUID
import java.time.LocalDate
import java.time.Instant
import java.time.ZoneId
import java.util.concurrent.Executors

class MainActivity : FlutterActivity() {
    private val executor = Executors.newSingleThreadExecutor()
    private val familyEngine by lazy { FamilyMediaEngine(this) }
    private var avatarResult: MethodChannel.Result? = null
    private val avatarRequestCode = 5042

    // 优先保留 EXIF 原始拍摄日，没有时使用系统明确记录的拍摄时间。
    override fun configureFlutterEngine(flutterEngine: FlutterEngine) {
        super.configureFlutterEngine(flutterEngine)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.jinchuan/family")
            .setMethodCallHandler { call, result ->
                if (call.method == "chooseAvatar") {
                    if (avatarResult != null) {
                        result.error("AVATAR_BUSY", "请先完成当前头像选择。", null)
                        return@setMethodCallHandler
                    }
                    avatarResult = result
                    try {
                        val intent = if (Build.VERSION.SDK_INT >= 33) Intent(MediaStore.ACTION_PICK_IMAGES).setType("image/*")
                        else Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("image/*")
                        startActivityForResult(intent, avatarRequestCode)
                    } catch (error: Exception) {
                        avatarResult = null
                        result.error("AVATAR_PICK", error.message ?: "无法打开系统照片选择器。", null)
                    }
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
        val networkGuard = LanNetworkGuard(this)
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.jinchuan/network")
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
        MethodChannel(flutterEngine.dartExecutor.binaryMessenger, "dev.jinchuan/media")
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

    // 系统选图仅生成应用私有头像副本，原图与旧头像副本均保留。
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != avatarRequestCode) return
        val result = avatarResult ?: return
        avatarResult = null
        val uri = data?.data
        if (resultCode != Activity.RESULT_OK || uri == null) {
            result.success(null)
            return
        }
        executor.execute {
            try {
                val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
                contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, bounds) }
                if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw IllegalArgumentException("此格式暂不能用作头像，请选择 JPEG 或 PNG 照片。")
                val options = BitmapFactory.Options().apply { inSampleSize = 1 }
                while (maxOf(bounds.outWidth, bounds.outHeight) / options.inSampleSize > 1024) options.inSampleSize *= 2
                var bitmap = contentResolver.openInputStream(uri)?.use { BitmapFactory.decodeStream(it, null, options) }
                    ?: throw IllegalArgumentException("读取头像失败，请重新选择照片。")
                val orientation = try { contentResolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } } catch (_: Exception) { null }
                val matrix = Matrix()
                when (orientation) {
                    ExifInterface.ORIENTATION_FLIP_HORIZONTAL -> matrix.setScale(-1f, 1f)
                    ExifInterface.ORIENTATION_ROTATE_180 -> matrix.setRotate(180f)
                    ExifInterface.ORIENTATION_FLIP_VERTICAL -> matrix.setScale(1f, -1f)
                    ExifInterface.ORIENTATION_TRANSPOSE -> { matrix.setRotate(90f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_90 -> matrix.setRotate(90f)
                    ExifInterface.ORIENTATION_TRANSVERSE -> { matrix.setRotate(270f); matrix.postScale(-1f, 1f) }
                    ExifInterface.ORIENTATION_ROTATE_270 -> matrix.setRotate(270f)
                }
                if (!matrix.isIdentity) {
                    val rotated = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
                    if (rotated !== bitmap) bitmap.recycle()
                    bitmap = rotated
                }
                val directory = File(filesDir, "family-avatars").apply { mkdirs() }
                val file = File(directory, "${UUID.randomUUID()}.jpg")
                try {
                    file.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 90, it)) throw IllegalStateException("头像保存失败。") }
                } finally { bitmap.recycle() }
                runOnUiThread { result.success(file.absolutePath) }
            } catch (error: Exception) {
                runOnUiThread { result.error("AVATAR_READ", error.message ?: "头像读取失败。", null) }
            }
        }
    }

    override fun onDestroy() {
        avatarResult?.success(null)
        avatarResult = null
        executor.execute { familyEngine.close() }
        executor.shutdown()
        super.onDestroy()
    }
}
