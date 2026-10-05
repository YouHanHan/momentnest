import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/app.dart';
import 'package:momentnest_mobile/month_scan.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:photo_manager/photo_manager.dart';

class DatedAsset extends AssetEntity {
  DatedAsset(String id, DateTime date) : super(id: id, typeInt: 1, width: 100, height: 100, createDateSecond: date.millisecondsSinceEpoch ~/ 1000);
  @override
  Future<Uint8List?> thumbnailDataWithSize(ThumbnailSize size, {ThumbnailFormat format = ThumbnailFormat.jpeg, int quality = 100, PMProgressHandler? progressHandler, PMCancelToken? cancelToken, int frame = 0}) async => null;
}

class MonthSource extends SystemGallerySource {
  MonthSource(this.items);
  final List<AssetEntity> items;
  final pages = <int>[];
  Completer<List<AssetEntity>>? later;
  @override
  Future<int> count() async => items.length;
  @override
  Future<List<AssetEntity>> page({required int number, required int size}) async {
    pages.add(number);
    if (number > 0 && later != null) return later!.future;
    return items.skip(number * size).take(size).toList();
  }
}

class MonthGateway extends SystemGalleryGateway {
  final all = MonthSource([DatedAsset('oct', DateTime(2026, 10, 1)), DatedAsset('sep', DateTime(2026, 9, 30))]);
  final october = MonthSource([DatedAsset('filtered-oct', DateTime(2026, 10, 1))]);
  final months = <DateTime>[];
  @override
  Future<PermissionState> permission({required bool request}) async => PermissionState.authorized;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async => all;
  @override
  Future<SystemGallerySource?> openMonth({required RequestType type, required DateTime month}) async {months.add(month); return october;}
  @override
  Future<void> manageAccess({required bool limited}) async {}
  @override
  Future<List<int>> years({required RequestType type}) async => [2026];
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  test('月份由系统有界查询，切换月份丢弃旧分页并可恢复全部月份', () async {
    final gateway = MonthGateway();
    final gallery = SystemGalleryController(gateway: gateway, pageSize: 1);
    addTearDown(gallery.dispose);
    await gallery.initialize();
    gateway.all.later = Completer<List<AssetEntity>>();
    final pending = gallery.loadMore();
    await gallery.setMonth(DateTime(2026, 10, 17));
    expect(gateway.months, [DateTime(2026, 10)]);
    expect(gallery.assets.map((asset) => asset.id), ['filtered-oct']);
    gateway.all.later!.complete([DatedAsset('old-page', DateTime(2026, 9))]); await pending;
    expect(gallery.assets.map((asset) => asset.id), ['filtered-oct']);
    await gallery.setMonth(null);
    expect(gallery.month, isNull); expect(gallery.assets.first.id, 'oct');
    expect(gateway.all.pages, [0, 1, 0]);
  });

  test('Android月份SQL是自然月闭开区间，不读取或删除原文件', () async {
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    const mediaChannel = MethodChannel('dev.momentnest/media');
    var sdk = 28;
    final calls = <String>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, (call) async {
      expect(call.method, 'sdkInt');
      return sdk;
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'getAssetPathList') {
        final child = (call.arguments['option'] as Map)['child'] as Map;
        expect(child['where'], monthWhere('2024-02', usesDateTaken: sdk >= 29));
        expect(child['orderBy'], [
          {'column': sdk >= 29 ? 'CASE WHEN datetaken / 1000 != 0 THEN datetaken / 1000 ELSE date_added END' : 'date_added', 'isAsc': false},
          {'column': '_id', 'isAsc': false},
        ]);
        return {'data': []};
      }
      throw StateError('月份查询不应调用 ${call.method}');
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, null));
    await PhotoManagerGalleryGateway().openMonth(type: RequestType.common, month: DateTime(2024, 2));
    sdk = 36;
    await PhotoManagerGalleryGateway().openMonth(type: RequestType.common, month: DateTime(2024, 2));
    expect(calls, ['getAssetPathList', 'getAssetPathList']);
  });

  test('真实SQLite按拍摄日筛选和排序，五月拍九月入库及缺失拍摄日回退一致', () async {
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    const mediaChannel = MethodChannel('dev.momentnest/media');
    var sdk = 36;
    Map? query;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, (call) async {
      expect(call.method, 'sdkInt');
      return sdk;
    });
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'getAssetPathList');
      query = (call.arguments['option'] as Map)['child'] as Map;
      return {'data': []};
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, null));
    int taken(int month, int day) => DateTime(2026, month, day).millisecondsSinceEpoch;
    int added(int month, int day) => taken(month, day) ~/ 1000;
    final rows = [
      [1, 1, taken(5, 5), added(9, 1)],
      [2, 3, taken(5, 9), added(9, 1)],
      [3, 1, null, added(9, 15)],
      [4, 3, 0, added(9, 15)],
      [5, 1, 500, added(9, 15)],
      [6, 1, taken(9, 20), added(9, 21)],
      [7, 1, taken(9, 20), added(9, 19)],
      [8, 2, taken(5, 10), added(9, 1)],
      [9, 1, 0, added(5, 9)],
    ];
    Future<List<dynamic>> execute({DateTime? month, RequestType type = RequestType.common}) async {
      final gateway = PhotoManagerGalleryGateway();
      if (month == null) {await gateway.open(type: type);} else {await gateway.openMonth(type: type, month: month);}
      final run = await Process.run('node', [File('test/gallery_sql_fixture.mjs').absolute.path, jsonEncode({'where': query!['where'], 'orderBy': query!['orderBy'], 'rows': rows})]);
      expect(run.exitCode, 0, reason: run.stderr.toString());
      return jsonDecode(run.stdout as String) as List;
    }
    expect(await execute(month: DateTime(2026, 5)), [9, 2, 1]);
    expect(await execute(month: DateTime(2026, 9)), [7, 6, 5, 4, 3]);
    expect(await execute(), [7, 6, 5, 4, 3, 9, 2, 1]);
    expect(await execute(month: DateTime(2026, 5), type: RequestType.image), [9, 1]);
    expect(await execute(month: DateTime(2026, 5), type: RequestType.video), [2]);
    sdk = 28;
    expect(await execute(month: DateTime(2026, 9)), [6, 7, 5, 4, 3, 2, 1]);
    expect(await execute(month: DateTime(2026, 5)), [9]);
  });

  testWidgets('全部月份标签真实、三列3px日期分组，超出媒体范围的年份回到最新年份', (tester) async {
    final gallery = SystemGalleryController(gateway: MonthGateway());
    addTearDown(gallery.dispose); await gallery.initialize();
    await tester.pumpWidget(MomentNestApp(home: Scaffold(body: SystemGalleryScreen(controller: gallery, onUpload: (_) async => false, onOrganize: (_) async {}))));
    await tester.pumpAndSettle();
    expect(find.text('全部月份'), findsOneWidget);
    expect(find.text('2026年9月30日'), findsOneWidget);
    final grids = tester.widgetList<SliverGrid>(find.byType(SliverGrid));
    for (final grid in grids) {final delegate = grid.gridDelegate as SliverGridDelegateWithFixedCrossAxisCount; expect(delegate.crossAxisCount, 3); expect(delegate.crossAxisSpacing, 3); expect(delegate.mainAxisSpacing, 3);}
    await gallery.setMonth(DateTime(2030, 1)); await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('gallery-month'))); await tester.pumpAndSettle();
    expect(find.text('2026年'), findsOneWidget); expect(find.text('2030年'), findsNothing); expect(tester.takeException(), isNull);
  });
}
