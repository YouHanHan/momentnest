import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/backup_catalog.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

AssetEntity photo(String id, int month, {int modified = 100}) => AssetEntity(
  id: id,
  typeInt: 1,
  width: 100,
  height: 100,
  createDateSecond: month == 0
      ? null
      : DateTime(2024, month, 5).millisecondsSinceEpoch ~/ 1000,
  modifiedDateSecond: modified,
  title: '$id.jpg',
);

class MemoryStore extends LocalStore {
  final Map<String, Map<String, Json>> saved = {};
  @override
  Future<void> observe(
    String asset,
    String receiver,
    String library,
    String version,
    Json data,
  ) async {
    (saved['$receiver:$library'] ??= {})[asset] = {...data, 'version': version};
  }

  @override
  Future<Map<String, Json>> observations(
    String receiver,
    String library,
  ) async => Map.of(saved['$receiver:$library'] ?? {});
  @override
  Future<void> setPreference(String key, Object? value) async {}

  @override
  Future<Map<String, Json>> observationsFor(
    String receiver,
    String library,
    List<String> assets,
  ) async {
    final values = saved['$receiver:$library'] ?? {};
    return {
      for (final id in assets)
        if (values.containsKey(id)) id: values[id]!,
    };
  }
}

class FakeApi extends ReceiverApi {
  FakeApi(this.check)
    : super(address: 'https://127.0.0.1:45831', fingerprint: 'test');
  final Future<Json> Function(Json) check;
  @override
  Future<Json> request(
    String method,
    String path, {
    Json? json,
    Uint8List? bytes,
  }) => check(json!);
}

class CheckController extends TransferController {
  CheckController(this.respond, {super.backgroundWork})
    : super(store: MemoryStore()) {
    ready = true;
    online = true;
    catalogComplete = true;
    connection = ReceiverConnection(
      id: 'computer',
      name: '电脑',
      address: 'https://192.168.1.2:45831',
      fingerprint: 'test',
      deviceId: 'phone',
    );
    libraryId = 'first';
    photos = [photo('a', 2), photo('b', 2), photo('c', 1), photo('d', 0)];
    selectedMonth = '2024-02';
    monthProgress.reset(2);
  }
  final Future<Json> Function(Json) respond;
  final List<String> inspected = [];
  final Set<String> unreadable = {};
  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async =>
      FakeApi(respond);
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    inspected.add(asset.id);
    expect(useCache, isTrue);
    if (unreadable.contains(asset.id)) throw StateError('照片不可读取');
    return {'hash': asset.id, 'size': 12, 'version': version(asset)};
  }
}

Json result(
  Json request, {
  bool complete = true,
  List<Json> matches = const [],
}) => {
  'results': [
    {
      ...(request['assets'] as List).single as Json,
      'receipt': null,
      'matches': matches,
      'complete': complete,
    },
  ],
  'roots': [],
};

void main() {
  test('历史回执明确缺失或损坏才需补传；不可访问和旧协议不能证明丢失', () {
    for (final state in ['missing', 'corrupt']) {
      expect(
        backupState({
          'previousReceipt': {'id': 'saved'},
          'receiptState': state,
          'complete': true,
        }),
        'missing',
      );
    }
    expect(
      backupState({
        'previousReceipt': {'id': 'saved'},
        'receiptState': 'unavailable',
        'complete': true,
      }),
      'unknown',
    );
    expect(
      backupState({
        'previousReceipt': {'id': 'saved'},
        'complete': true,
      }),
      'unknown',
    );
    expect(
      backupState({
        'receipt': {'id': 'saved'},
        'receiptState': 'present',
      }),
      'uploaded',
    );
  });

  test('反复核对保留同内容历史回执，编辑后的新内容不继承成功记录', () async {
    final model = CheckController((data) async => result(data));
    addTearDown(model.dispose);
    final asset = model.photos.first;
    final identity = {'hash': 'a', 'size': 12};
    final receipt = {'id': 'old-receipt'};
    await model.recordBackupObservation(
      asset,
      identity,
      {'receipt': receipt},
      'computer',
      'first',
    );
    final missing = await model.recordBackupObservation(
      asset,
      identity,
      {'receiptState': 'missing', 'complete': true},
      'computer',
      'first',
    );
    expect(missing['status'], 'missing');
    expect(missing['previousReceipt'], receipt);
    final again = await model.recordBackupObservation(
      asset,
      identity,
      {'receiptState': 'unavailable', 'complete': false},
      'computer',
      'first',
    );
    expect(again['status'], 'unknown');
    expect(again['previousReceipt'], receipt);
    final edited = await model.recordBackupObservation(
      photo('a', 2, modified: 200),
      {'hash': 'new', 'size': 15},
      {'complete': true, 'receiptState': 'none'},
      'computer',
      'first',
    );
    expect(edited['status'], 'pending');
    expect(edited['previousReceipt'], isNull);
  });
  test('月份覆盖跨年与未知日期；只上传严格排除待核对及其他目录已有', () {
    final model = CheckController((data) async => result(data));
    addTearDown(model.dispose);
    expect(model.monthPhotos.map((item) => item.id), ['a', 'b']);
    expect(photoMonth(photo('x', 12)), '2024-12');
    for (final asset in model.photos) {
      model.observations[asset.id] = {
        'version': model.version(asset),
        'status': asset.id == 'b' ? 'exists' : 'pending',
      };
      if (photoMonth(asset) == model.selectedMonth) {
        model.monthProgress.record(
          asset,
          asset.id == 'b' ? 'exists' : 'pending',
        );
      }
    }
    model.selectUnbackedMonth();
    expect(model.selected, {'a'});
    model.observations['a']!['status'] = 'unknown';
    model.monthProgress.record(model.photos.first, 'unknown');
    model.filter = 'pending';
    expect(model.visiblePhotos, isEmpty);
    expect(() => model.selectUnbackedMonth(), throwsStateError);
    expect(backupState({'complete': false, 'matches': []}), 'unknown');
    expect(
      backupState({
        'complete': false,
        'matches': [
          {'path': 'old.jpg'},
        ],
      }),
      'exists',
    );
    expect(backupState({'matches': []}), 'unknown');
  });

  test('只自动核对本月；再次浏览不重复核对；强制刷新仍限本月', () async {
    var requests = 0;
    final model = CheckController((data) async {
      requests++;
      return result(data);
    });
    addTearDown(model.dispose);
    await model.checkPhotos();
    expect(model.inspected, ['a', 'b']);
    expect(model.monthProgress.pending, 2);
    expect(model.tasks, isEmpty);
    await model.checkPhotos();
    expect(requests, 2);
    await model.checkPhotos(restart: true);
    expect(requests, 4);
    expect(model.status(model.photos[2]), 'unknown');
    final edited = photo('a', 2, modified: 200);
    expect(model.status(edited), 'unknown');
    expect(model.checking, isFalse);
  });

  test('切换接收目录时丢弃旧请求的迟到响应', () async {
    final old = Completer<Json>();
    final entered = Completer<Json>();
    final model = CheckController((data) {
      if (data['libraryId'] == 'first') {
        entered.complete(data);
        return old.future;
      }
      return Future.value(
        result(
          data,
          matches: [
            {'libraryId': 'first', 'path': 'old.jpg'},
          ],
        ),
      );
    });
    addTearDown(model.dispose);
    final first = model.checkPhotos();
    final request = await entered.future;
    model.applyReceiverSnapshot({
      'currentLibraryId': 'second',
      'currentLibraryAvailable': true,
      'libraries': [
        {'id': 'first'},
        {'id': 'second'},
      ],
    });
    old.complete(result(request));
    await first;
    await model.checkPhotos();
    expect(model.libraryId, 'second');
    expect(model.status(model.photos.first), 'exists');
    expect((model.store as MemoryStore).saved['computer:first'], isNull);
  });

  test('断网不把未知照片标成未备份；暂停与后台停止后续请求', () async {
    var requests = 0;
    final model = CheckController((data) async {
      requests++;
      throw const SocketException('disconnected');
    });
    addTearDown(model.dispose);
    await model.checkPhotos();
    expect(requests, 1);
    expect(model.online, isFalse);
    expect(model.monthProgress.pending, 0);
    model.online = true;
    model.stopChecking(pause: true);
    await model.checkPhotos();
    expect(requests, 1);
    model.foreground(false);
    await model.checkPhotos(restart: true);
    expect(requests, 1);
  });

  test('部分历史目录未扫描和不可读取照片保留待核对，其他照片继续处理', () async {
    final model = CheckController(
      (data) async => result(data, complete: false),
    );
    addTearDown(model.dispose);
    model.unreadable.add('a');
    await model.checkPhotos();
    expect(model.checkErrors.keys, ['a']);
    expect(model.status(model.photos[0]), 'unknown');
    expect(model.status(model.photos[1]), 'unknown');
    expect(model.monthProgress.pending, 0);
    expect(model.online, isTrue);
  });
}
