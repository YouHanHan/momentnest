import 'dart:io';
import 'package:flutter/services.dart';

/// 在创建每条连接之前确认直连局域网，并固定 Android 使用的物理网络。
class LocalNetwork {
  static const _channel = MethodChannel('dev.jinchuan/network');

  static Future<void> bind(Uri address) async {
    if (Platform.isAndroid) {
      await _channel.invokeMethod<void>('bindLan', {'host': address.host});
      return;
    }
    // 非 Android 只允许本机协议测试，不能充当不受限制的发送端。
    if (address.host != '127.0.0.1') {
      throw const SocketException('当前平台仅允许本机协议测试。');
    }
  }
}
