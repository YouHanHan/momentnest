import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:crypto/crypto.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';

void main() {
  test(
    'Dart 手机协议与真实 Node 接收端互通，错误证书拒绝、正确原图可保存并去重',
    () async {
      final fixture = File('../desktop/test/protocol-fixture.ts').absolute.path;
      final process = await Process.start('node', [
        '--experimental-transform-types',
        fixture,
      ]);
      final lines = StreamIterator(
        process.stdout.transform(utf8.decoder).transform(const LineSplitter()),
      );
      final errors = process.stderr.transform(utf8.decoder).listen((_) {});
      ReceiverApi? api;
      try {
        expect(
          await lines.moveNext().timeout(const Duration(seconds: 20)),
          true,
        );
        final ready = jsonDecode(lines.current) as Json;
        final payload = PairingPayload.parse(jsonEncode(ready['pairing']));
        final wrong = ReceiverApi(
          address: payload.addresses.first,
          fingerprint: List.filled(64, '0').join(),
        );
        await expectLater(
          wrong.request('GET', '/v1/receiver'),
          throwsA(isA<HandshakeException>()),
        );
        wrong.close();
        final pairApi = ReceiverApi(
          address: payload.addresses.first,
          fingerprint: payload.fingerprint,
        );
        final paired = await pairApi.request(
          'POST',
          '/v1/pair',
          json: {'secret': payload.secret, 'name': 'Dart 协议测试'},
        );
        pairApi.close();
        api = ReceiverApi(
          address: payload.addresses.first,
          fingerprint: payload.fingerprint,
          token: paired['token'],
        );
        final receiver = await api.request('GET', '/v1/receiver');
        expect(receiver['receiverId'], payload.receiverId);
        final batch = await api.request(
          'POST',
          '/v1/batches',
          json: {
            'clientKey': newId(),
            'libraryId': ready['libraryId'],
            'mode': 'manual',
            'manualDate': '2026-09-20',
          },
        );
        final bytes = Uint8List.fromList(
          List.generate(100003, (index) => index % 251),
        );
        final hash = sha256.convert(bytes).toString();
        final create = {
          'clientKey': newId(),
          'batchId': batch['id'],
          'hash': hash,
          'size': bytes.length,
          'filename': 'test.jpg',
        };
        final upload = await api.request('POST', '/v1/uploads', json: create);
        final first = await api.request(
          'PUT',
          '/v1/uploads/${upload['id']}/content?offset=0',
          bytes: bytes.sublist(0, 101),
        );
        expect(first['offset'], 101);
        final resume = await api.request('GET', '/v1/uploads/${upload['id']}');
        expect(resume['offset'], 101);
        await api.request(
          'PUT',
          '/v1/uploads/${upload['id']}/content?offset=101',
          bytes: bytes.sublist(101),
        );
        final complete = await api.request(
          'POST',
          '/v1/uploads/${upload['id']}/complete',
          json: {},
        );
        expect(complete['state'], 'complete');
        expect(complete['receipt']['hash'], hash);
        final duplicate = await api.request(
          'POST',
          '/v1/uploads',
          json: {...create, 'clientKey': newId()},
        );
        expect(duplicate['receipt']['id'], complete['receipt']['id']);
        process.stdin.writeln(jsonEncode({'type': 'verify'}));
        await process.stdin.flush();
        expect(
          await lines.moveNext().timeout(const Duration(seconds: 10)),
          true,
        );
        final disk = jsonDecode(lines.current) as Json;
        expect(disk['files'], hasLength(1));
        expect(disk['files'][0]['hash'], hash);
        expect(disk['files'][0]['path'], startsWith('2026-09-20/'));
        final png = Uint8List.fromList(
          base64Decode(
            'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jU1sAAAAASUVORK5CYII=',
          ),
        );
        final pngHash = sha256.convert(png).toString();
        final captureBatch = await api.request(
          'POST',
          '/v1/batches',
          json: {
            'clientKey': newId(),
            'libraryId': ready['libraryId'],
            'mode': 'capture',
          },
        );
        final familyUpload = await api.request(
          'POST',
          '/v1/uploads',
          json: {
            'clientKey': newId(),
            'batchId': captureBatch['id'],
            'hash': pngHash,
            'size': png.length,
            'filename': 'family.png',
            'kind': 'photo',
            'creationDate': '2024-02-29',
          },
        );
        expect(familyUpload['archiveDate'], '2024-02-29');
        expect(familyUpload['dateSource'], 'creation');
        await api.request(
          'PUT',
          '/v1/uploads/${familyUpload['id']}/content?offset=0',
          bytes: png,
        );
        final savedScreenshot = await api.request(
          'POST',
          '/v1/uploads/${familyUpload['id']}/complete',
          json: {},
        );
        expect(savedScreenshot['receipt']['creationDate'], '2024-02-29');
        expect(
          savedScreenshot['receipt']['relativePath'],
          startsWith('2024-02-29/'),
        );
        final screenshotResume = await api.request(
          'GET',
          '/v1/uploads/${familyUpload['id']}',
        );
        expect(screenshotResume['archiveDate'], '2024-02-29');
        final babyId = newId(), assetId = '$pngHash-${png.length}';
        Json synchronized = {};
        for (var attempt = 0; attempt < 20; attempt++) {
          synchronized = await api.request(
            'POST',
            '/v1/family/sync',
            json: {
              'babies': [
                {
                  'id': babyId,
                  'name': '测试宝宝',
                  'birthday': '2026-01-31',
                  'autoMatch': true,
                  'referenceFaces': [],
                  'updatedAt': DateTime.now().toUtc().toIso8601String(),
                },
              ],
              'decisions': [
                {
                  'id': '$babyId-$assetId',
                  'babyId': babyId,
                  'assetId': assetId,
                  'state': 'included',
                  'origin': 'manual',
                  'updatedAt': DateTime.now().toUtc().toIso8601String(),
                },
              ],
              'dates': [
                {
                  'assetId': assetId,
                  'date': '2026-02-28',
                  'updatedAt': DateTime.now().toUtc().toIso8601String(),
                },
              ],
              'cursor': 0,
              'limit': 100,
              'decisionCursor': 0,
              'dateCursor': 0,
            },
          );
          if ((synchronized['assets'] as List).any(
            (value) => (value as Map)['id'] == assetId,
          )) {
            break;
          }
          await Future<void>.delayed(const Duration(milliseconds: 100));
        }
        expect(
          (synchronized['babies'] as List).any(
            (value) => (value as Map)['id'] == babyId,
          ),
          isTrue,
        );
        expect(
          (synchronized['assets'] as List).any(
            (value) => (value as Map)['id'] == assetId,
          ),
          isTrue,
        );
        expect(
          (synchronized['dates'] as List).any(
            (value) => (value as Map)['date'] == '2026-02-28',
          ),
          isTrue,
        );
        final thumb = await api.request(
          'GET',
          '/v1/family/assets/$assetId/thumb',
        );
        expect(thumb['dataUrl'], startsWith('data:image/'));
        final temporary = await Directory.systemTemp.createTemp(
          'jinchuan-mobile-download-',
        );
        final copied = File('${temporary.path}/verified.png');
        await api.download(
          '/v1/family/assets/$assetId/content',
          copied,
          expectedSize: png.length,
          expectedHash: pngHash,
        );
        expect(await copied.readAsBytes(), png);
        await expectLater(
          api.download(
            '/v1/family/assets/$assetId/content',
            File('${temporary.path}/rejected.png'),
            expectedSize: png.length,
            expectedHash: List.filled(64, '0').join(),
          ),
          throwsA(isA<ApiException>()),
        );
        process.stdin.writeln(jsonEncode({'type': 'redirect'}));
        await process.stdin.flush();
        expect(
          await lines.moveNext().timeout(const Duration(seconds: 10)),
          true,
        );
        expect(jsonDecode(lines.current)['redirect'], true);
        await expectLater(
          api.request('GET', '/v1/receiver'),
          throwsA(
            isA<ApiException>().having((error) => error.status, '拒绝跳转', 302),
          ),
        );
      } finally {
        api?.close();
        process.stdin.writeln(jsonEncode({'type': 'close'}));
        await process.stdin.flush();
        await process.exitCode.timeout(
          const Duration(seconds: 10),
          onTimeout: () {
            process.kill();
            return -1;
          },
        );
        await lines.cancel();
        await errors.cancel();
      }
    },
    timeout: const Timeout(Duration(seconds: 60)),
  );
}
