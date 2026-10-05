package dev.momentnest.app

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Matrix
import android.graphics.Paint
import android.graphics.RadialGradient
import android.graphics.Shader
import android.graphics.Typeface
import android.media.MediaMetadataRetriever
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import androidx.exifinterface.media.ExifInterface
import ai.onnxruntime.OnnxTensor
import ai.onnxruntime.OrtEnvironment
import ai.onnxruntime.OrtSession
import ai.onnxruntime.OrtLoggingLevel
import java.io.File
import java.nio.FloatBuffer
import java.time.Instant
import java.time.LocalDate
import java.time.ZoneId
import java.util.UUID
import kotlin.math.exp
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sqrt

/// 在工作线程中执行离线人脸分析和副本水印，原文件始终只读。
class FamilyMediaEngine(private val context: Context) : AutoCloseable {
    private val environment = OrtEnvironment.getEnvironment()
    private var detector: OrtSession? = null
    private var recognizer: OrtSession? = null

    private fun sessions(): Pair<OrtSession, OrtSession> {
        if (detector == null) {
            val options = OrtSession.SessionOptions()
            options.setIntraOpNumThreads(2)
            options.setSessionLogLevel(OrtLoggingLevel.ORT_LOGGING_LEVEL_ERROR)
            try {
                detector = environment.createSession(context.assets.open("face_detection_yunet_2023mar.onnx").use { it.readBytes() }, options)
                recognizer = environment.createSession(context.assets.open("face_recognition_sface_2021dec.onnx").use { it.readBytes() }, options)
            } catch (error: Exception) {
                detector?.close()
                detector = null
                throw IllegalStateException("离线人物模型无法载入：${error.message}", error)
            } finally {
                options.close()
            }
        }
        return Pair(detector!!, recognizer!!)
    }

    fun ready(): Map<String, Any> {
        sessions()
        return mapOf("ready" to true, "model" to "YuNet + SFace")
    }

    private data class Face(val box: FloatArray, val points: FloatArray, val score: Float)

    /// 照片使用有界缩放；视频均匀抽取最多八帧，避免读取完整视频到内存。
    fun analyze(path: String, kind: String, frames: Int): Map<String, Any> {
        val faces = mutableListOf<Map<String, Any>>()
        if (kind == "video") {
            val media = MediaMetadataRetriever()
            try {
                media.setDataSource(path)
                val duration = media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
                val count = frames.coerceIn(1, 8)
                for (index in 0 until count) {
                    val millis = if (duration <= 0) 0L else ((index + 0.5) * duration / count).toLong()
                    val bitmap = if (Build.VERSION.SDK_INT >= 27) {
                        media.getScaledFrameAtTime(millis * 1000, MediaMetadataRetriever.OPTION_CLOSEST, 960, 960)
                    } else {
                        media.getFrameAtTime(millis * 1000, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                    } ?: continue
                    try {
                        faces.addAll(detect(bitmap, millis.toDouble() / 1000, "frame-$index"))
                    } finally {
                        bitmap.recycle()
                    }
                }
            } finally {
                media.release()
            }
        } else {
            val bitmap = loadPhoto(path, 1280)
            try {
                faces.addAll(detect(bitmap, null, "photo"))
            } finally {
                bitmap.recycle()
            }
        }
        return mapOf("faces" to faces)
    }

    private fun tensor(bitmap: Bitmap, side: Int, rgb: Boolean): OnnxTensor {
        val small = Bitmap.createScaledBitmap(bitmap, side, side, true)
        val pixels = IntArray(side * side)
        small.getPixels(pixels, 0, side, 0, 0, side, side)
        if (small !== bitmap) small.recycle()
        val values = FloatArray(pixels.size * 3)
        for (index in pixels.indices) {
            val pixel = pixels[index]
            values[index] = (if (rgb) Color.red(pixel) else Color.blue(pixel)).toFloat()
            values[pixels.size + index] = Color.green(pixel).toFloat()
            values[2 * pixels.size + index] = (if (rgb) Color.blue(pixel) else Color.red(pixel)).toFloat()
        }
        return OnnxTensor.createTensor(environment, FloatBuffer.wrap(values), longArrayOf(1, 3, side.toLong(), side.toLong()))
    }

    private fun output(result: OrtSession.Result, name: String): FloatArray {
        val tensor = result.get(name).orElseThrow { IllegalStateException("人物模型输出缺失：$name") } as OnnxTensor
        val buffer = tensor.floatBuffer ?: throw IllegalStateException("人物模型输出类型不匹配。")
        val values = FloatArray(buffer.remaining())
        buffer.get(values)
        return values
    }

    /// YuNet 的三个尺度输出解码和非极大值抑制与 OpenCV 协议一致。
    private fun detect(bitmap: Bitmap, frame: Double?, prefix: String): List<Map<String, Any>> {
        val (detection, recognition) = sessions()
        val candidates = mutableListOf<Face>()
        val scale = 640f / max(bitmap.width, bitmap.height)
        val padded = Bitmap.createBitmap(640, 640, Bitmap.Config.ARGB_8888)
        Canvas(padded).drawBitmap(bitmap, Matrix().apply { setScale(scale, scale) }, Paint(Paint.FILTER_BITMAP_FLAG))
        tensor(padded, 640, false).use { input ->
            padded.recycle()
            detection.run(mapOf(detection.inputNames.first() to input)).use { result ->
                for (stride in intArrayOf(8, 16, 32)) {
                    val cls = output(result, "cls_$stride")
                    val obj = output(result, "obj_$stride")
                    val bbox = output(result, "bbox_$stride")
                    val kps = output(result, "kps_$stride")
                    val cols = 640 / stride
                    for (index in cls.indices) {
                        val score = sqrt(cls[index].coerceIn(0f, 1f) * obj[index].coerceIn(0f, 1f))
                        if (score < 0.75f) continue
                        val row = index / cols
                        val col = index % cols
                        val cx = (col + bbox[index * 4]) * stride
                        val cy = (row + bbox[index * 4 + 1]) * stride
                        if (cx >= bitmap.width * scale || cy >= bitmap.height * scale) continue
                        val width = exp(bbox[index * 4 + 2]) * stride
                        val height = exp(bbox[index * 4 + 3]) * stride
                        if (!width.isFinite() || !height.isFinite() || width < 8 || height < 8) continue
                        val points = FloatArray(10) { n -> (kps[index * 10 + n] + if (n % 2 == 0) col else row) * stride }
                        candidates.add(Face(floatArrayOf(cx - width / 2, cy - height / 2, width, height), points, score))
                    }
                }
            }
        }
        val selected = mutableListOf<Face>()
        for (face in candidates.sortedByDescending { it.score }.take(200)) {
            if (selected.none { overlap(it.box, face.box) > 0.3f }) selected.add(face)
            if (selected.size >= 20) break
        }
        return selected.mapIndexed { index, face ->
            val points = FloatArray(10) { n -> face.points[n] / scale }
            val crop = align(bitmap, points)
            val vector = try {
                tensor(crop, 112, true).use { input ->
                    recognition.run(mapOf(recognition.inputNames.first() to input)).use { result ->
                        val data = output(result, recognition.outputNames.first())
                        val norm = sqrt(data.fold(0.0) { sum, value -> sum + value * value }).toFloat()
                        if (data.size != 128 || norm <= 0 || !norm.isFinite()) throw IllegalStateException("人物特征无效。")
                        data.map { (it / norm).toDouble() }
                    }
                }
            } finally {
                crop.recycle()
            }
            mutableMapOf<String, Any>(
                "id" to "$prefix-$index", "x" to (face.box[0] / scale / bitmap.width).coerceIn(0f, 1f).toDouble(),
                "y" to (face.box[1] / scale / bitmap.height).coerceIn(0f, 1f).toDouble(),
                "width" to (face.box[2] / scale / bitmap.width).coerceIn(0f, 1f).toDouble(),
                "height" to (face.box[3] / scale / bitmap.height).coerceIn(0f, 1f).toDouble(),
                "score" to face.score.toDouble(), "embedding" to vector
            ).apply { if (frame != null) put("frameTime", frame) }
        }
    }

    private fun overlap(a: FloatArray, b: FloatArray): Float {
        val area = max(0f, min(a[0] + a[2], b[0] + b[2]) - max(a[0], b[0])) *
            max(0f, min(a[1] + a[3], b[1] + b[3]) - max(a[1], b[1]))
        return area / max(1f, a[2] * a[3] + b[2] * b[3] - area)
    }

    /// 五个关键点求最小二乘相似变换，保持眼睛、鼻尖和嘴角的相对位置。
    private fun align(bitmap: Bitmap, source: FloatArray): Bitmap {
        val target = floatArrayOf(38.2946f, 51.6963f, 73.5318f, 51.5014f, 56.0252f, 71.7366f, 41.5493f, 92.3655f, 70.7299f, 92.2041f)
        val sx = (0..4).sumOf { source[it * 2].toDouble() } / 5
        val sy = (0..4).sumOf { source[it * 2 + 1].toDouble() } / 5
        val tx = (0..4).sumOf { target[it * 2].toDouble() } / 5
        val ty = (0..4).sumOf { target[it * 2 + 1].toDouble() } / 5
        var denominator = 0.0
        var cosine = 0.0
        var sine = 0.0
        for (index in 0..4) {
            val x = source[index * 2] - sx
            val y = source[index * 2 + 1] - sy
            val u = target[index * 2] - tx
            val v = target[index * 2 + 1] - ty
            denominator += x * x + y * y
            cosine += x * u + y * v
            sine += x * v - y * u
        }
        if (denominator < 0.001) throw IllegalStateException("人脸关键点不足。")
        val a = cosine / denominator
        val b = sine / denominator
        val matrix = Matrix().apply { setValues(floatArrayOf(a.toFloat(), -b.toFloat(), (tx - a * sx + b * sy).toFloat(), b.toFloat(), a.toFloat(), (ty - b * sx - a * sy).toFloat(), 0f, 0f, 1f)) }
        val result = Bitmap.createBitmap(112, 112, Bitmap.Config.ARGB_8888)
        Canvas(result).drawBitmap(bitmap, matrix, Paint(Paint.ANTI_ALIAS_FLAG or Paint.FILTER_BITMAP_FLAG))
        return result
    }

    private fun loadPhoto(path: String, limit: Int): Bitmap {
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeFile(path, bounds)
        if (bounds.outWidth <= 0) throw IllegalStateException("该照片格式无法解码。")
        var sample = 1
        while (max(bounds.outWidth, bounds.outHeight) / sample > limit ||
            bounds.outWidth.toLong() * bounds.outHeight / sample / sample > 16_000_000) sample *= 2
        val bitmap = BitmapFactory.decodeFile(path, BitmapFactory.Options().apply { inSampleSize = sample })
            ?: throw IllegalStateException("照片无法读取。")
        val orientation = try { ExifInterface(path).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) } catch (_: Exception) { ExifInterface.ORIENTATION_NORMAL }
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
        if (matrix.isIdentity) return bitmap
        val corrected = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, true)
        if (corrected !== bitmap) bitmap.recycle()
        return corrected
    }

    fun captureDate(path: String?, assetId: String?, kind: String): String? {
        if (kind == "video" && path != null) {
            val media = MediaMetadataRetriever()
            try {
                media.setDataSource(path)
                val value = media.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DATE)
                if (value != null && value.length >= 8) return LocalDate.parse("${value.substring(0,4)}-${value.substring(4,6)}-${value.substring(6,8)}").toString()
            } catch (_: Exception) { /* 视频元数据缺失时使用系统拍摄时间。 */ }
            finally { media.release() }
        }
        val id = assetId?.toLongOrNull() ?: return null
        val base = if (kind == "video") MediaStore.Video.Media.EXTERNAL_CONTENT_URI else MediaStore.Images.Media.EXTERNAL_CONTENT_URI
        context.contentResolver.query(ContentUris.withAppendedId(base, id), arrayOf(MediaStore.MediaColumns.DATE_TAKEN), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst()) {
                val millis = cursor.getLong(0)
                if (millis > 0) return Instant.ofEpochMilli(millis).atZone(ZoneId.systemDefault()).toLocalDate().toString()
            }
        }
        return null
    }

    /// 预览使用较小副本；导出写入最长边 4096 像素的唯一命名 JPEG 副本。
    fun watermark(args: Map<String, Any?>): Map<String, Any> {
        val path = args["path"] as? String ?: throw IllegalArgumentException("缺少照片。")
        val preview = args["preview"] == true
        val photo = loadPhoto(path, if (preview) 1280 else 4096)
        if (!preview && photo.width.toLong() * photo.height > 50_000_000) {
            photo.recycle()
            throw IllegalStateException("照片分辨率过大，暂无法导出水印副本。")
        }
        val bitmap = photo.copy(Bitmap.Config.ARGB_8888, true)
        photo.recycle()
        try {
            val text = args["text"] as? String ?: ""
            require(text.isNotBlank() && text.length <= 200) { "请选择水印内容。" }
            if (args["template"] == "growth") {
                drawGrowthWatermark(bitmap, text, args)
            } else {
            val fontSize = (args["fontSize"] as? Number)?.toFloat()?.coerceIn(12f, 80f) ?: 28f
            val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply {
                color = Color.parseColor(args["color"] as? String ?: "#FFFFFF")
                alpha = (((args["opacity"] as? Number)?.toDouble() ?: 0.9).coerceIn(0.1, 1.0) * 255).toInt()
                textSize = max(12f, bitmap.width * fontSize / 1000)
                setShadowLayer(textSize / 12, 0f, 1f, Color.argb(160, 0, 0, 0))
            }
            val lines = text.split('\n')
            val padding = max(16f, bitmap.width * 0.035f)
            val position = args["position"] as? String ?: "bottom-right"
            val lineHeight = paint.textSize * 1.35f
            val canvas = Canvas(bitmap)
            for ((index, line) in lines.withIndex()) {
                if (paint.measureText(line) > bitmap.width - padding * 2) paint.textSize *= (bitmap.width - padding * 2) / paint.measureText(line)
                val x = if (position.endsWith("right")) bitmap.width - padding - paint.measureText(line) else padding
                val y = if (position.startsWith("top")) padding + paint.textSize + index * lineHeight else bitmap.height - padding - (lines.size - 1 - index) * lineHeight
                canvas.drawText(line, x, y, paint)
            }
            }
            val name = "MomentNest_${System.currentTimeMillis()}_${UUID.randomUUID().toString().take(8)}.jpg"
            val folder = if (preview) context.cacheDir else (context.getExternalFilesDir(Environment.DIRECTORY_PICTURES) ?: context.filesDir)
            val file = File(folder, name)
            // 仅创建新副本；同名文件不覆盖，失败后的副本也不删除。
            if (!file.createNewFile()) throw IllegalStateException("水印副本文件名已存在，请重试。")
            file.outputStream().use { if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 95, it)) throw IllegalStateException("水印副本写入失败。") }
            val capture = args["captureDate"] as? String
            if (!preview && capture != null) {
                val date = LocalDate.parse(capture)
                val exif = ExifInterface(file.absolutePath)
                exif.setAttribute(ExifInterface.TAG_DATETIME_ORIGINAL, "${date.toString().replace('-', ':')} 12:00:00")
                exif.saveAttributes()
            }
            var gallery = false
            if (!preview && Build.VERSION.SDK_INT >= 29) {
                val values = ContentValues().apply {
                    put(MediaStore.Images.Media.DISPLAY_NAME, name)
                    put(MediaStore.Images.Media.MIME_TYPE, "image/jpeg")
                    put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/MomentNest")
                    put(MediaStore.Images.Media.IS_PENDING, 1)
                }
                val uri = context.contentResolver.insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, values)
                if (uri != null) {
                    try {
                        context.contentResolver.openOutputStream(uri)?.use { stream -> file.inputStream().use { it.copyTo(stream) } }
                            ?: throw IllegalStateException("系统相册不可写。")
                        values.clear()
                        values.put(MediaStore.Images.Media.IS_PENDING, 0)
                        if (context.contentResolver.update(uri, values, null, null) != 1) {
                            throw IllegalStateException("系统相册未确认水印副本保存成功。")
                        }
                        gallery = true
                    } catch (error: Exception) {
                        // 未发布的相册项保持待完成状态，不清理任何图片或误报保存成功。
                        throw IllegalStateException("系统相册导出未确认成功。水印副本保留在应用导出目录，未完成的相册项也未删除；原照片未修改。", error)
                    }
                }
            }
            return mapOf("path" to file.absolutePath, "filename" to name, "gallery" to gallery)
        } finally {
            bitmap.recycle()
        }
    }

    /// 成长水印按照片短边同比例绘制两行，预览与导出使用同一排版和淡暗底衬。
    private fun drawGrowthWatermark(bitmap: Bitmap, text: String, args: Map<String, Any?>) {
        val lines = text.split('\n')
        require(lines.size in 1..2 && lines.none { it.isBlank() }) { "成长水印须包含一行成长文字及可选的拍摄日期。" }
        require(args["growthMode"] == "auto" || args["growthMode"] == "day-count") { "成长文字模式无效。" }
        val position = args["position"] as? String ?: "bottom-left"
        require(position in listOf("top-left", "top-right", "bottom-left", "bottom-right")) { "水印位置无效。" }
        val size = (args["fontSize"] as? Number)?.toFloat() ?: 48f
        val opacity = (args["opacity"] as? Number)?.toFloat() ?: 0.95f
        require(size.isFinite() && opacity.isFinite()) { "水印样式参数无效。" }
        val shortSide = min(bitmap.width, bitmap.height).toFloat()
        val padding = shortSide * 0.04f
        val alpha = (opacity.coerceIn(0.1f, 1f) * 255).toInt()
        val main = Paint(Paint.ANTI_ALIAS_FLAG).apply {
            color = Color.parseColor(args["color"] as? String ?: "#FFFFFF")
            this.alpha = alpha
            textSize = shortSide * size.coerceIn(12f, 80f) / 1000f
            typeface = Typeface.create("sans-serif", Typeface.BOLD)
        }
        val date = Paint(main).apply {
            textSize = main.textSize * 0.6f
            typeface = Typeface.create("sans-serif", Typeface.NORMAL)
        }
        val availableWidth = bitmap.width - padding * 2
        val width = max(main.measureText(lines[0]), if (lines.size == 2) date.measureText(lines[1]) else 0f)
        val scale = min(1f, availableWidth / max(1f, width))
        main.textSize *= scale
        date.textSize *= scale
        for (paint in listOf(main, date)) {
            paint.setShadowLayer(paint.textSize * 0.1f, 0f, paint.textSize * 0.025f, Color.argb((alpha * 0.3f).toInt(), 0, 0, 0))
        }
        val mainMetrics = main.fontMetrics
        val dateMetrics = date.fontMetrics
        val mainHeight = mainMetrics.descent - mainMetrics.ascent
        val dateHeight = dateMetrics.descent - dateMetrics.ascent
        val gap = main.textSize * 0.3f
        val blockHeight = mainHeight + if (lines.size == 2) gap + dateHeight else 0f
        val blockWidth = max(main.measureText(lines[0]), if (lines.size == 2) date.measureText(lines[1]) else 0f)
        val top = if (position.startsWith("top")) padding else bitmap.height - padding - blockHeight
        val left = if (position.endsWith("right")) bitmap.width - padding - blockWidth else padding
        val canvas = Canvas(bitmap)
        if (args["shade"] != false) {
            val shadePadding = min(padding, min((bitmap.width - blockWidth) / 2, (bitmap.height - blockHeight) / 2)).coerceAtLeast(0f)
            val radiusX = blockWidth / 2 + shadePadding
            val radiusY = blockHeight / 2 + shadePadding
            if (radiusX > 1f && radiusY > 1f) {
                val centerX = left + blockWidth / 2
                val centerY = top + blockHeight / 2
                // 椭圆暗底在文字周围轻微羽化，四边透明，不形成可见的黑色块状边界。
                val gradient = RadialGradient(0f, 0f, 1f, intArrayOf(
                    Color.argb((alpha * 0.22f).toInt(), 0, 0, 0),
                    Color.argb((alpha * 0.16f).toInt(), 0, 0, 0),
                    Color.argb((alpha * 0.06f).toInt(), 0, 0, 0),
                    Color.TRANSPARENT, Color.TRANSPARENT
                ), floatArrayOf(0f, 0.45f, 0.75f, 0.93f, 1f), Shader.TileMode.CLAMP)
                gradient.setLocalMatrix(Matrix().apply {
                    setScale(radiusX, radiusY)
                    postTranslate(centerX, centerY)
                })
                canvas.drawRect(centerX - radiusX, centerY - radiusY, centerX + radiusX, centerY + radiusY,
                    Paint(Paint.ANTI_ALIAS_FLAG).apply { shader = gradient })
            }
        }
        // 右侧角落按每一行的真实宽度对齐，短日期与昵称主行保持同一右边距。
        val mainLeft = if (position.endsWith("right")) bitmap.width - padding - main.measureText(lines[0]) else left
        canvas.drawText(lines[0], mainLeft, top - mainMetrics.ascent, main)
        if (lines.size == 2) {
            val dateLeft = if (position.endsWith("right")) bitmap.width - padding - date.measureText(lines[1]) else left
            canvas.drawText(lines[1], dateLeft, top + mainHeight + gap - dateMetrics.ascent, date)
        }
    }

    override fun close() {
        detector?.close()
        recognizer?.close()
        detector = null
        recognizer = null
    }
}
