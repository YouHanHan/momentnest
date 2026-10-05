import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'preview_test_helpers.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/backup_catalog.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/media_favorites.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:momentnest_mobile/gallery_backup_controller.dart';
import 'package:momentnest_mobile/gallery_style.dart';
import 'backup_test.dart' as backup_fixtures;

/// 使用合成偏好与系统媒体属性，验证查询、持久化和人工核对，不读取个人媒体。
class FeatureStore extends LocalStore {
  final values = <String, Object?>{};
  bool failWrite = false;
  @override
  Future<void> open() async {}
  @override
  Future<dynamic> preference(String key) async => values[key];
  @override
  Future<void> setPreference(String key, Object? value) async {
    if (failWrite) throw StateError('合成写入失败');
    values[key] = jsonDecode(jsonEncode(value));
  }

  @override
  Future<void> close() async {}
}

AssetEntity photo(String id, String name, int date, {int modified = 1}) =>
    AssetEntity(
      id: id,
      typeInt: 1,
      width: 100,
      height: 100,
      title: name,
      createDateSecond: date,
      modifiedDateSecond: modified,
    );

class QuerySource extends SystemGallerySource {
  QuerySource(this.items);
  final List<AssetEntity> items;
  final pages = <int>[];
  @override
  Future<int> count() async => items.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async {
    pages.add(number);
    return items.skip(number * size).take(size).toList();
  }
}

class QueryGateway extends SystemGalleryGateway {
  QueryGateway(this.items);
  final List<AssetEntity> items;
  final sources = <QuerySource>[];
  final searches = <String>[];
  Completer<SystemGallerySource?>? delayed;
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.limited;
  @override
  Future<void> manageAccess({required bool limited}) async {}
  @override
  Future<SystemGallerySource?> open({required RequestType type}) =>
      openQuery(type: type);
  @override
  Future<SystemGallerySource?> openQuery({
    required RequestType type,
    DateTime? month,
    String search = '',
    bool oldestFirst = false,
    Set<String>? favoriteIds,
  }) async {
    searches.add(search);
    if (search == '迟到') return delayed!.future;
    final found =
        items
            .where(
              (item) =>
                  (item.title ?? '').toLowerCase().contains(
                    search.toLowerCase(),
                  ) &&
                  (favoriteIds == null || favoriteIds.contains(item.id)),
            )
            .toList()
          ..sort(
            (a, b) => oldestFirst
                ? a.createDateTime.compareTo(b.createDateTime)
                : b.createDateTime.compareTo(a.createDateTime),
          );
    final source = QuerySource(found);
    sources.add(source);
    return source;
  }
}

/// 布局截图读取本机字体，避免测试默认字体将中文和图标画成方块。
Future<void> prepareCapture(WidgetTester tester) async {
  if (!Platform.isWindows) return;
  await tester.runAsync(() async {
    final config = File('.dart_tool/package_config.json').absolute;
    final packages =
        (jsonDecode(await config.readAsString()) as Map)['packages'] as List;
    final flutter = packages
        .cast<Map>()
        .where((package) => package['name'] == 'flutter')
        .first;
    final sdk = Directory.fromUri(
      config.uri.resolve(flutter['rootUri'] as String),
    ).parent.parent.path;
    for (final font in {
      'Microsoft YaHei': 'C:/Windows/Fonts/msyh.ttc',
      'MaterialIcons':
          '$sdk/bin/cache/artifacts/material_fonts/MaterialIcons-Regular.otf',
    }.entries) {
      final file = File(font.value);
      if (!await file.exists()) continue;
      final loader = FontLoader(font.key)
        ..addFont(file.readAsBytes().then(ByteData.sublistView));
      await loader.load();
    }
  });
}

ThemeData get captureTheme => ThemeData(
  fontFamily: 'Microsoft YaHei',
  colorScheme: ColorScheme.fromSeed(seedColor: galleryGreen),
  scaffoldBackgroundColor: galleryBackground,
);

Future<void> capture(WidgetTester tester, String name) async {
  final boundary = tester.renderObject<RenderRepaintBoundary>(
    find.byKey(const ValueKey('feature-capture')),
  );
  await tester.runAsync(() async {
    final image = await boundary.toImage(pixelRatio: 1);
    try {
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await File(
        '${Directory.current.parent.parent.path}/.cache/apk-features-$name.png',
      ).writeAsBytes(bytes!.buffer.asUint8List());
    } finally {
      image.dispose();
    }
  });
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const mediaChannel = MethodChannel('dev.jinchuan/media');
  const galleryChannel = MethodChannel('com.fluttercandies/photo_manager');

  test('真实 SQLite 搜索转义引号，百分号下划线按字面搜索，收藏与未知日期排序可组合', () async {
    Map<dynamic, dynamic>? sql;
    messenger.setMockMethodCallHandler(mediaChannel, (_) async => 29);
    messenger.setMockMethodCallHandler(galleryChannel, (call) async {
      if (call.method == 'getAssetPathList') {
        sql = ((call.arguments as Map)['option'] as Map)['child'] as Map;
        return {'data': []};
      }
      throw StateError('未预期的媒体操作：${call.method}');
    });
    addTearDown(() {
      messenger.setMockMethodCallHandler(mediaChannel, null);
      messenger.setMockMethodCallHandler(galleryChannel, null);
    });
    final gateway = PhotoManagerGalleryGateway();
    Future<List<dynamic>> execute() async {
      final result = await Process.run('node', [
        'test/gallery_sql_fixture.mjs',
        jsonEncode({
          'where': sql!['where'],
          'orderBy': sql!['orderBy'],
          'rows': [
            [1, 1, 300000, 0, "宝宝'100%_A.JPG"],
            [2, 1, 100000, 0, "宝宝'100%_b.jpg"],
            [3, 1, 0, 0, "宝宝'100%_未知.jpg"],
            [4, 1, 200000, 0, "宝宝'100XX.jpg"],
            [5, 3, 50000, 0, "宝宝'100%_视频.mp4"],
          ],
        }),
      ]);
      expect(result.exitCode, 0, reason: '${result.stderr}');
      return jsonDecode(result.stdout as String) as List;
    }

    await gateway.openQuery(
      type: RequestType.image,
      search: "宝宝'100%_",
      oldestFirst: true,
      favoriteIds: {'1', '2', '3', '5', '1) OR 1=1 --'},
    );
    expect(await execute(), [2, 1, 3]);
    await gateway.openQuery(
      type: RequestType.image,
      search: "宝宝'100%_",
      favoriteIds: {'1', '3'},
    );
    expect(await execute(), [1, 3]);
    await gateway.openQuery(type: RequestType.common, favoriteIds: {});
    expect(await execute(), isEmpty);
  });

  test('查询覆盖未加载的照片，快速改搜索时旧结果不会覆盖新范围', () async {
    final gateway = QueryGateway([
      for (var i = 1; i <= 120; i++)
        photo('$i', i == 1 ? '宝宝特别.jpg' : '普通$i.jpg', i),
    ])..delayed = Completer<SystemGallerySource?>();
    final gallery = SystemGalleryController(gateway: gateway, pageSize: 2);
    addTearDown(gallery.dispose);
    await gallery.initialize();
    expect(gallery.assets.map((item) => item.id), ['120', '119']);
    await gallery.setQuery(search: '宝宝');
    expect(gallery.assets.single.id, '1');
    final old = gallery.setQuery(search: '迟到');
    await Future<void>.delayed(Duration.zero);
    await gallery.setQuery(search: '普通', oldestFirst: true);
    gateway.delayed!.complete(QuerySource([photo('999', '迟到.jpg', 999)]));
    await old;
    expect(gallery.assets.map((item) => item.id), ['2', '3']);
    await gallery.loadMore();
    expect(gallery.assets.map((item) => item.id), ['2', '3', '4', '5']);
    expect(gallery.limited, isTrue);
  });

  test('收藏重启保留，编辑后不沿用旧内容，保存失败不会显示成功', () async {
    final store = FeatureStore();
    final first = MediaFavorites(store), second = MediaFavorites(store);
    addTearDown(first.dispose);
    addTearDown(second.dispose);
    final original = photo('1', 'a.jpg', 100);
    await first.initialize();
    await first.toggle(original);
    await second.initialize();
    expect(second.isFavorite(original), isTrue);
    expect(second.isFavorite(photo('1', 'a.jpg', 100, modified: 2)), isFalse);
    store.failWrite = true;
    await expectLater(second.toggle(original), throwsStateError);
    expect(second.isFavorite(original), isTrue);
    expect(second.saving, isFalse);
    store.failWrite = false;
    await second.toggle(original);
    await second.importLegacy({'1': photoVersion(original)});
    expect(second.isFavorite(original), isFalse);
  });

  test('收藏筛选按整库 ID 查询，取消收藏即时移出，新版本不误入', () async {
    final favorites = MediaFavorites(FeatureStore());
    await favorites.initialize();
    await favorites.toggle(photo('1', 'a.jpg', 1));
    await favorites.toggle(photo('2', 'b.jpg', 2));
    final gateway = QueryGateway([
      photo('1', 'a.jpg', 1),
      photo('2', 'b.jpg', 2, modified: 2),
      photo('3', 'c.jpg', 3),
    ]);
    final gallery = SystemGalleryController(gateway: gateway)
      ..attachFavorites(favorites);
    addTearDown(() {
      gallery.dispose();
      favorites.dispose();
    });
    await gallery.initialize();
    await gallery.setQuery(favoritesOnly: true);
    expect(gallery.assets.single.id, '1');
    await favorites.toggle(gallery.assets.single);
    while (gallery.loading) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(gallery.assets, isEmpty);
  });

  test('待核对包括低相似、无脸、未分析及失败，人工确认与排除优先且不影响其他宝宝', () async {
    final transfer = TransferController();
    final family = FamilyController(transfer);
    addTearDown(() {
      family.dispose();
      transfer.dispose();
    });
    family.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '宝宝',
      'birthday': '2024-01-01',
      'autoMatch': true,
    });
    for (final id in [
      'pending',
      'noface',
      'error',
      'weak',
      'included',
      'candidate',
      'excluded',
      'legacy',
      'remote',
      'denied',
    ]) {
      family.assets[id] = FamilyAsset({
        'id': id,
        '_localId': id,
        'faceState': id == 'pending'
            ? 'pending'
            : id == 'error'
            ? 'error'
            : 'done',
        'faces': id == 'weak'
            ? [
                {'id': 'face'},
              ]
            : [],
        if (id == 'denied') '_authorized': false,
      });
    }
    family.assets['remote']!.data.remove('_localId');
    for (final state in ['included', 'candidate', 'excluded']) {
      family.decisions['baby:$state'] = {'state': state, 'origin': 'manual'};
    }
    family.decisions['baby:legacy'] = {
      'state': 'excluded',
      'origin': 'recognition',
    };
    expect(
      family.reviewCollection('baby').map((item) => item.id),
      unorderedEquals(['pending', 'noface', 'error', 'weak', 'legacy']),
    );
    expect(family.reviewReason('baby', family.assets['noface']!), '未检出人脸');
    expect(family.reviewReason('baby', family.assets['error']!), '识别失败');
    await family.decide('baby', 'noface', 'included');
    await family.decide('baby', 'pending', 'excluded');
    expect(
      family.reviewCollection('baby').map((item) => item.id),
      unorderedEquals(['error', 'weak', 'legacy']),
    );
    expect(family.reviewReason('other', family.assets['noface']!), '未检出人脸');
    family.classify(family.assets['pending']!);
    expect(family.decision('baby', 'pending'), 'excluded');
  });

  test('普通相册与宝宝预览共享收藏，旧索引收藏升级后可取消且不重新恢复', () async {
    final store = FeatureStore(), transfer = TransferController();
    final family = FamilyController(transfer, store: store);
    addTearDown(() {
      family.dispose();
      transfer.dispose();
    });
    final media = photo('1', '宝宝.jpg', 100);
    final asset = FamilyAsset({
      'id': 'hash',
      '_localId': '1',
      '_version': photoVersion(media),
      'favorite': true,
    });
    await family.favorites.initialize();
    await family.favorites.importLegacy({'1': photoVersion(media)});
    expect(family.isFavorite(asset), isTrue);
    await family.toggleFavorite(asset);
    expect(family.favorites.isFavorite(media), isFalse);
    final restored = MediaFavorites(store);
    addTearDown(restored.dispose);
    await restored.initialize();
    await restored.importLegacy({'1': photoVersion(media)});
    expect(restored.isFavorite(media), isFalse);
    await restored.toggle(media);
    expect(restored.isFavorite(media), isTrue);
  });

  test('电脑保存状态与搜索排序组合，后续页面的缺失项仍可筛选和补传', () async {
    final transfer = backup_fixtures.CheckController(
      (request) async => backup_fixtures.result(request),
    );
    final gateway = QueryGateway([
      photo('1', '宝宝一.jpg', 1),
      photo('2', '宝宝二.jpg', 2),
      photo('3', '其他.jpg', 3),
    ]);
    final gallery = SystemGalleryController(gateway: gateway, pageSize: 1);
    final backup = GalleryBackupController(gallery, transfer);
    addTearDown(() {
      backup.dispose();
      gallery.dispose();
      transfer.dispose();
    });
    await transfer.store.observe(
      '2',
      'computer',
      'first',
      photoVersion(gateway.items[1]),
      {'status': 'missing'},
    );
    await gallery.initialize();
    await backup.setFilter('missing');
    expect(backup.visible.single.id, '2');
    await gallery.setQuery(search: '宝宝', oldestFirst: true);
    for (var i = 0; i < 15; i++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(backup.filter, 'missing');
    expect(backup.visible.single.id, '2');
    expect(backup.idsFor('missing'), {'2'});
    expect(gateway.sources.last.pages, [0, 1]);
  });

  testWidgets('手机窄屏搜索与排序可操作，空结果仍保留搜索入口', (tester) async {
    await prepareCapture(tester);
    tester.view.physicalSize = const Size(360, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    messenger.setMockMethodCallHandler(galleryChannel, (_) async => null);
    addTearDown(() => messenger.setMockMethodCallHandler(galleryChannel, null));
    final gateway = QueryGateway([
      photo('1', '生日.jpg', 1),
      photo('2', '旅行.jpg', 2),
    ]);
    final gallery = SystemGalleryController(gateway: gateway);
    addTearDown(gallery.dispose);
    await gallery.initialize();
    await tester.pumpWidget(
      MaterialApp(
        theme: captureTheme,
        home: RepaintBoundary(
          key: const ValueKey('feature-capture'),
          child: Scaffold(
            body: SystemGalleryScreen(
              controller: gallery,
              onUpload: (_) async => false,
              onOrganize: (_) async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await capture(tester, 'gallery');
    await tester.tap(find.byKey(const ValueKey('gallery-open-search')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byKey(const ValueKey('gallery-search')), '生日');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    expect(gallery.assets.single.id, '1');
    await tester.tap(find.byKey(const ValueKey('gallery-sort')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('最早在前'));
    await tester.pumpAndSettle();
    expect(gallery.oldestFirst, isTrue);
    await tester.enterText(find.byKey(const ValueKey('gallery-search')), '不存在');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    expect(gallery.assets, isEmpty);
    expect(find.byKey(const ValueKey('gallery-search')), findsOneWidget);
    await tester.tap(find.byTooltip('清空搜索'));
    await tester.pumpAndSettle();
    expect(gallery.assets.map((item) => item.id), ['1', '2']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('宝宝待核对显示原因，搜索可找到无脸遗漏项，人工确认后移入成长相册', (tester) async {
    tester.view.physicalSize = const Size(360, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await prepareCapture(tester);
    final transfer = TransferController();
    final family = FamilyController(transfer, mediaResolver: (_) async => null)
      ..ready = true;
    addTearDown(() {
      family.dispose();
      transfer.dispose();
    });
    family.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '宝宝',
      'birthday': '2024-01-01',
    });
    family.activeBaby = 'baby';
    family.assets['no-face'] = FamilyAsset({
      'id': 'no-face',
      '_localId': '1',
      'filename': '背影.jpg',
      'date': '2024-02-01',
      'dateConfirmed': true,
      'dateSource': 'capture',
      'faceState': 'done',
      'faces': [],
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: captureTheme,
        home: RepaintBoundary(
          key: const ValueKey('feature-capture'),
          child: Scaffold(
            body: ListenableBuilder(
              listenable: family,
              builder: (_, _) =>
                  BabyScreen(controller: family, onTransfer: (_) {}),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.byKey(const ValueKey('baby-filter-review')));
    await tester.pumpAndSettle();
    await capture(tester, 'baby-review');
    await tester.ensureVisible(find.byKey(const ValueKey('baby-open-search')));
    await tester.tap(find.byKey(const ValueKey('baby-open-search')));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('baby-search')));
    await tester.enterText(find.byKey(const ValueKey('baby-search')), '背影');
    await tester.pump(const Duration(milliseconds: 350));
    await tester.pumpAndSettle();
    await tester.ensureVisible(
      find.byKey(const ValueKey('baby-media-no-face')),
    );
    expect(find.text('未检出人脸'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('baby-media-no-face')));
    await tester.pumpAndSettle();
    await choosePreviewTool(tester, 'preview-included');
    expect(family.decision('baby', 'no-face'), 'included');
    expect(family.reviewCollection('baby'), isEmpty);
    expect(family.collection('baby').single.id, 'no-face');
    expect(tester.takeException(), isNull);
  });
}
