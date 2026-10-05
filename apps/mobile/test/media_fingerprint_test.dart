import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('dev.jinchuan/media');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('Android 指纹通道只传原文件路径，保留完整哈希、大小与修改时间', () async {
    final expected = {
      'hash': sha256.convert([1, 2, 3]).toString(),
      'size': 3,
      'fileModified': 123456789,
    };
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'fingerprint');
      expect(call.arguments, {'path': '/synthetic/original.jpg'});
      return expected;
    });
    expect(await fingerprintAndroidFile('/synthetic/original.jpg'), expected);
  });

  test('无效原生指纹拒绝建立内容身份，不把局部哈希或空结果当成功', () async {
    for (final result in [
      null,
      {'hash': 'incomplete', 'size': 1, 'fileModified': 1},
      {'hash': 'a' * 64, 'size': -1, 'fileModified': 1},
      {'hash': 'a' * 64, 'size': 1.5, 'fileModified': 1},
      {'hash': 'a' * 64, 'size': 1},
    ]) {
      messenger.setMockMethodCallHandler(channel, (_) async => result);
      await expectLater(
        fingerprintAndroidFile('/synthetic/original.jpg'),
        throwsStateError,
      );
    }
  });

  test('原生读取失败保留错误，不回退到旧缓存指纹', () async {
    messenger.setMockMethodCallHandler(channel, (_) async {
      throw PlatformException(
        code: 'MEDIA_FINGERPRINT',
        message: '图片在读取期间被修改，请重试。',
      );
    });
    await expectLater(
      fingerprintAndroidFile('/synthetic/original.jpg'),
      throwsA(
        isA<PlatformException>().having(
          (error) => error.code,
          'code',
          'MEDIA_FINGERPRINT',
        ),
      ),
    );
  });

  test('完整内容指纹覆盖空文件、读块边界及尾部变化，原文件只读', () async {
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-fingerprint-',
    );
    final file = File('${directory.path}/synthetic.bin');
    for (final size in [0, 1, 256 * 1024, 256 * 1024 + 7]) {
      final bytes = Uint8List.fromList(
        List.generate(size, (index) => index % 251),
      );
      await file.writeAsBytes(bytes);
      final stat = await file.stat();
      final identity = await fingerprintFile(file.path);
      expect(identity['hash'], sha256.convert(bytes).toString());
      expect(identity['size'], size);
      expect(identity['fileModified'], stat.modified.millisecondsSinceEpoch);
      expect(await file.readAsBytes(), bytes);
      if (size > 0) {
        bytes[size - 1] ^= 1;
        await file.writeAsBytes(bytes);
        expect(
          (await fingerprintFile(file.path))['hash'],
          isNot(identity['hash']),
        );
      }
    }
  });
}
