import 'dart:convert';
import 'dart:math';

typedef Json = Map<String, dynamic>;

String byteLabel(int bytes) => bytes < 1024
    ? '$bytes B'
    : bytes < 1024 * 1024
    ? '${(bytes / 1024).toStringAsFixed(1)} KB'
    : '${(bytes / 1024 / 1024).toStringAsFixed(1)} MB';

String newId() => List.generate(
  24,
  (_) => Random.secure().nextInt(256).toRadixString(16).padLeft(2, '0'),
).join();
String dateLabel(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}';

class ReceiverConnection {
  const ReceiverConnection({
    required this.id,
    required this.name,
    required this.address,
    required this.fingerprint,
    required this.deviceId,
  });
  final String id, name, address, fingerprint, deviceId;
  Json toJson() => {
    'id': id,
    'name': name,
    'address': address,
    'fingerprint': fingerprint,
    'deviceId': deviceId,
  };
  factory ReceiverConnection.fromJson(Json value) => ReceiverConnection(
    id: value['id'],
    name: value['name'],
    address: value['address'],
    fingerprint: value['fingerprint'],
    deviceId: value['deviceId'],
  );
  ReceiverConnection at(String value) => ReceiverConnection(
    id: id,
    name: name,
    address: value,
    fingerprint: fingerprint,
    deviceId: deviceId,
  );
}

class PairingPayload {
  PairingPayload(
    this.addresses,
    this.fingerprint,
    this.secret,
    this.receiverId,
    this.expiresAt,
  );
  final List<String> addresses;
  final String fingerprint, secret, receiverId;
  final int expiresAt;

  /// 仅接收本协议的 HTTPS 配对信息，证书身份来自用户主动扫描或粘贴。
  factory PairingPayload.parse(String text) {
    if (text.length > 16384) throw const FormatException('配对信息过长。');
    final value = jsonDecode(text) as Json;
    final addresses = (value['addresses'] as List).cast<String>();
    if (value['v'] != 1 ||
        addresses.isEmpty ||
        addresses.length > 32 ||
        !RegExp(r'^[a-f0-9]{64}$').hasMatch(value['fingerprint'] as String) ||
        !RegExp(r'^[a-f0-9]{48}$').hasMatch(value['secret'] as String)) {
      throw const FormatException('不是有效的拾光匣配对信息。');
    }
    for (final address in addresses) {
      validateAddress(address);
    }
    if ((value['expiresAt'] as int) < DateTime.now().millisecondsSinceEpoch) {
      throw const FormatException('配对信息已过期，请在电脑端重新生成。');
    }
    return PairingPayload(
      addresses,
      value['fingerprint'],
      value['secret'],
      value['receiverId'],
      value['expiresAt'],
    );
  }
}

Uri validateAddress(String value) {
  final uri = Uri.parse(value);
  if (uri.scheme != 'https' ||
      uri.host.isEmpty ||
      uri.userInfo.isNotEmpty ||
      uri.hasQuery ||
      uri.hasFragment ||
      uri.port < 1 ||
      uri.port > 65535 ||
      (uri.path.isNotEmpty && uri.path != '/')) {
    throw const FormatException('请输入 https://电脑IP:45831 格式的地址。');
  }
  if (!isLanIpv4(uri.host) && uri.host != '127.0.0.1') {
    throw const FormatException('仅支持局域网 IPv4 地址，不允许公网地址、域名或 IPv6。');
  }
  return uri;
}

/// 严格识别私有及链路本地 IPv4，不使用 DNS 解析或地址简写。
bool isLanIpv4(String value) {
  if (!RegExp(
    r'^(?:0|[1-9]\d{0,2})(?:\.(?:0|[1-9]\d{0,2})){3}$',
  ).hasMatch(value)) {
    return false;
  }
  final parts = value.split('.').map(int.parse).toList();
  if (parts.any((part) => part > 255)) return false;
  return parts[0] == 10 ||
      (parts[0] == 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] == 192 && parts[1] == 168) ||
      (parts[0] == 169 && parts[1] == 254 && parts[2] >= 1 && parts[2] <= 254);
}

/// 队列保存内容身份和批次规则，重启后使用原任务恢复。
class UploadTask {
  UploadTask(this.data);
  final Json data;
  String get id => data['id'];
  String get assetId => data['assetId'];
  String get receiverId => data['receiverId'];
  String get libraryId => data['libraryId'];
  /// 配对凭据重建服务端批次时，界面仍保留持久化的原批次分组。
  String get batchGroupId => data['batchKey'] as String? ?? data['originalBatchId'] as String? ?? data['batchId'] as String? ?? id;
  String get filename => data['filename'];
  String get hash => data['hash'];
  int get size => data['size'];
  int get offset => data['offset'] ?? 0;
  String get state => data['state'];
  set state(String value) => data['state'] = value;
  String get error => data['error'] ?? '';
}
