import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/background_work.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'v2_transfer_test.dart' as queue;

const chunkSize = 4 * 1024 * 1024;

/// 每个文件使用独立连接，合成接收端按已确认偏移返回断点与回执。
class ParallelReceiver {
  final sessions = <String, Json>{};
  final clients = <ParallelApi>[];
  final chunks = <Json>[];
  final creates = <String>[];
  final completes = <String>[];
  final gates = <String, Completer<void>>{};
  final entered = <String>{};
  final badReceipts = <String>{};
  final failures = <String, Object>{};
  Completer<void>? receiptGate;
  int maximumClients = 0;

  ParallelApi open() {
    final api = ParallelApi(this);
    clients.add(api);
    final count = clients.where((client) => !client.closed).length;
    if (count > maximumClients) maximumClients = count;
    return api;
  }

  void release(String id) {
    final gate = gates[id];
    if (gate != null && !gate.isCompleted) gate.complete();
  }

  void releaseAll() {
    for (final id in gates.keys) {
      release(id);
    }
    if (receiptGate?.isCompleted == false) receiptGate!.complete();
  }

  Future<Json> request(
    String method,
    String path,
    Json? json,
    Uint8List? bytes,
  ) async {
    if (path == '/v1/uploads') {
      final id = json!['clientKey'] as String;
      creates.add(id);
      sessions[id] = {
        ...json,
        'id': id,
        'offset': 0,
        'state': 'receiving',
        'archiveDate': '2026-02-28',
      };
      return Map.of(sessions[id]!);
    }
    final id = path.split('/')[3].split('?').first;
    final session = sessions[id]!;
    if (method == 'GET') return Map.of(session);
    if (method == 'PUT') {
      entered.add(id);
      await gates[id]?.future;
      if (failures[id] case final Object failure) throw failure;
      final offset = int.parse(Uri.parse(path).queryParameters['offset']!);
      expect(offset, session['offset']);
      expect(bytes!.length, inInclusiveRange(1, chunkSize));
      chunks.add({'id': id, 'offset': offset, 'length': bytes.length});
      session['offset'] = offset + bytes.length;
      return Map.of(session);
    }
    if (path.endsWith('/complete')) {
      completes.add(id);
      await receiptGate?.future;
      expect(session['offset'], session['size']);
      session['state'] = 'complete';
      session['receipt'] = {
        'receiverId': 'computer',
        'libraryId': 'old-library',
        'hash': badReceipts.contains(id) ? 'b' * 64 : session['hash'],
        'size': session['size'],
      };
      return Map.of(session);
    }
    throw StateError('未预期的合成请求 $method $path');
  }
}

class ParallelApi extends ReceiverApi {
  ParallelApi(this.receiver)
    : super(address: queue.computer.address, fingerprint: 'synthetic');
  final ParallelReceiver receiver;
  bool closed = false;
  int closes = 0;

  @override
  Future<Json> request(
    String method,
    String path, {
    Json? json,
    Uint8List? bytes,
  }) async {
    if (closed) throw const SocketException('合成连接已关闭');
    return receiver.request(method, path, json, bytes);
  }

  @override
  void close() {
    closes++;
    closed = true;
    super.close();
  }
}

class ParallelTransfer extends TransferController {
  ParallelTransfer(this.original, this.receiver, BackgroundWork background)
    : super(store: queue.MemoryQueueStore(), backgroundWork: background) {
    connection = queue.computer;
    connections = [queue.computer];
  }
  final File original;
  final ParallelReceiver receiver;
  final changedFiles = <String>{};
  final inspected = <String>[];

  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async =>
      receiver.open();
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    inspected.add(asset.id);
    return {
      'hash': (changedFiles.contains(asset.id) ? 'b' : 'a') * 64,
      'size': await original.length(),
      'path': original.path,
      'version': version(asset),
      'filename': '${asset.id}.jpg',
    };
  }

  @override
  Future<void> checkPhotos({bool restart = false}) async {}
}

Future<void> until(bool Function() ready) async {
  final deadline = DateTime.now().add(const Duration(seconds: 5));
  while (!ready()) {
    if (DateTime.now().isAfter(deadline)) fail('并发上传未在时限内达到预期状态');
    await Future<void>.delayed(const Duration(milliseconds: 1));
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const galleryChannel = MethodChannel('com.fluttercandies/photo_manager');
  const backgroundChannel = MethodChannel('dev.momentnest/background');
  late ParallelReceiver receiver;
  late ParallelTransfer model;
  late List<MethodCall> serviceCalls;
  late Future<void> job;
  late bool serviceReady;
  late bool disposed;

  setUp(() async {
    serviceCalls = [];
    serviceReady = true;
    disposed = false;
    messenger.setMockMethodCallHandler(backgroundChannel, (call) async {
      serviceCalls.add(call);
      return call.method == 'start' ? serviceReady : null;
    });
    messenger.setMockMethodCallHandler(galleryChannel, (call) async {
      if (call.method != 'fetchEntityProperties') return null;
      return {
        'id': (call.arguments as Map)['id'],
        'type': 1,
        'width': 2,
        'height': 2,
        'createDt': 1700000000,
        'modifiedDt': 1,
      };
    });
    final directory = await Directory.systemTemp.createTemp(
      'momentnest-parallel-',
    );
    final file = File('${directory.path}/synthetic.jpg');
    await file.writeAsBytes(Uint8List(chunkSize + 17));
    receiver = ParallelReceiver();
    model = ParallelTransfer(file, receiver, BackgroundWork(android: true));
    model.tasks = [
      for (final id in ['one', 'two', 'three', 'four', 'five'])
        queue.task(id, 'queued')
          ..data['offset'] = 0
          ..data['size'] = chunkSize + 17
          ..data['deviceId'] = 'phone',
    ];
    for (final task in model.tasks) {
      receiver.gates[task.id] = Completer<void>();
    }
    job = Future.value();
  });

  tearDown(() async {
    receiver.releaseAll();
    await job;
    if (!disposed) model.dispose();
    await Future<void>.delayed(Duration.zero);
    messenger.setMockMethodCallHandler(galleryChannel, null);
    messenger.setMockMethodCallHandler(backgroundChannel, null);
  });

  test('同时上传三个文件，单个完成后立即补位，各连接独立收尾', () async {
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    expect(receiver.creates, unorderedEquals(['one', 'two', 'three']));
    expect(receiver.maximumClients, 3);
    expect(model.tasks.skip(3).every((task) => task.state == 'queued'), isTrue);
    receiver.release('one');
    await until(() => receiver.entered.contains('four'));
    expect(model.tasks.first.state, 'complete');
    expect(receiver.clients.take(3).where((client) => client.closed).length, 1);
    expect(serviceCalls.where((call) => call.method == 'finish'), isEmpty);
    receiver.releaseAll();
    await job;
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
    expect(receiver.maximumClients, 3);
    expect(receiver.clients.every((client) => client.closes == 1), isTrue);
    expect(serviceCalls.where((call) => call.method == 'start').length, 1);
    expect(serviceCalls.where((call) => call.method == 'finish').length, 1);
  });

  test('暂停三个活动文件并保留各自确认偏移，继续不会重传已确认分块', () async {
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    model.pause();
    receiver.releaseAll();
    await job;
    expect(model.tasks.every((task) => task.state == 'paused'), isTrue);
    expect(model.tasks.take(3).map((task) => task.offset), [
      chunkSize,
      chunkSize,
      chunkSize,
    ]);
    expect(model.tasks.skip(3).map((task) => task.offset), [0, 0]);
    expect(receiver.completes, isEmpty);
    for (final task in model.tasks) {
      task.state = 'queued';
    }
    job = model.runQueue();
    await job;
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
    expect(receiver.creates.length, 5);
    for (final id in ['one', 'two', 'three']) {
      expect(
        receiver.chunks
            .where((chunk) => chunk['id'] == id)
            .map((chunk) => chunk['offset']),
        [0, chunkSize],
      );
    }
    expect(
      model.tasks.every((task) => task.data['archiveDate'] == '2026-02-28'),
      isTrue,
    );
  });

  test('最后一个分块期间暂停也不提前提交，续传从完整偏移取保存回执', () async {
    await model.original.writeAsBytes(Uint8List(17));
    for (final task in model.tasks) {
      task.data['size'] = 17;
    }
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    model.pause();
    receiver.releaseAll();
    await job;
    expect(receiver.completes, isEmpty);
    expect(
      model.tasks
          .take(3)
          .every((task) => task.offset == task.size && task.state == 'paused'),
      isTrue,
    );
    for (final task in model.tasks) {
      task.state = 'queued';
    }
    job = model.runQueue();
    await job;
    expect(receiver.chunks.length, 5);
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
  });

  test('断线停止领取新文件，其他文件收尾当前分块后暂停且不会重置离线状态', () async {
    receiver.failures['one'] = const SocketException('合成断线');
    model.online = true;
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    receiver.release('one');
    await until(() => model.tasks.first.state == 'failed');
    receiver.releaseAll();
    await job;
    expect(receiver.creates, unorderedEquals(['one', 'two', 'three']));
    expect(model.tasks.skip(1).every((task) => task.state == 'paused'), isTrue);
    expect(
      model.tasks.skip(1).take(2).every((task) => task.offset == chunkSize),
      isTrue,
    );
    expect(model.online, isFalse);
    expect(receiver.clients.every((client) => client.closed), isTrue);
  });

  test('单个原文件变化只失败本项，其他文件继续并取得各自回执', () async {
    model.changedFiles.add('one');
    receiver.releaseAll();
    job = model.runQueue();
    await job;
    expect(model.tasks.first.state, 'failed');
    expect(model.tasks.first.error, contains('原图已修改'));
    expect(
      model.tasks.skip(1).every((task) => task.state == 'complete'),
      isTrue,
    );
    expect(receiver.creates, isNot(contains('one')));
    expect(receiver.maximumClients, lessThanOrEqualTo(3));
  });

  test('并行发送完成仍等待保存回执，错误回执只使对应任务失败', () async {
    receiver.badReceipts.add('two');
    receiver.releaseAll();
    receiver.receiptGate = Completer<void>();
    job = model.runQueue();
    await until(() => receiver.completes.length == 3);
    expect(
      model.tasks
          .take(3)
          .every(
            (task) => task.state == 'checking' && task.data['receipt'] == null,
          ),
      isTrue,
    );
    expect(receiver.creates.length, 3);
    receiver.receiptGate!.complete();
    await job;
    expect(model.tasks[1].state, 'failed');
    expect(model.tasks[1].data['receipt'], isNull);
    expect(
      model.tasks
          .where((task) => task.id != 'two')
          .every((task) => task.state == 'complete'),
      isTrue,
    );
  });

  test('切入后台保持三个工作槽并继续后续文件，整个队列共用一次后台资格', () async {
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    model.foreground(false);
    receiver.releaseAll();
    await job;
    expect(model.tasks.every((task) => task.state == 'complete'), isTrue);
    expect(receiver.maximumClients, 3);
    expect(serviceCalls.where((call) => call.method == 'start').length, 1);
    expect(serviceCalls.where((call) => call.method == 'finish').length, 1);
  });

  test('后台启动失败不创建并行连接、不读取原图，全部任务保留为暂停', () async {
    serviceReady = false;
    job = model.runQueue();
    await job;
    expect(model.inspected, isEmpty);
    expect(receiver.clients, isEmpty);
    expect(model.tasks.every((task) => task.state == 'paused'), isTrue);
    expect(model.running, isFalse);
  });

  test('断线后其他文件迟到的有效回执可保存，但不能重新标记电脑在线或领取新任务', () async {
    receiver.receiptGate = Completer<void>();
    receiver.failures['one'] = const SocketException('合成断线');
    model.online = true;
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    receiver.release('two');
    receiver.release('three');
    await until(() => receiver.completes.length == 2);
    receiver.release('one');
    await until(() => model.tasks.first.state == 'failed');
    receiver.releaseAll();
    await job;
    expect(
      model.tasks.skip(1).take(2).every((task) => task.state == 'complete'),
      isTrue,
    );
    expect(model.tasks.skip(3).every((task) => task.state == 'paused'), isTrue);
    expect(receiver.creates.length, 3);
    expect(model.online, isFalse);
  });

  test('关闭控制器释放全部活动连接，不领取后续文件且可保留已确认偏移', () async {
    job = model.runQueue();
    await until(() => receiver.entered.length == 3);
    model.dispose();
    expect(receiver.clients.every((client) => client.closed), isTrue);
    receiver.releaseAll();
    await job;
    expect(receiver.creates.length, 3);
    expect(model.tasks.every((task) => task.state == 'paused'), isTrue);
    expect(model.running, isFalse);
    // 控制器已由本测试关闭，避免清理阶段重复调用 ChangeNotifier.dispose。
    disposed = true;
  });
}
