import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/background_work.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'v2_transfer_test.dart' as queue;

/// 回环协议测试使用真实 HttpClient，保持生产证书指纹校验。
class ProtocolHttp extends HttpOverrides {}

class ProtocolFixture {
  ProtocolFixture(this.process) {
    output = process.stdout
        .transform(utf8.decoder)
        .transform(const LineSplitter())
        .listen((line) {
          final value = jsonDecode(line) as Json;
          if (value['ready'] == true) {
            ready.complete(value);
          } else {
            final response = pending.remove(value['id']);
            if (value['error'] != null) {
              response?.completeError(StateError(value['error']));
            } else {
              response?.complete(value['value']);
            }
          }
        });
    errors = process.stderr.transform(utf8.decoder).listen(errorText.write);
  }
  final Process process;
  final ready = Completer<Json>();
  final pending = <int, Completer<dynamic>>{};
  final errorText = StringBuffer();
  late final StreamSubscription<String> output, errors;
  int nextId = 0;

  static Future<ProtocolFixture> start({required bool faults}) async {
    final process = await Process.start('node', [
      '--experimental-transform-types',
      'test/fixtures/receiver_protocol.mjs',
      if (faults) '--faults',
    ]);
    final fixture = ProtocolFixture(process);
    await fixture.ready.future.timeout(
      const Duration(seconds: 30),
      onTimeout: () => throw StateError('合成接收端未就绪：${fixture.errorText}'),
    );
    return fixture;
  }

  Future<dynamic> call(String method) {
    final id = ++nextId, response = Completer<dynamic>();
    pending[id] = response;
    process.stdin.writeln(jsonEncode({'id': id, 'method': method}));
    return response.future.timeout(const Duration(seconds: 30));
  }

  Future<void> close() async {
    try {
      await call('close');
      await process.stdin.close();
      expect(
        await process.exitCode.timeout(const Duration(seconds: 10)),
        0,
        reason: errorText.toString(),
      );
    } finally {
      await output.cancel();
      await errors.cancel();
    }
  }
}

class ProtocolTransfer extends TransferController {
  ProtocolTransfer(
    this.fixture,
    this.token,
    ReceiverConnection target, {
    List<UploadTask>? persisted,
  }) : super(
         store: queue.MemoryQueueStore(),
         backgroundWork: BackgroundWork(android: true),
       ) {
    connection = target;
    connections = [target];
    tasks = persisted ?? [];
  }
  final Json fixture;
  final String token;

  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async => ReceiverApi(
    address: target.address,
    fingerprint: target.fingerprint,
    token: token,
  );

  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    final file = (fixture['files'] as List).cast<Json>().firstWhere(
      (file) => file['id'] == asset.id,
    );
    return {
      ...await compute(fingerprintFile, file['path'] as String),
      'path': file['path'],
      'version': version(asset),
      'filename': '同名合成照片.png',
    };
  }

  @override
  Future<void> checkPhotos({bool restart = false}) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const gallery = MethodChannel('com.fluttercandies/photo_manager');
  const background = MethodChannel('dev.momentnest/background');

  setUp(() {
    messenger.setMockMethodCallHandler(
      background,
      (call) async => call.method == 'start' ? true : null,
    );
    messenger.setMockMethodCallHandler(
      gallery,
      (call) async => call.method == 'fetchEntityProperties'
          ? {
              'id': (call.arguments as Map)['id'],
              'type': 1,
              'width': 48,
              'height': 32,
              'createDt': 1700000000,
              'modifiedDt': 1,
            }
          : null,
    );
  });
  tearDown(() async {
    await Future<void>.delayed(Duration.zero);
    messenger.setMockMethodCallHandler(gallery, null);
    messenger.setMockMethodCallHandler(background, null);
  });

  for (final faults in [false, true]) {
    test(
      '真实 Dart HTTPS 上传${faults ? '丢失分块与保存响应后重建队列恢复' : '三个并发、同名文件与完整内容去重'}',
      () => HttpOverrides.runWithHttpOverrides(() async {
        final server = await ProtocolFixture.start(faults: faults);
        ProtocolTransfer? model;
        ReceiverApi? api;
        try {
          final fixture = await server.ready.future,
              pairing = fixture['pairing'] as Json;
          final first = ReceiverApi(
            address: fixture['address'],
            fingerprint: pairing['fingerprint'],
          );
          late Json paired;
          try {
            paired = await first.request(
              'POST',
              '/v1/pair',
              json: {'secret': pairing['secret'], 'name': '合成协议手机'},
            );
          } finally {
            first.close();
          }
          final target = ReceiverConnection(
            id: pairing['receiverId'],
            name: '合成回环接收端',
            address: fixture['address'],
            fingerprint: pairing['fingerprint'],
            deviceId: paired['deviceId'],
          );
          api = ReceiverApi(
            address: target.address,
            fingerprint: target.fingerprint,
            token: paired['token'],
          );
          final batch = await api.request(
            'POST',
            '/v1/batches',
            json: {
              'clientKey': newId(),
              'libraryId': fixture['libraryId'],
              'mode': 'manual',
              'manualDate': '2026-02-28',
            },
          );
          model = ProtocolTransfer(fixture, paired['token'], target);
          model.tasks = [
            for (final file in (fixture['files'] as List).cast<Json>())
              UploadTask({
                'id': file['id'],
                'assetId': file['id'],
                'receiverId': target.id,
                'libraryId': fixture['libraryId'],
                'deviceId': target.deviceId,
                'batchId': batch['id'],
                'filename': '同名合成照片.png',
                'hash': file['hash'],
                'size': file['size'],
                'offset': 0,
                'state': 'queued',
                'archiveDate': '2026-02-28',
              }),
          ];
          await model.runQueue();
          if (faults) {
            final lost = model.tasks.first;
            expect(lost.state, 'failed');
            expect(lost.offset, 0);
            final remote = await api.request(
              'GET',
              '/v1/uploads/${lost.data['sessionId']}',
            );
            expect(remote['offset'], 4 * 1024 * 1024);
            // 通过序列化重建控制器，避免只依赖上次运行的内存断点。
            for (
              var retry = 0;
              retry < 3 && model!.tasks.any((task) => task.state != 'complete');
              retry++
            ) {
              final persisted =
                  (jsonDecode(
                            jsonEncode(
                              model.tasks.map((task) => task.data).toList(),
                            ),
                          )
                          as List)
                      .map(
                        (data) => UploadTask(Map<String, dynamic>.from(data)),
                      )
                      .toList();
              model.dispose();
              model = ProtocolTransfer(
                fixture,
                paired['token'],
                target,
                persisted: persisted,
              );
              for (final task in model.tasks.where(
                (task) => ['paused', 'failed'].contains(task.state),
              )) {
                task.state = 'queued';
              }
              await model.runQueue();
            }
          }
          expect(
            model!.tasks.every((task) => task.state == 'complete'),
            isTrue,
            reason: model.tasks
                .map((task) => '${task.id}: ${task.state} ${task.error}')
                .join('\n'),
          );
          var inspected = await server.call('inspect') as Json;
          final deadline = DateTime.now().add(const Duration(seconds: 15));
          while ((inspected['media'] as Json)['total'] != 11 ||
              (inspected['jobs'] as List).any(
                (job) => job['state'] == 'running',
              )) {
            if (DateTime.now().isAfter(deadline)) fail('接收后的并发扫描或媒体索引未完成');
            await Future<void>.delayed(const Duration(milliseconds: 20));
            inspected = await server.call('inspect') as Json;
          }
          expect(
            ((inspected['media'] as Json)['items'] as List).every(
              (asset) => asset['available'] == true,
            ),
            isTrue,
          );
          expect(inspected['maximumChunks'], 3);
          expect((inspected['saved'] as List).length, 11);
          expect(
            inspected['dropped'],
            faults ? unorderedEquals(['chunk', 'receipt']) : isEmpty,
          );
          for (final task in model.tasks) {
            final receipt = task.data['receipt'] as Json;
            expect(receipt['hash'], task.hash);
            expect(receipt['size'], task.size);
            expect(receipt['receiverId'], target.id);
            expect(receipt['libraryId'], fixture['libraryId']);
            expect(receipt['relativePath'], startsWith('2026-02-28/'));
            final saved = (inspected['hashes'] as List).cast<Json>().firstWhere(
              (saved) => saved['id'] == receipt['id'],
            );
            expect(saved['hash'], task.hash);
            expect(saved['size'], task.size);
          }
          expect(
            model.tasks[0].data['receipt']['id'],
            model.tasks[11].data['receipt']['id'],
          );
          if (faults) {
            for (final id in ['photo-0', 'photo-1']) {
              final offsets = (inspected['chunks'] as List)
                  .cast<Json>()
                  .where((chunk) => chunk['task'] == id)
                  .map((chunk) => chunk['offset'])
                  .toList();
              expect(offsets, [0, 4 * 1024 * 1024]);
            }
          }
        } finally {
          model?.dispose();
          api?.close();
          await server.close();
        }
      }, ProtocolHttp()),
      timeout: const Timeout(Duration(minutes: 2)),
    );
  }
}
