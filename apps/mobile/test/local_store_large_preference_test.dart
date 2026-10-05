import 'dart:convert';
import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sqflite/sqflite.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 模拟 Android 原生读取窗口，仍执行 LocalStore 的真实查询和恢复逻辑。
class CursorWindowFixture {
  final preferences = <String, String>{};
  final queries = <String>[];
  final transactions = <String>[];
  int maxReturnedBytes = 0, writes = 0;
  final windowBytes = 2 * 1024 * 1024;

  Future<Object?> handle(MethodCall call) async {
    if (call.method == 'getDatabasesPath') return '/synthetic-database';
    if (call.method == 'openDatabase') return {'id': 1};
    if (call.method == 'closeDatabase') return null;
    final arguments = Map<String, dynamic>.from(call.arguments as Map);
    final sql = arguments['sql'] as String;
    final parameters = arguments['arguments'] as List? ?? [];
    if (call.method == 'execute') {
      transactions.add(sql);
      return sql.startsWith('BEGIN') ? {'transactionId': 1} : null;
    }
    if (call.method == 'insert') {
      writes++;
      preferences[parameters[0] as String] = parameters[1] as String;
      return 1;
    }
    if (call.method == 'query') {
      if (sql == 'PRAGMA user_version') {
        return {
          'columns': ['user_version'],
          'rows': [
            [1],
          ],
        };
      }
      queries.add(sql);
      final value = preferences[parameters.last as String];
      if (value == null) {
        return {
          'columns': ['value'],
          'rows': [],
        };
      }
      final result = sql.startsWith('SELECT substr(value, ?, ?)')
          ? String.fromCharCodes(
              value.runes
                  .skip((parameters[0] as int) - 1)
                  .take(parameters[1] as int),
            )
          : value;
      final bytes = utf8.encode(result).length;
      if (bytes > windowBytes) {
        throw PlatformException(
          code: 'sqlite_error',
          message: 'Row too big to fit into CursorWindow',
        );
      }
      if (bytes > maxReturnedBytes) maxReturnedBytes = bytes;
      return {
        'columns': ['value'],
        'rows': [
          [result],
        ],
      };
    }
    throw StateError('测试夹具未处理 ${call.method}');
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  databaseFactory = databaseFactorySqflitePlugin;
  const sqliteChannel = MethodChannel('com.tekartik.sqflite');
  const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late CursorWindowFixture fixture;
  late LocalStore store;

  setUp(() async {
    fixture = CursorWindowFixture();
    messenger.setMockMethodCallHandler(sqliteChannel, fixture.handle);
    store = LocalStore();
    await store.open();
    fixture.queries.clear();
    fixture.transactions.clear();
  });

  tearDown(() async {
    await store.close();
    messenger.setMockMethodCallHandler(sqliteChannel, null);
    messenger.setMockMethodCallHandler(directoryChannel, null);
    messenger.setMockMethodCallHandler(FamilyController.channel, null);
  });

  List<Map<String, Object?>> largeAssets() => List.generate(
    1600,
    (index) => {
      'id': 'photo-$index',
      'filename': '宝宝👶第$index天.jpg',
      '_localId': 'phone-$index',
      'faces': [
        {
          'id': 'face-$index',
          'embedding': List.generate(128, (axis) => 1 / (axis + 1)),
        },
      ],
    },
  );

  test('超过 Android 单行窗口的旧照片索引完整恢复，读取不改写记录', () async {
    final assets = largeAssets();
    final original = jsonEncode(assets);
    expect(utf8.encode(original).length, greaterThan(fixture.windowBytes));
    fixture.preferences['family-assets'] = original;
    final database = await openDatabase('/synthetic-database/jinchuan.sqlite');
    await expectLater(
      database.query(
        'preferences',
        where: 'key=?',
        whereArgs: ['family-assets'],
      ),
      throwsA(isA<DatabaseException>()),
    );
    expect(await store.preference('family-assets'), assets);
    expect(fixture.maxReturnedBytes, lessThanOrEqualTo(256 * 1024));
    expect(fixture.queries.length, greaterThan(1));
    expect(fixture.transactions.first, startsWith('BEGIN'));
    expect(fixture.transactions.last, 'COMMIT');
    expect(fixture.writes, 0);
    expect(fixture.preferences['family-assets'], original);
  });

  test('中文和补充平面字符跨分段边界无损，恰好一段也完整解码', () async {
    for (final text in [
      '👶' * (64 * 1024 + 9),
      '宝宝👶' * 50000,
      'a' * (64 * 1024 - 2),
    ]) {
      fixture.preferences['unicode'] = jsonEncode(text);
      expect(await store.preference('unicode'), text);
    }
    expect(fixture.maxReturnedBytes, lessThanOrEqualTo(256 * 1024));
    expect(fixture.writes, 0);
  });

  test('缺失键、空列表和普通偏好继续兼容，损坏 JSON 保留并可重新读取', () async {
    expect(await store.preference('missing'), isNull);
    fixture.preferences.addAll({
      'empty': '[]',
      'toggle': 'false',
      'broken': '{invalid',
    });
    expect(await store.preference('empty'), isEmpty);
    expect(await store.preference('toggle'), isFalse);
    await expectLater(store.preference('broken'), throwsFormatException);
    expect(fixture.transactions.last, 'ROLLBACK');
    expect(fixture.preferences['broken'], '{invalid');
    expect(await store.preference('empty'), isEmpty);
    expect(fixture.writes, 0);
  });

  test('新保存的大记录重新打开后仍能读取，保持现有格式与内容', () async {
    final assets = largeAssets();
    await store.setPreference('family-assets', assets);
    await store.close();
    await store.open();
    expect(await store.preference('family-assets'), assets);
    expect(fixture.writes, 1);
  });

  test('大记录编码与后续修改并发时按调用顺序保存，关闭等待写入完成', () async {
    final older = store.setPreference('family-assets', largeAssets());
    final latest = store.setPreference('family-assets', [
      {'id': '最新人工记录', 'faces': <Object?>[]},
    ]);
    await store.close();
    await Future.wait([older, latest]);
    await store.open();
    expect(await store.preference('family-assets'), [
      {'id': '最新人工记录', 'faces': <Object?>[]},
    ]);
    expect(fixture.writes, 2);
  });

  test('宝宝真实初始化读取大索引并保留人工归属、水印偏好和参考', () async {
    final assets = largeAssets();
    fixture.preferences.addAll({
      'family-assets': jsonEncode(assets),
      'family-babies': jsonEncode([
        {
          'id': 'baby',
          'name': '小满',
          'birthday': '2025-08-05',
          'referenceFaces': [
            {'assetId': 'photo-0', 'faceId': 'face-0'},
          ],
        },
      ]),
      'family-decisions': jsonEncode([
        {
          'babyId': 'baby',
          'assetId': 'photo-0',
          'state': 'included',
          'origin': 'manual',
        },
      ]),
      'family-growth-watermark:baby': 'false',
    });
    final directory = await Directory.systemTemp.createTemp('jinchuan-window-');
    messenger.setMockMethodCallHandler(
      directoryChannel,
      (_) async => directory.path,
    );
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'ready': true},
    );
    final transfer = TransferController();
    final model = FamilyController(transfer, store: store);
    await model.initialize();
    expect(model.notice, isEmpty);
    expect(model.ready, isTrue);
    expect(model.assets.length, assets.length);
    expect(model.babies['baby']!.references.single['faceId'], 'face-0');
    expect(
      model.assets['photo-0']!.faces.single['embedding'],
      ((assets.first['faces'] as List).first as Map)['embedding'],
    );
    expect(model.decision('baby', 'photo-0'), 'included');
    expect(model.growthWatermarkVisible('baby'), isFalse);
    expect(fixture.writes, 0);
    model.dispose();
    transfer.dispose();
  });

  test('生产 SQL 在真实 SQLite 中完整恢复大记录和 Unicode 边界', () async {
    final result = await Process.run('node', [
      File('test/preference_sql_fixture.mjs').absolute.path,
    ]);
    expect(result.exitCode, 0, reason: result.stderr.toString());
    final report = jsonDecode(result.stdout as String) as Map;
    expect(report['passed'], 8);
    expect(report['maxReturnedBytes'], lessThanOrEqualTo(256 * 1024));
  });
}
