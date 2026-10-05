import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'models.dart';
import 'local_network.dart';

class ApiException implements Exception {
  ApiException(this.message, this.status);
  final String message;
  final int status;
  @override
  String toString() => message;
}

/// 每条连接固定证书指纹；不接受其他自签名证书或系统根证书替换。
class ReceiverApi {
  ReceiverApi({required String address, required this.fingerprint, this.token})
    : address = validateAddress(address) {
    _client = HttpClient(context: SecurityContext(withTrustedRoots: false))
      ..connectionTimeout = const Duration(seconds: 8)
      ..idleTimeout = const Duration(seconds: 15)
      ..badCertificateCallback = (certificate, host, port) =>
          host == this.address.host &&
          port == this.address.port &&
          sha256.convert(certificate.der).toString() == fingerprint;
    _client.findProxy = (_) => 'DIRECT';
  }
  final Uri address;
  final String fingerprint;
  final String? token;
  late final HttpClient _client;
  bool _closed = false;

  Future<Json> request(
    String method,
    String path, {
    Json? json,
    Uint8List? bytes,
  }) async {
    if (_closed) throw ApiException('连接已关闭，请重试。', 0);
    final uri = address.resolve(path);
    if (uri.origin != address.origin) throw ApiException('请求地址越出已配对电脑。', 0);
    await LocalNetwork.bind(address);
    if (_closed) throw ApiException('连接已关闭，请重试。', 0);
    final request = await _client
        .openUrl(method, uri)
        .timeout(const Duration(seconds: 10));
    request.followRedirects = false;
    request.persistentConnection = false;
    if (token != null) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
    final payload =
        bytes ?? (json == null ? null : utf8.encode(jsonEncode(json)));
    if (payload != null) {
      request.contentLength = payload.length;
      request.headers.contentType = bytes == null
          ? ContentType.json
          : ContentType.binary;
      request.add(payload);
    }
    final response = await request.close().timeout(const Duration(seconds: 90));
    if (response.statusCode >= 300 && response.statusCode < 400) {
      close();
      throw ApiException('局域网传输禁止跳转到其他地址。', response.statusCode);
    }
    final builder = BytesBuilder();
    await for (final chunk in response.timeout(const Duration(seconds: 30))) {
      if (builder.length + chunk.length > 2 * 1024 * 1024) {
        throw ApiException('电脑响应过大。', 0);
      }
      builder.add(chunk);
    }
    final value = jsonDecode(utf8.decode(builder.takeBytes())) as Json;
    if (response.statusCode != 200) {
      throw ApiException(
        value['error']?.toString() ?? '电脑拒绝了请求。',
        response.statusCode,
      );
    }
    return value;
  }

  void close() {
    _closed = true;
    _client.close(force: true);
  }

  /// 受认证的原文件流只写入应用缓存，完成大小和完整指纹核验后才可浏览。
  Future<void> download(
    String path,
    File destination, {
    required int expectedSize,
    required String expectedHash,
  }) async {
    if (_closed) throw ApiException('连接已关闭，请重试。', 0);
    final uri = address.resolve(path);
    if (uri.origin != address.origin) throw ApiException('请求地址越出已配对电脑。', 0);
    if (expectedSize <= 0 ||
        expectedSize > 2 * 1024 * 1024 * 1024 ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(expectedHash)) {
      throw ApiException('原文件记录无效。', 0);
    }
    await LocalNetwork.bind(address);
    final request = await _client
        .getUrl(uri)
        .timeout(const Duration(seconds: 10));
    request.followRedirects = false;
    request.persistentConnection = false;
    if (token != null) {
      request.headers.set(HttpHeaders.authorizationHeader, 'Bearer $token');
    }
    final response = await request.close().timeout(const Duration(seconds: 90));
    if (response.statusCode != 200) {
      throw ApiException('电脑无法提供此原文件，请确认目录仍可访问。', response.statusCode);
    }
    if (response.contentLength >= 0 && response.contentLength != expectedSize) {
      throw ApiException('原文件大小与同步记录不符。', 0);
    }
    final writer = await destination.open(mode: FileMode.write);
    var received = 0;
    try {
      await for (final chunk in response.timeout(const Duration(seconds: 30))) {
        received += chunk.length;
        if (_closed || received > expectedSize) {
          throw ApiException('原文件传输中断或大小超出记录。', 0);
        }
        await writer.writeFrom(chunk);
      }
      await writer.flush();
    } finally {
      await writer.close();
    }
    if (received != expectedSize ||
        (await sha256.bind(destination.openRead()).first).toString() !=
            expectedHash) {
      throw ApiException('原文件校验失败，未加入可用缓存。', 0);
    }
  }
}
