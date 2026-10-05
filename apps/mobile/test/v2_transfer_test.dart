import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/gallery_style.dart';
import 'package:momentnest_mobile/growth_timeline.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/transfer_batch_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:momentnest_mobile/transfer_task_screen.dart';
import 'package:photo_manager/photo_manager.dart';

const computer = ReceiverConnection(
  id: 'computer',
  name: '合成电脑',
  address: 'https://192.168.1.8:45831',
  fingerprint: 'synthetic',
  deviceId: 'phone',
);

UploadTask task(
  String id,
  String state, {
  String batch = 'batch',
  String library = 'old-library',
  bool receipt = false,
}) => UploadTask({
  'id': id,
  'assetId': id,
  'batchId': batch,
  'receiverId': 'computer',
  'libraryId': library,
  'libraryPath': 'D:/$library',
  'receiverName': '合成电脑',
  'filename': '$id.jpg',
  'hash': 'a' * 64,
  'size': 1024,
  'offset': state == 'checking' || state == 'complete' ? 1024 : 256,
  'state': state,
  'archiveDate': '2026-02-28',
  'createdAt': '2026-10-01T14:30:00',
  if (receipt)
    'receipt': {
      'receiverId': 'computer',
      'libraryId': library,
      'hash': 'a' * 64,
      'size': 1024,
    },
});

class MemoryQueueStore extends LocalStore {
  final preferences = <String, Object?>{};
  final saved = <String, Json>{};
  @override
  Future<void> saveTask(UploadTask task) async =>
      saved[task.id] = Map.of(task.data);
  @override
  Future<void> setPreference(String key, Object? value) async =>
      preferences[key] = value;
  @override
  Future<dynamic> preference(String key) async => preferences[key];
  @override
  Future<Map<String, Json>> observationsFor(
    String receiver,
    String library,
    List<String> assets,
  ) async => {};
  @override
  Future<void> observe(
    String asset,
    String receiver,
    String library,
    String version,
    Json data,
  ) async {}
}

class SnapshotApi extends ReceiverApi {
  SnapshotApi(this.snapshot)
    : super(address: computer.address, fingerprint: 'synthetic');
  final Future<Json> Function() snapshot;
  final batches = <Json>[];
  VoidCallback? onBatch;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? json,
    Uint8List? bytes,
  }) async {
    if (path == '/v1/receiver') return snapshot();
    if (path == '/v1/batches') {
      batches.add(Map.of(json!));
      onBatch?.call();
      return {'id': 'new-batch', 'uploadDate': '2026-10-01'};
    }
    if (path == '/v1/assets/check') {
      return {
        'roots': [],
        'results': [
          {'hash': 'a' * 64, 'size': 1024, 'complete': true, 'matches': []},
        ],
      };
    }
    throw StateError('不应调用 $method $path');
  }
}

class QueueController extends TransferController {
  QueueController(MemoryQueueStore store) : super(store: store);
  int runs = 0;
  String? captureDate = '2026-02-28', creationDate;
  final apis = <String, SnapshotApi>{};
  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async =>
      apis[target.id]!;
  @override
  Future<void> runQueue() async {
    runs++;
  }

  @override
  Future<void> checkPhotos({bool restart = false}) async {}
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async =>
      {
        'assetId': asset.id,
        'filename': '${asset.id}.jpg',
        'hash': 'a' * 64,
        'size': 1024,
        'version': 'v1',
        'captureDate': captureDate,
        'creationDate': creationDate,
        'kind': 'photo',
      };
}

Json snapshot(String? library, {bool available = true}) => {
  'receiverId': 'computer',
  'accepting': true,
  'currentLibraryId': library,
  'currentLibraryAvailable': available,
  'libraries': [
    for (final id in ['old-library', 'new-library'])
      {'id': id, 'name': id, 'path': 'D:/$id'},
  ],
};

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late MemoryQueueStore store;
  late QueueController model;
  setUp(() {
    store = MemoryQueueStore();
    model = QueueController(store)
      ..connection = computer
      ..connections = [computer];
  });
  tearDown(() {
    for (final api in model.apis.values) {
      api.close();
    }
    model.dispose();
  });

  test('当前库显式空值和离线禁止新任务，旧目录与日期不改', () {
    final old = task('old', 'paused');
    model.tasks = [old];
    model.applyReceiverSnapshot(snapshot('new-library'));
    expect(model.libraryId, 'new-library');
    model.requireCurrentLibrary();
    model.applyReceiverSnapshot(snapshot(null, available: false));
    expect(model.libraryId, isNull);
    expect(model.requireCurrentLibrary, throwsStateError);
    model.applyReceiverSnapshot(snapshot('new-library', available: false));
    expect(model.libraryId, 'new-library');
    expect(model.requireCurrentLibrary, throwsStateError);
    expect(old.libraryId, 'old-library');
    expect(old.data['archiveDate'], '2026-02-28');
  });

  test('旧接收端缺新字段兼容默认库，手机不能主动切库', () async {
    model.applyReceiverSnapshot({
      'libraries': [
        {'id': 'legacy'},
      ],
    });
    expect(model.libraryId, 'legacy');
    expect(model.currentLibraryAvailable, isTrue);
    await expectLater(model.selectLibrary('other'), throwsStateError);
    expect(model.libraryId, 'legacy');
  });

  test('旧电脑迟到响应与失败均不能覆盖新电脑在线和当前库', () async {
    final old = Completer<Json>();
    model.apis['computer'] = SnapshotApi(() => old.future);
    final pending = model.reconnect();
    await Future<void>.delayed(Duration.zero);
    final next = ReceiverConnection(
      id: 'next',
      name: '另一合成电脑',
      address: computer.address,
      fingerprint: 'synthetic',
      deviceId: 'next-phone',
    );
    model.connection = next;
    model.apis['next'] = SnapshotApi(
      () async => {...snapshot('new-library'), 'receiverId': 'next'},
    );
    await model.reconnect();
    old.complete(snapshot('old-library'));
    await pending;
    expect(model.libraryId, 'new-library');
    expect(model.online, isTrue);
    expect(store.preferences, isNot(contains('library:computer')));
    final failure = Completer<Json>();
    model.apis['next'] = SnapshotApi(() => failure.future);
    final lateFailure = model.reconnect();
    await Future<void>.delayed(Duration.zero);
    model.connection = computer;
    model.apis['computer'] = SnapshotApi(() async => snapshot('old-library'));
    await model.reconnect();
    failure.completeError(StateError('旧电脑断线'));
    await lateFailure;
    expect(model.libraryId, 'old-library');
    expect(model.online, isTrue);
  });

  test('确认期间电脑切库拒绝新batch，不修改已有任务', () async {
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'fetchEntityProperties'
              ? {'id': 'photo', 'type': 1, 'width': 10, 'height': 10}
              : null,
        );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    var current = 'old-library';
    final api = SnapshotApi(() async => snapshot(current));
    model.apis['computer'] = api;
    model.selected.add('photo');
    await model.prepareSelection();
    final old = task('old', 'paused');
    model.tasks = [old];
    current = 'new-library';
    await expectLater(model.enqueue(skipHistory: false), throwsStateError);
    expect(api.batches, isEmpty);
    expect(old.libraryId, 'old-library');
    expect(model.selected, {'photo'});
  });

  test('新batch冻结当前目标和日期偏好，异步等待不串入后续设置', () async {
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'fetchEntityProperties'
              ? {'id': 'photo', 'type': 1, 'width': 10, 'height': 10}
              : null,
        );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    final api = SnapshotApi(() async => snapshot('old-library'));
    model.apis['computer'] = api;
    model.selected.add('photo');
    await model.prepareSelection();
    model.mode = 'manual';
    model.manualDate = '2026-02-28';
    api.onBatch = () {
      model.libraryId = 'new-library';
      model.mode = 'upload';
      model.manualDate = '2026-10-02';
    };
    await model.enqueue(skipHistory: false);
    final created = model.tasks.single;
    expect(created.libraryId, 'old-library');
    expect(created.data['libraryPath'], 'D:/old-library');
    expect(created.data['mode'], 'manual');
    expect(created.data['archiveDate'], '2026-02-28');
    expect(created.data['batchId'], 'new-batch');
    expect(created.data['batchKey'], isNotEmpty);
    expect(store.saved[created.id]?['archiveDate'], '2026-02-28');
  });

  test('拍摄日期优先，缺失时冻结手机创建日，两者缺失才用批次上传日', () async {
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          channel,
          (call) async => call.method == 'fetchEntityProperties'
              ? {'id': 'photo', 'type': 1, 'width': 10, 'height': 10}
              : null,
        );
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null),
    );
    model.apis['computer'] = SnapshotApi(() async => snapshot('old-library'));
    for (final dates in [
      ('2024-02-29', '2024-03-01', '2024-02-29'),
      (null, '2024-02-29', '2024-02-29'),
      (null, null, '2026-10-01'),
    ]) {
      model.tasks.clear();
      model.captureDate = dates.$1;
      model.creationDate = dates.$2;
      model.selected.add('photo');
      await model.prepareSelection();
      await model.enqueue(skipHistory: false);
      final created = model.tasks.single;
      expect(created.data['captureDate'], dates.$1);
      expect(created.data['creationDate'], dates.$2);
      expect(created.data['archiveDate'], dates.$3);
      expect(store.saved[created.id]?['creationDate'], dates.$2);
      created.state = 'failed';
      model.creationDate = '2026-10-03';
      await model.retry(created);
      expect(created.data['archiveDate'], dates.$3);
      expect(created.data['creationDate'], dates.$2);
    }
  });

  test('批次按持久化标识分组，重配server batch变化仍稳定，日期相同不合并', () {
    final first = task('first', 'checking')
      ..data['batchKey'] = 'original-group';
    final second = task('second', 'failed', batch: 'repaired')
      ..data['batchKey'] = 'original-group';
    final other = task('other', 'failed', batch: 'other');
    final groups = transferBatches([first, second, other]);
    expect(groups, hasLength(2));
    expect(groups.where((group) => group.id == 'original-group').single.tasks, [
      first,
      second,
    ]);
    second.data['batchId'] = 'another-session-batch';
    expect(transferBatches([first, second, other]), hasLength(2));
  });

  test('重试仅指定批次失败项，成功/跳过/取消/别批次完全不变', () async {
    final saved = task('saved', 'complete', receipt: true),
        failure = task('failure', 'failed'),
        paused = task('paused', 'paused'),
        skipped = task('skip', 'skipped'),
        cancelled = task('cancel', 'cancelled'),
        other = task('other', 'failed', batch: 'other');
    model.tasks = [saved, failure, paused, skipped, cancelled, other];
    model.running = true;
    await expectLater(model.retryFailedBatch('batch'), throwsStateError);
    expect(store.saved, isEmpty);
    model.running = false;
    await model.retryFailedBatch('batch');
    expect(store.saved.keys, ['failure']);
    expect(failure.state, 'queued');
    expect(saved.state, 'complete');
    expect(paused.state, 'paused');
    expect(skipped.state, 'skipped');
    expect(cancelled.state, 'cancelled');
    expect(other.state, 'failed');
    expect(failure.libraryId, 'old-library');
    expect(failure.data['archiveDate'], '2026-02-28');
  });

  test('继续批次只处理暂停和排队，不隐式重试失败', () async {
    model.tasks = [
      task('paused', 'paused'),
      task('failed', 'failed'),
      task('other', 'paused', batch: 'other'),
    ];
    await model.continueBatch('batch');
    expect(model.tasks.map((task) => task.state), [
      'queued',
      'failed',
      'paused',
    ]);
    expect(store.saved.keys, ['paused']);
  });

  test('等待与错目标回执不计成功，跳过和取消独立统计', () {
    final incorrect = task('wrong', 'complete', receipt: true)
      ..data['receipt']['libraryId'] = 'elsewhere';
    final batch = transferBatches([
      task('saved', 'complete', receipt: true),
      task('waiting', 'checking'),
      incorrect,
      task('failed', 'failed'),
      task('skip', 'skipped'),
      task('cancel', 'cancelled'),
    ]).single;
    expect(batch.saved, 1);
    expect(batch.pending, 2);
    expect(batch.failed, 1);
    expect(batch.skipped, 1);
    expect(batch.cancelled, 1);
    expect(taskStatus(incorrect), '等待电脑确认');
  });

  test('成长月份使用自然日与月底周年，创建日期由调用方排除', () {
    expect(growthMonth('2024-01-31', '2024-02-28'), 0);
    expect(growthMonth('2024-01-31', '2024-02-29'), 1);
    expect(growthMonth('2024-01-31', '2024-03-30'), 1);
    expect(growthMonth('2024-01-31', '2024-03-31'), 2);
    expect(growthMonth('2024-01-31', '2024-01-30'), isNull);
    expect(growthRange('2024-01-31', 1), '2024-02-29 – 2024-03-30');
  });

  testWidgets('运行批次禁用失败重试；等待百分百用时钟及蓝灰条且无主导航', (tester) async {
    model.tasks = [task('waiting', 'checking'), task('failure', 'failed')];
    model.running = true;
    await tester.pumpWidget(
      MaterialApp(
        home: TransferBatchDetailScreen(controller: model, batchId: 'batch'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(NavigationBar), findsNothing);
    expect(
      tester
          .widget<FilledButton>(
            find.byKey(const ValueKey('batch-retry-failed')),
          )
          .onPressed,
      isNull,
    );
    expect(find.text('暂停队列后可重试'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('transfer-task-waiting')));
    await tester.pumpAndSettle();
    expect(find.text('等待电脑确认'), findsOneWidget);
    expect(find.byIcon(Icons.schedule), findsOneWidget);
    expect(find.byIcon(Icons.check_circle), findsNothing);
    expect(find.text('已保存'), findsNothing);
    final bar = tester.widget<LinearProgressIndicator>(
      find.byType(LinearProgressIndicator),
    );
    expect(bar.value, 1);
    expect(bar.color, transferPending);
    expect(find.text('暂停队列'), findsOneWidget);
    expect(find.byKey(const ValueKey('transfer-task-retry')), findsNothing);
  });
}
