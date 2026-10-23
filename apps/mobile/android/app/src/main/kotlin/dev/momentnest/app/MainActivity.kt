package dev.momentnest.app

import io.flutter.embedding.android.FlutterActivity
import io.flutter.embedding.engine.FlutterEngine
import io.flutter.plugin.common.MethodChannel
import androidx.exifinterface.media.ExifInterface
import android.content.Intent
import android.app.Activity
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.os.Build
import android.provider.MediaStore
import java.io.File
import java.util.UUID

import android.content.Context
import android.Manifest
import android.content.pm.PackageManager

class MainActivity : FlutterActivity() {
    private val executor get() = (application as MomentNestApplication).media.executor
    private var avatarResult: MethodChannel.Result? = null
    private val avatarRequestCode = 5042
    var taskForeground = false
        private set

    override fun provideFlutterEngine(context: Context): FlutterEngine {
        val app = application as MomentNestApplication
        app.activity = this
        return app.obtainEngine()
    }

    override fun shouldDestroyEngineWithHost(): Boolean = false

    override fun onResume() {
        super.onResume()
        taskForeground = true
    }

    override fun onPause() {
        taskForeground = false
        super.onPause()
    }

    /// 通知授权只询问一次，拒绝不绕过系统决定，也不重复弹窗。
    fun requestTaskNotifications() {
        if (Build.VERSION.SDK_INT < 33 || !taskForeground ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) return
        val mediaGranted = checkSelfPermission(Manifest.permission.READ_MEDIA_IMAGES) == PackageManager.PERMISSION_GRANTED ||
            checkSelfPermission(Manifest.permission.READ_MEDIA_VIDEO) == PackageManager.PERMISSION_GRANTED ||
            (Build.VERSION.SDK_INT >= 34 && checkSelfPermission(Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) == PackageManager.PERMISSION_GRANTED)
        if (!mediaGranted) return
        val preferences = getSharedPreferences("background-work", MODE_PRIVATE)
        if (preferences.getBoolean("notification-requested", false)) return
        preferences.edit().putBoolean("notification-requested", true).apply()
        try { requestPermissions(arrayOf(Manifest.permission.POST_NOTIFICATIONS), 5044) }
        catch (_: Exception) { /* 通知授权失败时保留系统任务管理入口，不终止正在运行的任务。 */ }
    }

    /// 头像选择依赖当前界面，后台媒体处理仍使用应用级线程。
    fun chooseAvatar(result: MethodChannel.Result) {
        if (avatarResult != null) {
            result.error("AVATAR_BUSY", "请先完成当前头像选择。", null)
            return
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
        val app = application as MomentNestApplication
        if (app.activity === this) app.activity = null
        super.onDestroy()
    }
}
