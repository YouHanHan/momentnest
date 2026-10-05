import 'dart:convert';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';

void main() {
  test('手动地址、配对地址和旧连接均不能发送到公网或域名', () {
    for (final host in [
      '10.0.0.2',
      '172.16.0.2',
      '172.31.255.254',
      '192.168.5.30',
      '169.254.2.1',
    ]) {
      expect(validateAddress('https://$host:45831').host, host);
    }
    for (final address in [
      'https://8.8.8.8:45831',
      'https://example.com',
      'https://172.15.0.1',
      'https://172.32.0.1',
      'https://100.64.0.1',
      'https://198.18.0.1',
      'https://[::1]',
      'https://[::ffff:192.168.1.1]',
      'https://192.168.001.1',
      'https://3232235777',
      'https://192.168.1',
      'https://192.168.1.1.example.com',
      'https://user@192.168.1.1',
      'http://192.168.1.1',
      'https://192.168.1.1:0',
    ]) {
      expect(
        () => validateAddress(address),
        throwsFormatException,
        reason: address,
      );
      expect(
        () => ReceiverApi(address: address, fingerprint: '0' * 64),
        throwsFormatException,
        reason: address,
      );
      final payload = jsonEncode({
        'v': 1,
        'addresses': [address],
        'fingerprint': '0' * 64,
        'secret': '1' * 48,
        'receiverId': 'test',
        'expiresAt': DateTime.now().millisecondsSinceEpoch + 60000,
      });
      expect(
        () => PairingPayload.parse(payload),
        throwsFormatException,
        reason: address,
      );
    }
  });
}
