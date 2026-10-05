package dev.momentnest.app

import java.io.File
import java.security.MessageDigest

/// 完整读取原文件计算 SHA-256，固定读块并校验读取期间的文件状态。
fun fingerprintMediaFile(file: File): Map<String, Any> {
    if (!file.isFile) throw IllegalStateException("照片不可读取，请检查相册权限。")
    val size = file.length()
    val modified = file.lastModified()
    if (size > 2L * 1024 * 1024 * 1024) {
        throw IllegalStateException("单个照片或视频不能超过 2 GiB。")
    }
    val digest = MessageDigest.getInstance("SHA-256")
    val buffer = ByteArray(256 * 1024)
    var readSize = 0L
    file.inputStream().use { input ->
        while (true) {
            val count = input.read(buffer)
            if (count < 0) break
            digest.update(buffer, 0, count)
            readSize += count
        }
    }
    if (!file.isFile || readSize != size || file.length() != size || file.lastModified() != modified) {
        throw IllegalStateException("图片在读取期间被修改，请重试。")
    }
    val hex = "0123456789abcdef"
    val hash = buildString(64) {
        for (byte in digest.digest()) {
            val value = byte.toInt() and 0xff
            append(hex[value ushr 4])
            append(hex[value and 0x0f])
        }
    }
    return mapOf("hash" to hash, "size" to size, "fileModified" to modified)
}
