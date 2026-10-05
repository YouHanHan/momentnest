import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/gallery_year_field.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:photo_manager/photo_manager.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel('com.fluttercandies/photo_manager');
  const mediaChannel = MethodChannel('dev.jinchuan/media');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() {
    messenger.setMockMethodCallHandler(channel, null);
    messenger.setMockMethodCallHandler(mediaChannel, null);
  });

  test('年份只查询日期两端各一项，保留空缺年份并与真实SQLite日期排序一致', () async {
    var sdk = 36;
    final calls = <String>[];
    int seconds(int year) =>
        DateTime(year, 6, 1).millisecondsSinceEpoch ~/ 1000;
    final rows = [
      [1, 1, seconds(2021) * 1000, seconds(2025)],
      [2, 3, seconds(2026) * 1000, seconds(2025)],
      [3, 1, null, seconds(2023)],
      [4, 1, 500, seconds(2024)],
      [5, 1, -1000, seconds(2020)],
      [6, 1, 0, 0],
      [7, 2, seconds(2010) * 1000, seconds(2010)],
    ];
    messenger.setMockMethodCallHandler(mediaChannel, (call) async {
      expect(call.method, 'sdkInt');
      return sdk;
    });
    messenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      expect(call.method, 'getAssetsByRange');
      final arguments = call.arguments as Map;
      expect(arguments['start'], 0);
      expect(arguments['end'], 1);
      expect(arguments['type'], RequestType.common.value);
      final query = (arguments['option'] as Map)['child'] as Map;
      final result = await Process.run('node', [
        File('test/gallery_sql_fixture.mjs').absolute.path,
        jsonEncode({
          'where': query['where'],
          'orderBy': query['orderBy'],
          'rows': rows,
        }),
      ]);
      expect(result.exitCode, 0, reason: result.stderr.toString());
      final ids = jsonDecode(result.stdout as String) as List;
      final row = rows.singleWhere((row) => row.first == ids.first);
      final taken = (row[2] ?? 0) ~/ 1000;
      final date = sdk >= 29 && taken != 0 ? taken : row[3];
      return {
        'data': [
          {
            'id': '${row[0]}',
            'type': row[1] == 3 ? 2 : 1,
            'width': 100,
            'height': 100,
            'createDt': date,
          },
        ],
      };
    });
    final gateway = PhotoManagerGalleryGateway();
    expect(await gateway.years(type: RequestType.common), [
      2026,
      2025,
      2024,
      2023,
      2022,
      2021,
    ]);
    sdk = 28;
    expect(await gateway.years(type: RequestType.common), [
      2025,
      2024,
      2023,
      2022,
      2021,
      2020,
    ]);
    expect(calls, List.filled(4, 'getAssetsByRange'));
  });

  test('年份读取遵守当前授权类别，不申请权限或查询不可访问的视频', () async {
    final requests = <bool>[];
    final queriedTypes = <int>[];
    messenger.setMockMethodCallHandler(mediaChannel, (_) async => 36);
    messenger.setMockMethodCallHandler(channel, (call) async {
      final arguments = call.arguments as Map;
      if (call.method == 'getPermissionState') {
        requests.add(false);
        final option = arguments['androidPermission'] as Map;
        return option['type'] == RequestType.image.value
            ? PermissionState.authorized.index
            : PermissionState.denied.index;
      }
      expect(call.method, 'getAssetsByRange');
      queriedTypes.add(arguments['type'] as int);
      final query = (arguments['option'] as Map)['child'] as Map;
      expect(query['where'], startsWith('media_type IN (1) AND '));
      return {
        'data': [
          {
            'id': 'photo',
            'type': 1,
            'width': 100,
            'height': 100,
            'createDt': DateTime(2024, 1, 1).millisecondsSinceEpoch ~/ 1000,
          },
        ],
      };
    });
    final controller = SystemGalleryController();
    addTearDown(controller.dispose);
    expect(await controller.loadYears(), [2024]);
    expect(queriedTypes, [RequestType.image.value, RequestType.image.value]);
    expect(requests, [false, false, false]);
    queriedTypes.clear();
    expect(await controller.loadYears(mediaType: RequestType.video), isEmpty);
    expect(queriedTypes, isEmpty);
    expect(controller.assets, isEmpty);
  });

  test('未授权时不读取日期，空相册或只有未知日期时没有年份', () async {
    messenger.setMockMethodCallHandler(mediaChannel, (_) async => 36);
    final queries = <String>[];
    messenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'getPermissionState') {
        return PermissionState.denied.index;
      }
      queries.add(call.method);
      expect(call.method, 'getAssetsByRange');
      return {'data': []};
    });
    final controller = SystemGalleryController();
    addTearDown(controller.dispose);
    expect(await controller.loadYears(), isEmpty);
    expect(queries, isEmpty);
    expect(
      await PhotoManagerGalleryGateway().years(type: RequestType.common),
      isEmpty,
    );
    expect(queries, ['getAssetsByRange', 'getAssetsByRange']);
  });

  testWidgets('年份读取可等待和重试，范围外的默认年选择最新年份', (tester) async {
    final pending = Completer<List<int>>();
    var reads = 0;
    int? year;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: GalleryYearField(
            initialYear: 2030,
            loadYears: () {
              reads++;
              return reads == 1
                  ? pending.future
                  : Future.value([2026, 2025, 2024]);
            },
            onChanged: (value) => year = value,
          ),
        ),
      ),
    );
    expect(find.text('正在读取相册年份…'), findsOneWidget);
    expect(year, isNull);
    pending.completeError(StateError('测试相册读取失败'));
    await tester.pumpAndSettle();
    expect(find.text('暂时无法读取相册年份。'), findsOneWidget);
    await tester.tap(find.text('重新读取年份'));
    await tester.pumpAndSettle();
    expect(year, 2026);
    final field = tester.widget<DropdownButton<int>>(
      find.byType(DropdownButton<int>),
    );
    expect(field.items!.map((item) => item.value), [2026, 2025, 2024]);
    await tester.tap(find.byType(DropdownButtonFormField<int>));
    await tester.pumpAndSettle();
    await tester.tap(find.text('2024年').last);
    await tester.pumpAndSettle();
    expect(year, 2024);
    expect(reads, 2);
    expect(tester.takeException(), isNull);
  });

  testWidgets('空相册保留所选年份，关闭后迟到的日期不再更新界面', (tester) async {
    var changes = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: GalleryYearField(
            initialYear: 2024,
            loadYears: () async => [],
            onChanged: (_) => changes++,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('2024年'), findsOneWidget);
    expect(find.text('未找到有日期的媒体，保留所选年份'), findsOneWidget);
    expect(changes, 1);
    final pending = Completer<List<int>>();
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: GalleryYearField(
            key: const ValueKey('new-query'),
            initialYear: 2024,
            loadYears: () => pending.future,
            onChanged: (_) => changes++,
          ),
        ),
      ),
    );
    await tester.pumpWidget(const SizedBox());
    pending.complete([2026]);
    await tester.pumpAndSettle();
    expect(changes, 1);
    expect(tester.takeException(), isNull);
  });
}
