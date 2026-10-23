import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/app.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';

/// 多选测试只读取合成缩略图；原文件计数用于防止误入预览。
class BatchAsset extends AssetEntity {
  BatchAsset(int index)
    : super(
        id: 'batch-$index',
        title: '合成媒体-$index.jpg',
        typeInt: index.isOdd ? 2 : 1,
        width: 100,
        height: 100,
        modifiedDateSecond: 1,
      );
  final originalReads = [0];
  final thumbnailReads = [0];

  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async {
    thumbnailReads[0]++;
    return null;
  }

  @override
  Future<File?> get originFile async {
    originalReads[0]++;
    return null;
  }
}

class BatchSource extends SystemGallerySource {
  final items = List.generate(36, BatchAsset.new);
  final pages = <int>[];
  final gates = <int, Completer<void>>{};
  final failOnce = <int>{};
  int? shortPage;
  @override
  Future<int> count() async => items.length;

  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async {
    pages.add(number);
    if (failOnce.remove(number)) throw StateError('测试分页读取失败');
    await gates[number]?.future;
    return items
        .skip(number * size)
        .take(number == shortPage ? size - 1 : size)
        .toList();
  }
}

class BatchGateway extends SystemGalleryGateway {
  final source = BatchSource();
  final months = <DateTime>[];
  int opens = 0;
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;

  @override
  Future<SystemGallerySource?> open({required RequestType type}) async {
    opens++;
    return source;
  }

  @override
  Future<SystemGallerySource?> openMonth({
    required RequestType type,
    required DateTime month,
  }) async {
    months.add(month);
    return source;
  }

  @override
  Future<List<int>> years({required RequestType type}) async => [
    DateTime.now().year,
  ];

  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class BatchTransfer extends TransferController {
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

class BatchFamily extends FamilyController {
  BatchFamily(super.transfer);
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

Finder tile(int index) => find.byKey(ValueKey('gallery:batch-$index:1'));
Finder tab(String text) =>
    find.descendant(of: find.byType(NavigationBar), matching: find.text(text));
Finder filledAction(String text) => find.ancestor(
  of: find.text(text),
  matching: find.byWidgetPredicate((widget) => widget is FilledButton),
);

void main() {
  late BatchGateway gateway;
  late SystemGalleryController gallery;
  final uploads = <Set<String>>[];

  setUp(() {
    gateway = BatchGateway();
    gallery = SystemGalleryController(gateway: gateway, pageSize: 12);
    uploads.clear();
  });

  void screenSize(WidgetTester tester, {double width = 390, double scale = 1}) {
    tester.view.physicalSize = Size(width, 700);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
  }

  Future<void> mountGallery(WidgetTester tester) async {
    await gallery.initialize();
    addTearDown(gallery.dispose);
    await tester.pumpWidget(
      MomentNestApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            onUpload: (ids) async {
              uploads.add(Set.of(ids));
              return true;
            },
            onOrganize: (_) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> choose(WidgetTester tester, List<int> indices) async {
    await tester.tap(find.byKey(const ValueKey('gallery-select')));
    await tester.pumpAndSettle();
    for (final index in indices) {
      await tester.tap(tile(index));
      await tester.pumpAndSettle();
    }
  }

  void originalsUntouched() {
    expect(
      gateway.source.items.every((asset) => asset.originalReads.single == 0),
      isTrue,
    );
    expect(find.byType(SystemMediaPreview), findsNothing);
  }

  testWidgets('点选择后可连续选三项和撤选，不打开原文件预览', (tester) async {
    screenSize(tester);
    await mountGallery(tester);
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    await choose(tester, [0, 1, 2]);
    expect(find.text('已选 3 项'), findsOneWidget);
    for (final index in [0, 1, 2]) {
      expect(tester.widget<SystemPhotoTile>(tile(index)).selected, isTrue);
    }
    await tester.tap(tile(1));
    await tester.pumpAndSettle();
    expect(find.text('已选 2 项'), findsOneWidget);
    expect(tester.widget<SystemPhotoTile>(tile(1)).selected, isFalse);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('全选只涵盖已加载媒体，取消退出多选并清空选择', (tester) async {
    screenSize(tester);
    await mountGallery(tester);
    await choose(tester, [0]);
    expect(gallery.assets, hasLength(12));
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    await tester.pumpAndSettle();
    expect(find.text('已选 12 项'), findsOneWidget);
    expect(gateway.source.pages, [0]);
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pumpAndSettle();
    expect(find.text('相册'), findsOneWidget);
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    await choose(tester, []);
    expect(find.text('已选 0 项'), findsOneWidget);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('分页保留已选媒体，并可选择下一页新增照片', (tester) async {
    screenSize(tester);
    await mountGallery(tester);
    await choose(tester, [0, 1]);
    await gallery.loadMore();
    await tester.pumpAndSettle();
    expect(gateway.source.pages, [0, 1]);
    expect(find.text('已选 2 项'), findsOneWidget);
    await tester.scrollUntilVisible(tile(12), 200);
    await tester.tap(tile(12));
    await tester.pumpAndSettle();
    expect(find.text('已选 3 项'), findsOneWidget);
    await tester.tap(filledAction('传到电脑'));
    await tester.pumpAndSettle();
    expect(uploads.single, {'batch-0', 'batch-1', 'batch-12'});
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('批量上传回调收到三个独立项目，成功后退出选择', (tester) async {
    screenSize(tester);
    await mountGallery(tester);
    await choose(tester, [0, 1, 2]);
    await tester.tap(filledAction('传到电脑'));
    await tester.pumpAndSettle();
    expect(uploads, [
      {'batch-0', 'batch-1', 'batch-2'},
    ]);
    expect(find.text('相册'), findsOneWidget);
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('选择月份自动全选未浏览的分页，可撤选后上传完整月份', (tester) async {
    screenSize(tester);
    await mountGallery(tester);
    await tester.tap(find.byKey(const ValueKey('gallery-month')));
    await tester.pumpAndSettle();
    await tester.tap(filledAction('全选本月'));
    await tester.pumpAndSettle();
    expect(gateway.months, [
      DateTime(DateTime.now().year, DateTime.now().month),
    ]);
    expect(gallery.assets, hasLength(12));
    expect(gateway.source.pages, [0, 0, 0, 1, 2]);
    expect(find.text('已选 36 项'), findsOneWidget);
    expect(
      gateway.source.items
          .skip(12)
          .every((asset) => asset.thumbnailReads.single == 0),
      isTrue,
    );
    await tester.tap(tile(1));
    await tester.pumpAndSettle();
    expect(find.text('已选 35 项'), findsOneWidget);
    await tester.tap(filledAction('传到电脑'));
    await tester.pumpAndSettle();
    expect(uploads.single, {
      for (var index = 0; index < 36; index++)
        if (index != 1) 'batch-$index',
    });
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('整月全选分页失败保留原选择，重试后包含后续页', (tester) async {
    screenSize(tester);
    await gallery.setMonth(DateTime(2024, 2));
    await mountGallery(tester);
    await choose(tester, [0]);
    gateway.source.failOnce.add(1);
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    await tester.pumpAndSettle();
    expect(find.text('已选 1 项'), findsOneWidget);
    expect(find.text('本月未能完整全选，请重试；已有选择保留。'), findsOneWidget);
    expect(uploads, isEmpty);
    expect(gallery.assets, hasLength(12));
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    await tester.pumpAndSettle();
    expect(find.text('已选 36 项'), findsOneWidget);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('整月全选遇到短页不把部分内容冒充完整月份', (tester) async {
    screenSize(tester);
    await gallery.setMonth(DateTime(2024, 2));
    await mountGallery(tester);
    await choose(tester, [0]);
    gateway.source.shortPage = 1;
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    await tester.pumpAndSettle();
    expect(find.text('已选 1 项'), findsOneWidget);
    expect(find.text('本月未能完整全选，请重试；已有选择保留。'), findsOneWidget);
    expect(uploads, isEmpty);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  Future<void> beginDelayedSelection(WidgetTester tester) async {
    await gallery.setMonth(DateTime(2024, 2));
    await mountGallery(tester);
    await choose(tester, [0]);
    gateway.source.gates[1] = Completer<void>();
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    for (var frame = 0; frame < 4; frame++) {
      await tester.pump(const Duration(milliseconds: 10));
    }
    expect(gateway.source.pages.last, 1);
    expect(find.text('正在全选本月…'), findsOneWidget);
    expect(tester.widget<FilledButton>(filledAction('传到电脑')).onPressed, isNull);
  }

  testWidgets('取消整月全选立即退出，迟到结果不恢复选择或读取下一页', (tester) async {
    screenSize(tester);
    await beginDelayedSelection(tester);
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pump();
    gateway.source.gates[1]!.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    expect(gateway.source.pages, isNot(contains(2)));
    expect(uploads, isEmpty);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('切换月份丢弃旧月份全选的迟到结果', (tester) async {
    screenSize(tester);
    await beginDelayedSelection(tester);
    await gallery.setMonth(DateTime(2024, 3));
    gateway.source.gates[1]!.complete();
    await tester.pumpAndSettle();
    expect(gallery.month, DateTime(2024, 3));
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    expect(gallery.assets, hasLength(12));
    expect(uploads, isEmpty);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('参考选图的月份浏览不自动进入上传全选', (tester) async {
    screenSize(tester);
    await gallery.initialize();
    addTearDown(gallery.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            onUpload: (_) async => true,
            onOrganize: (_) async {},
            onPick: (_) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('gallery-month')));
    await tester.pumpAndSettle();
    await tester.tap(filledAction('查看'));
    await tester.pumpAndSettle();
    expect(gateway.source.pages, [0, 0]);
    expect(find.byKey(const ValueKey('gallery-select-all')), findsNothing);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });

  testWidgets('多选后去连接电脑或宝宝页再返回仍保留，应用恢复延后刷新', (tester) async {
    screenSize(tester);
    final transfer = BatchTransfer();
    final family = BatchFamily(transfer);
    await tester.pumpWidget(
      MomentNestApp(
        home: HomeScreen(
          controller: transfer,
          familyController: family,
          galleryController: gallery,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await choose(tester, [0, 1, 2]);
    await tester.tap(filledAction('传到电脑'));
    await tester.pumpAndSettle();
    expect(find.text('连接家里的电脑'), findsOneWidget);
    await tester.tap(find.text('连接家里的电脑'));
    await tester.pumpAndSettle();
    expect(find.text('使用配对信息连接'), findsOneWidget);
    for (final state in [
      AppLifecycleState.inactive,
      AppLifecycleState.hidden,
      AppLifecycleState.paused,
      AppLifecycleState.hidden,
      AppLifecycleState.inactive,
      AppLifecycleState.resumed,
    ]) {
      tester.binding.handleAppLifecycleStateChanged(state);
    }
    await tester.pumpAndSettle();
    expect(gateway.opens, 1);
    await tester.tap(find.byTooltip('返回'));
    await tester.pumpAndSettle();
    await tester.tap(tab('相册'));
    await tester.pumpAndSettle();
    expect(find.text('已选 3 项'), findsOneWidget);
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    expect(find.text('建立宝宝档案'), findsOneWidget);
    await tester.tap(tab('相册'));
    await tester.pumpAndSettle();
    expect(find.text('已选 3 项'), findsOneWidget);
    originalsUntouched();
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pumpAndSettle();
    expect(gateway.opens, 2);
    expect(find.text('相册'), findsNWidgets(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets('280px 大字体多选和全选无溢出，选中时下拉不刷新', (tester) async {
    screenSize(tester, width: 280, scale: 1.6);
    await mountGallery(tester);
    await choose(tester, [0, 1]);
    expect(find.text('已选 2 项'), findsOneWidget);
    await tester.drag(
      find.byKey(const PageStorageKey('system-gallery-grid')),
      const Offset(0, 300),
    );
    await tester.pumpAndSettle();
    expect(gateway.opens, 1);
    expect(find.text('已选 2 项'), findsOneWidget);
    final loadedCount = gallery.assets.length;
    await tester.tap(find.byKey(const ValueKey('gallery-select-all')));
    await tester.pumpAndSettle();
    expect(find.text('已选 $loadedCount 项'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('gallery-select')), findsOneWidget);
    originalsUntouched();
    expect(tester.takeException(), isNull);
  });
}
