import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/background_work.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'backup_test.dart' as backup;
import 'family_scan_resume_test.dart' as scan;
import 'v2_transfer_test.dart' as queue;

/// 合成接收端逐块确认，单独阻塞最终回执以验证后台完成语义。
class BackgroundReceiver extends ReceiverApi {
  BackgroundReceiver()
    : super(address: queue.computer.address, fingerprint: 'synthetic');
  final firstChunk = Completer<void>(), releaseChunk = Completer<void>();
  final bothChunks = Completer<void>();
  var startedChunks = 0;
  final committing = Completer<void>(), releaseReceipt = Completer<void>();
  final sessions = <String, Json>{};
  final chunks = <Json>[];
  bool wrongReceipt = false;

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? json,
    Uint8List? bytes,
  }) async {
    if (path == '/v1/uploads') {
      final id = json!['clientKey'] as String;
      return sessions[id] = {
        'id': id,
        'offset': 0,
        'state': 'uploading',
        'archiveDate': '2026-02-28',
      };
    }
    final id = path.split('/')[3].split('?').first;
    final session = sessions[id]!;
    if (method == 'GET') return Map.of(session);
    if (method == 'PUT') {
      if (!releaseChunk.isCompleted) {
        if (!firstChunk.isCompleted) firstChunk.complete();
        if (++startedChunks == 2) bothChunks.complete();
        await releaseChunk.future;
      }
      chunks.add({
        'id': id,
        'offset': session['offset'],
        'length': bytes!.length,
      });
      session['offset'] = (session['offset'] as int) + bytes.length;
      return Map.of(session);
    }
    if (path.endsWith('/complete')) {
      if (!committing.isCompleted) committing.complete();
      await releaseReceipt.future;
      session['state'] = 'complete';
      session['receipt'] = {
        'receiverId': 'computer',
        'libraryId': 'old-library',
        'hash': (wrongReceipt ? 'b' : 'a') * 64,
        'size': 4 * 1024 * 1024 + 17,
      };
      return Map.of(session);
    }
    throw StateError('未预期的合成请求 $method $path');
  }
}

class BackgroundTransfer extends TransferController {
  BackgroundTransfer(
    BackgroundWork background,
    this.original,
    this.api,
    queue.MemoryQueueStore store,
  ) : super(store: store, backgroundWork: background) {
    connection = queue.computer;
    connections = [queue.computer];
  }
  final File original;
  final BackgroundReceiver api;
  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async => api;
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async =>
      {
        'hash': 'a' * 64,
        'size': await original.length(),
        'path': original.path,
        'version': version(asset),
        'filename': '${asset.id}.jpg',
      };
  @override
  Future<void> checkPhotos({bool restart = false}) async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const channel = MethodChannel('dev.momentnest/background');
  const galleryChannel = MethodChannel('com.fluttercandies/photo_manager');
  const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
  late BackgroundWork background;
  late List<MethodCall> calls;
  late Directory directory;
  Future<Object?> Function(MethodCall)? respond;

  Future<void> interrupt([String reason = '合成系统后台时限']) async {
    await messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        MethodCall('interrupted', {'reason': reason}),
      ),
      (_) {},
    );
  }

  setUp(() async {
    calls = [];
    respond = null;
    directory = await Directory.systemTemp.createTemp('momentnest-background-');
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call);
      if (respond != null) return respond!(call);
      return call.method == 'start' ? true : null;
    });
    messenger.setMockMethodCallHandler(
      directoryChannel,
      (_) async => directory.path,
    );
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'ready': true},
    );
    messenger.setMockMethodCallHandler(
      galleryChannel,
      (call) async => call.method == 'fetchEntityProperties'
          ? {
              'id': (call.arguments as Map)['id'],
              'type': 1,
              'width': 2,
              'height': 2,
              'createDt': 1700000000,
              'modifiedDt': 1,
            }
          : null,
    );
    background = BackgroundWork(android: true);
  });

  tearDown(() async {
    background.dispose();
    await Future<void>.delayed(Duration.zero);
    for (final value in [
      channel,
      galleryChannel,
      directoryChannel,
      FamilyController.channel,
    ]) {
      messenger.setMockMethodCallHandler(value, null);
    }
  });

  Future<scan.ResumeFamily> family() async {
    final source = scan.ResumeSource();
    for (var index = 0; index < 5; index++) {
      final file = File('${directory.path}/$index.jpg');
      await file.writeAsString('synthetic-background-$index');
      source.items.add(scan.ResumeMedia('$index', file));
    }
    final transfer = scan.ResumeTransfer(backgroundWork: background);
    final result = scan.ResumeFamily(
      transfer,
      scan.ResumeStore(),
      scan.ResumeGateway(source),
    );
    addTearDown(() {
      result.dispose();
      transfer.dispose();
    });
    await result.initialize();
    return result;
  }

  Future<BackgroundTransfer> transfer() async {
    final file = File('${directory.path}/original.jpg');
    await file.writeAsBytes(Uint8List(4 * 1024 * 1024 + 17));
    final result = BackgroundTransfer(
      background,
      file,
      BackgroundReceiver(),
      queue.MemoryQueueStore(),
    );
    result.tasks = [
      for (final id in ['first', 'second'])
        queue.task(id, 'queued')
          ..data['offset'] = 0
          ..data['size'] = 4 * 1024 * 1024 + 17
          ..data['deviceId'] = 'phone',
    ];
    addTearDown(result.dispose);
    return result;
  }

  test('必须等待原生服务就绪才能后台执行，旧任务重复收尾不停止新任务', () async {
    final ack = Completer<bool>();
    respond = (call) async => call.method == 'start' ? ack.future : null;
    final pending = background.begin(BackgroundTask.transfer, '等待原生服务');
    expect(background.starting(BackgroundTask.transfer), isTrue);
    expect(background.allows(BackgroundTask.transfer), isFalse);
    ack.complete(true);
    final first = await pending;
    expect(background.allows(BackgroundTask.transfer), isTrue);
    await background.finish(first);
    final next = await background.begin(BackgroundTask.transfer, '新队列');
    await background.finish(first);
    expect(next.active, isTrue);
    expect(calls.where((call) => call.method == 'finish').length, 1);
    await background.finish(next);
  });

  test('通知进度合并为最新值，任务完成后不再发送通知更新', () async {
    final lease = await background.begin(BackgroundTask.faceScan, '0 / 10');
    for (var index = 1; index <= 10; index++) {
      background.update(lease, '$index / 10');
    }
    await Future<void>.delayed(const Duration(milliseconds: 1100));
    final updates = calls.where((call) => call.method == 'update').toList();
    expect(updates.length, 1);
    expect((updates.single.arguments as Map)['text'], '10 / 10');
    background.update(lease, '最后更新');
    await background.finish(lease);
    await Future<void>.delayed(const Duration(milliseconds: 1100));
    expect(calls.where((call) => call.method == 'update').length, 1);
  });

  test('系统中断发生在启动确认前，迟到确认不能重新授予后台资格', () async {
    final ack = Completer<bool>();
    respond = (call) async => call.method == 'start' ? ack.future : null;
    final pending = background.begin(BackgroundTask.faceScan, '准备识别');
    final expectation = expectLater(pending, throwsStateError);
    await Future<void>.delayed(Duration.zero);
    await interrupt();
    ack.complete(true);
    await expectation;
    expect(background.allows(BackgroundTask.faceScan), isFalse);
  });

  test('后台服务拒绝启动时不读取原图、不发送文件，队列保持可继续', () async {
    respond = (call) async {
      if (call.method == 'start') {
        throw PlatformException(code: 'BACKGROUND_START', message: '合成拒绝');
      }
      return null;
    };
    final model = await transfer();
    await model.runQueue();
    expect(model.tasks.every((task) => task.state == 'paused'), isTrue);
    expect(model.api.chunks, isEmpty);
    expect(model.notice, contains('合成拒绝'));
    expect(model.running, isFalse);
  });

  test('锁屏或离开界面仍上传后续分块和队列，成功必须等待匹配的保存回执', () async {
    final model = await transfer();
    final job = model.runQueue();
    await model.api.firstChunk.future;
    model.foreground(false);
    model.api.releaseChunk.complete();
    await model.api.committing.future;
    expect(model.tasks.any((task) => task.state == 'checking'), isTrue);
    expect(model.tasks.every((task) => task.data['receipt'] == null), isTrue);
    model.api.releaseReceipt.complete();
    await job;
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
    expect(model.api.chunks.length, 4);
    expect(
      model.tasks.every((task) => task.data['archiveDate'] == '2026-02-28'),
      isTrue,
    );
    expect(background.allows(BackgroundTask.transfer), isFalse);
  });

  test('通知暂停或系统超时只收尾当前分块，续传从已确认偏移继续', () async {
    final model = await transfer();
    final job = model.runQueue();
    // 等待两个分块均已开始，避免把尚未领取的任务误算为活动传输。
    await model.api.bothChunks.future.timeout(const Duration(seconds: 10));
    model.foreground(false);
    await interrupt();
    model.api.releaseChunk.complete();
    await job;
    expect(model.api.chunks.length, 2);
    expect(model.tasks.every((task) => task.offset == 4 * 1024 * 1024), isTrue);
    expect(model.tasks.every((task) => task.state == 'paused'), isTrue);
    expect(model.notice, contains('合成系统后台时限'));
    model.foreground(true);
    for (final task in model.tasks) {
      task.state = 'queued';
    }
    model.api.releaseReceipt.complete();
    await model.runQueue();
    expect(model.api.chunks[2]['offset'], 4 * 1024 * 1024);
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
  });

  test('后台收到不匹配的回执仍失败，不把发送字节当作保存成功', () async {
    final model = await transfer();
    model.api.wrongReceipt = true;
    final job = model.runQueue();
    await model.api.firstChunk.future;
    model.foreground(false);
    model.api.releaseChunk.complete();
    model.api.releaseReceipt.complete();
    await job;
    expect(model.tasks.every((task) => task.state == 'failed'), isTrue);
    expect(model.tasks.every((task) => task.data['receipt'] == null), isTrue);
  });

  test('进入后台仍分析剩余媒体，完成后释放人脸服务资格', () async {
    final model = await family();
    final gate = scan.AnalysisGate();
    model.gates['1'] = gate;
    final job = model.scan();
    await gate.started.future;
    model.foreground(false);
    model.transfer.foreground(false);
    expect(model.scanning, isTrue);
    expect(model.scanPaused, isFalse);
    gate.release.complete();
    await job;
    expect(model.analyzed, ['0', '1', '2', '3', '4']);
    expect(model.scanProcessed, 5);
    expect(model.maximumActive, 1);
    expect(background.allows(BackgroundTask.faceScan), isFalse);
  });

  test('通知暂停人脸整理后保存当前项，返回界面不自动重新扫描', () async {
    final model = await family();
    final gate = scan.AnalysisGate();
    model.gates['1'] = gate;
    final job = model.scan();
    await gate.started.future;
    await interrupt('合成通知暂停');
    gate.release.complete();
    await job;
    expect(model.scanProcessed, 2);
    expect(model.scanPaused, isTrue);
    model.foreground(false);
    model.foreground(true);
    await model.waitForScan();
    expect(model.analyzed, ['0', '1']);
    await model.scan();
    expect(model.analyzed, ['0', '1', '2', '3', '4']);
    expect(model.maximumActive, 1);
  });

  test('通知暂停也取消因同步暂缓的人脸自动恢复', () async {
    final model = await family();
    final gate = scan.AnalysisGate();
    model.gates['1'] = gate;
    final job = model.scan();
    await gate.started.future;
    model.transfer.running = true;
    model.transfer.changed();
    final transferLease = await background.begin(
      BackgroundTask.transfer,
      '合成同步',
    );
    gate.release.complete();
    await job;
    expect(model.scanning, isFalse);
    expect(model.scanPaused, isTrue);
    await interrupt('合成通知暂停全部任务');
    model.transfer.running = false;
    model.transfer.changed();
    model.foreground(true);
    await model.waitForScan();
    expect(model.analyzed, ['0', '1']);
    expect(model.scanPaused, isTrue);
    await background.finish(transferLease);
  });

  test('人脸服务启动失败保留未完成记录，并且不开始原生推理', () async {
    final model = await family();
    respond = (call) async => call.method == 'start' ? false : null;
    await model.scan();
    expect(model.analyzed, isEmpty);
    expect(model.scanPaused, isTrue);
    expect(model.notice, contains('后台服务未就绪'));
    expect(background.allows(BackgroundTask.faceScan), isFalse);
  });

  test('后台核对返回前台时沿用当前任务，不重新加载或中断核对范围', () async {
    final first = Completer<Json>();
    final model = backup.CheckController(
      (data) async => ((data['assets'] as List).single as Map)['hash'] == 'a'
          ? first.future
          : backup.result(data),
      backgroundWork: background,
    );
    addTearDown(model.dispose);
    final job = model.checkPhotos();
    while (model.inspected.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }
    model.foreground(false);
    model.foreground(true);
    expect(model.checking, isTrue);
    expect(model.busy, isFalse);
    first.complete(
      backup.result({
        'assets': [
          {'hash': 'a', 'size': 12},
        ],
      }),
    );
    await job;
    expect(model.inspected, ['a', 'b']);
    expect(model.checking, isFalse);
  });

  test('后台继续备份核对，系统停止后不再核对下一张', () async {
    final first = Completer<Json>();
    final model = backup.CheckController(
      (data) async => first.future,
      backgroundWork: background,
    );
    addTearDown(model.dispose);
    final job = model.checkPhotos();
    while (model.inspected.isEmpty) {
      await Future<void>.delayed(Duration.zero);
    }
    model.foreground(false);
    expect(model.checking, isTrue);
    await interrupt();
    first.complete(
      backup.result({
        'assets': [
          {'hash': 'a', 'size': 12},
        ],
      }),
    );
    await job;
    expect(model.inspected, ['a']);
    expect(model.checking, isFalse);
    expect(model.checkNotice, contains('合成系统后台时限'));
  });
}
