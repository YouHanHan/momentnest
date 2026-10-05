import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/app.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';

const saveSnapshots = bool.fromEnvironment('MOBILE_LAYOUT');
const captureKey = ValueKey('mobile-layout-boundary');

/// 截图只使用绘制的色块，缩略图不访问系统媒体接口。
class LayoutAsset extends AssetEntity {
  LayoutAsset(int index, this.bytes)
    : super(
        id: 'layout-$index',
        typeInt: index % 4 == 3 ? 2 : 1,
        width: 240,
        height: 240,
        duration: index % 4 == 3 ? 42 : 0,
        title: '合成媒体-$index.jpg',
        createDateSecond: DateTime(2024, 3, 10).millisecondsSinceEpoch ~/ 1000,
      );
  final Uint8List bytes;

  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async => bytes;
}

class LayoutGallery extends SystemGalleryController {
  LayoutGallery(this.items);
  final List<AssetEntity> items;
  @override
  List<AssetEntity> get assets => items;

  @override
  Future<void> initialize() async {
    ready = true;
    permission = PermissionState.authorized;
    total = items.length;
    notifyListeners();
  }

  @override
  Future<void> refresh() async => notifyListeners();
}

class LayoutTransfer extends TransferController {
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

class LayoutFamily extends FamilyController {
  LayoutFamily(super.transfer);
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

class LayoutPreviewAsset extends LayoutAsset {
  LayoutPreviewAsset(super.index, super.bytes, this.original);
  final File original;
  @override
  Future<File?> get originFile async => original;
}

class LayoutPreviewFamily extends LayoutFamily {
  LayoutPreviewFamily(super.transfer, this.original);
  final File original;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => original;
}

/// 生成不同的暖色色块画面，保留真实图片解码与网格排版路径。
Future<Uint8List> syntheticThumbnail(int index, {int height = 240}) async {
  const backgrounds = [
    Color(0xFFE9D8C8),
    Color(0xFFC9D7CB),
    Color(0xFFE7D4CB),
    Color(0xFFD0D8DF),
    Color(0xFFDFD7B7),
    Color(0xFFD4CDC9),
  ];
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder);
  canvas.scale(1, height / 240);
  final paint = Paint();
  canvas.drawRect(
    const Rect.fromLTWH(0, 0, 240, 240),
    paint..color = backgrounds[index % backgrounds.length],
  );
  canvas.drawCircle(
    Offset(170 - (index % 3) * 40, 60),
    32,
    paint..color = const Color(0xFFFFF9EB),
  );
  final hills = Path()
    ..moveTo(0, 190)
    ..quadraticBezierTo(70, 85 + (index % 3) * 20, 140, 175)
    ..quadraticBezierTo(200, 125, 240, 160)
    ..lineTo(240, 240)
    ..lineTo(0, 240)
    ..close();
  canvas.drawPath(hills, paint..color = const Color(0xFF82957C));
  canvas.drawRRect(
    RRect.fromRectAndRadius(
      Rect.fromLTWH(34 + (index % 3) * 24, 122, 46, 75),
      const Radius.circular(22),
    ),
    paint..color = const Color(0xFFC08161),
  );
  final picture = recorder.endRecording();
  final image = await picture.toImage(240, height);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  image.dispose();
  picture.dispose();
  return data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes);
}

Finder tab(String name) =>
    find.descendant(of: find.byType(NavigationBar), matching: find.text(name));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final thumbnails = <Uint8List>[];
  final paths = <String>[];
  final output = Directory(
    '${Directory.current.parent.parent.path}/.cache/mobile-layout-v2',
  );
  var fontLoaded = false;
  late File previewOriginal;

  setUpAll(() async {
    if (saveSnapshots) await output.create(recursive: true);
    for (var index = 0; index < 8; index++) {
      final bytes = await syntheticThumbnail(index);
      thumbnails.add(bytes);
      if (saveSnapshots) {
        final file = File('${output.path}/synthetic-$index.png');
        await file.writeAsBytes(bytes);
        paths.add(file.path);
      }
    }
    final previewDirectory = saveSnapshots
        ? output
        : await Directory.systemTemp.createTemp('jinchuan-layout-preview-');
    previewOriginal = File('${previewDirectory.path}/preview-original.png');
    await previewOriginal.writeAsBytes(
      await syntheticThumbnail(0, height: 480),
    );
    if (saveSnapshots) {
      final icons = FontLoader('MaterialIcons')
        ..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'));
      await icons.load();
      final font = File('C:/Windows/Fonts/msyh.ttc');
      if (await font.exists()) {
        final loader = FontLoader('LayoutChinese')
          ..addFont(font.readAsBytes().then(ByteData.sublistView));
        await loader.load();
        // 新路由使用应用主题的默认字体，截图时也提供中文字符。
        final routeFont = FontLoader('Roboto')
          ..addFont(font.readAsBytes().then(ByteData.sublistView));
        await routeFont.load();
        // 显式标题样式在测试中回退到 Ahem；为截图提供同一中文字体。
        final defaultFont = FontLoader('Ahem')
          ..addFont(font.readAsBytes().then(ByteData.sublistView));
        await defaultFont.load();
        fontLoaded = true;
      }
    }
  });

  Widget themedApp(Widget home) => Builder(
    builder: (context) {
      final app = MomentNestApp(home: home);
      if (!fontLoaded) return app;
      // 只替换测试字体，并让所有新路由沿用同一生产主题及中文字符。
      final material = app.build(context) as MaterialApp;
      final theme = material.theme!;
      return MaterialApp(
        title: material.title,
        debugShowCheckedModeBanner: material.debugShowCheckedModeBanner,
        locale: material.locale,
        supportedLocales: material.supportedLocales,
        localizationsDelegates: material.localizationsDelegates,
        theme: theme.copyWith(
          textTheme: theme.textTheme.apply(fontFamily: 'LayoutChinese'),
          primaryTextTheme: theme.primaryTextTheme.apply(
            fontFamily: 'LayoutChinese',
          ),
          appBarTheme: theme.appBarTheme.copyWith(
            titleTextStyle: theme.appBarTheme.titleTextStyle?.copyWith(
              fontFamily: 'LayoutChinese',
            ),
          ),
        ),
        home: home,
      );
    },
  );

  Future<void> mount(
    WidgetTester tester, {
    required Size size,
    double scale = 1,
    List<UploadTask> tasks = const [],
    void Function(LayoutFamily)? configureFamily,
  }) async {
    tester.view.physicalSize = size;
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = scale;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final transfer = LayoutTransfer()..tasks = tasks;
    if (tasks.isNotEmpty) {
      transfer.connection = const ReceiverConnection(
        id: 'layout-receiver',
        name: '家里的电脑',
        address: 'https://192.168.1.2:45831',
        fingerprint: 'synthetic-fingerprint',
        deviceId: 'layout-phone',
      );
      transfer.online = true;
      transfer.libraryId = 'layout-library';
      transfer.libraries = [
        {'id': 'layout-library', 'path': r'D:\家庭照片'},
      ];
    }
    final family = LayoutFamily(transfer);
    final gallery = LayoutGallery([
      for (var index = 0; index < thumbnails.length; index++)
        LayoutAsset(index, thumbnails[index]),
    ]);
    family.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-01-31',
      'autoMatch': true,
      'referenceFaces': [
        {'assetId': 'layout-0', 'faceId': 'face-0'},
      ],
    });
    family.activeBaby = 'baby';
    for (var index = 0; index < thumbnails.length; index++) {
      final id = 'layout-$index';
      family.assets[id] = FamilyAsset({
        'id': id,
        'filename': '合成媒体-$index.jpg',
        '_localId': id,
        'kind': index % 4 == 3 ? 'video' : 'photo',
        'date': '2024-03-${(10 + index).toString().padLeft(2, '0')}',
        'dateConfirmed': true,
        if (saveSnapshots) '_thumb': paths[index],
      });
      family.decisions['baby:$id'] = {
        'babyId': 'baby',
        'assetId': id,
        'state': index == 7 ? 'candidate' : 'included',
        'origin': 'manual',
      };
    }
    configureFamily?.call(family);
    await tester.pumpWidget(
      const MaterialApp(home: SizedBox(key: ValueKey('layout-cache-host'))),
    );
    // 原生图片解码不受测试虚拟时钟驱动，截图前明确等待缩略图缓存。
    await tester.runAsync(() async {
      final context = tester.element(
        find.byKey(const ValueKey('layout-cache-host')),
      );
      await Future.wait([
        for (final bytes in thumbnails)
          precacheImage(MemoryImage(bytes), context),
        if (saveSnapshots)
          for (final path in paths)
            precacheImage(FileImage(File(path)), context),
      ]);
    });
    await tester.pumpWidget(
      RepaintBoundary(
        key: captureKey,
        child: themedApp(
          HomeScreen(
            controller: transfer,
            familyController: family,
            galleryController: gallery,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> capture(WidgetTester tester, String filename) async {
    expect(tester.takeException(), isNull, reason: '$filename 不应产生布局溢出');
    if (!saveSnapshots) return;
    await tester.runAsync(() async {
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(captureKey),
      );
      final image = await boundary.toImage(pixelRatio: 1);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('${output.path}/$filename.png').writeAsBytes(
        data!.buffer.asUint8List(data.offsetInBytes, data.lengthInBytes),
      );
      image.dispose();
    });
    expect(tester.takeException(), isNull);
  }

  testWidgets('390px 相册和宝宝主视图使用生产主题，无布局溢出', (tester) async {
    await mount(tester, size: const Size(390, 844));
    expect(find.text('相册'), findsNWidgets(2));
    await capture(tester, 'gallery-390');
    await tester.tap(find.byKey(const ValueKey('gallery-select')));
    await tester.pumpAndSettle();
    for (var index = 0; index < 3; index++) {
      await tester.tap(find.byType(SystemPhotoTile).at(index));
      await tester.pumpAndSettle();
    }
    expect(find.text('已选 3 项'), findsOneWidget);
    await capture(tester, 'gallery-390-batch-selected');
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pumpAndSettle();
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    expect(find.text('小满'), findsOneWidget);
    expect(find.text('成长相册'), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-edit-profile')), findsOneWidget);
    await capture(tester, 'baby-390');
  });

  testWidgets('320px 大字体相册和传输页可读，无布局溢出', (tester) async {
    await mount(tester, size: const Size(320, 640), scale: 1.6);
    expect(find.text('相册'), findsNWidgets(2));
    await capture(tester, 'gallery-320-large-text');
    await tester.tap(find.byKey(const ValueKey('gallery-select')));
    await tester.pumpAndSettle();
    for (var index = 0; index < 2; index++) {
      await tester.tap(find.byType(SystemPhotoTile).at(index));
      await tester.pumpAndSettle();
    }
    expect(find.text('已选 2 项'), findsOneWidget);
    await capture(tester, 'gallery-320-large-text-batch-selected');
    await tester.tap(find.byKey(const ValueKey('gallery-cancel-selection')));
    await tester.pumpAndSettle();
    await tester.tap(tab('传输'));
    await tester.pumpAndSettle();
    expect(find.text('连接家里的电脑'), findsOneWidget);
    await capture(tester, 'transfer-320-large-text');
    await tester.scrollUntilVisible(find.text('还没有传输任务'), 200);
    await tester.pumpAndSettle();
    await capture(tester, 'transfer-320-large-text-bottom');
  });

  testWidgets('360px 宝宝整理中首屏展示多行照片，筛选与工具可用', (tester) async {
    await mount(
      tester,
      size: const Size(360, 740),
      configureFamily: (family) {
        family.babies['baby']!.data['birthday'] = '2026-04-24';
        for (final asset in family.assets.values) {
          asset.data['date'] = '2026-10-01';
        }
        for (var index = 0; index < 35; index++) {
          final id = 'pending-$index';
          family.assets[id] = FamilyAsset({
            'id': id,
            '_localId': id,
            'filename': '待核对-$index.jpg',
            'kind': 'photo',
            'faceState': 'pending',
          });
        }
        family.scanning = true;
        family.scanTotal = 4987;
        family.scanProcessed = 51;
        family.scanStage = '分析视频 4 个采样帧';
        family.progress = '整理已授权媒体 51 / 4987';
      },
    );
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    final firstPhoto = tester.getRect(
      find.byKey(const ValueKey('baby-media-layout-0')),
    );
    final secondRow = tester.getRect(
      find.byKey(const ValueKey('baby-media-layout-5')),
    );
    final navigation = tester.getRect(find.byType(NavigationBar));
    expect(firstPhoto.top, lessThan(370));
    expect(secondRow.bottom, lessThanOrEqualTo(navigation.top));
    final filterTop = tester
        .getTopLeft(find.byKey(const ValueKey('baby-filter-related')))
        .dy;
    for (final key in [
      'baby-filter-included',
      'baby-candidates',
      'baby-filter-review',
    ]) {
      final rect = tester.getRect(find.byKey(ValueKey(key)));
      expect(rect.top, filterTop);
      expect(rect.height, greaterThanOrEqualTo(48));
    }
    expect(find.text('整理 51 / 4987'), findsOneWidget);
    await capture(tester, 'baby-360-compact-scanning');
    await tester.tap(find.byKey(const ValueKey('baby-scan-control')));
    await tester.pumpAndSettle();
    expect(find.text('整理已暂停 51 / 4987'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pumpAndSettle();
    for (final key in [
      'baby-new-profile',
      'baby-growth-watermark',
      'baby-watermark-display',
    ]) {
      final control = find.byKey(ValueKey(key));
      await tester.ensureVisible(control);
      expect(control.hitTestable(), findsOneWidget);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('320px 大字体宝宝筛选可横滑，工具菜单与原有功能可达', (tester) async {
    await mount(tester, size: const Size(320, 640), scale: 1.6);
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    final firstPhoto = tester.getRect(
      find.byKey(const ValueKey('baby-media-layout-7')),
    );
    expect(firstPhoto.top, lessThan(370));
    await capture(tester, 'baby-320-compact-large-text');
    final review = find.byKey(const ValueKey('baby-filter-review'));
    await tester.ensureVisible(review);
    expect(review.hitTestable(), findsOneWidget);
    await tester.tap(review);
    await tester.pumpAndSettle();
    expect(find.text('当前已整理范围没有待核对媒体'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pumpAndSettle();
    final watermark = find.byKey(const ValueKey('baby-watermark-display'));
    await tester.ensureVisible(watermark);
    expect(watermark.hitTestable(), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('普通预览单排操作，宝宝照片没有底栏且菜单可达，两者画布覆盖整屏', (tester) async {
    String? backupAsset;
    for (final size in [const Size(360, 740), const Size(320, 640)]) {
      final large = size.width == 320;
      tester.view.physicalSize = size;
      tester.view.devicePixelRatio = 1;
      tester.platformDispatcher.textScaleFactorTestValue = large ? 1.6 : 1;
      final transfer = LayoutTransfer();
      final family = LayoutPreviewFamily(transfer, previewOriginal);
      addTearDown(() {
        family.dispose();
        transfer.dispose();
      });
      final baby = BabyProfile({
        'id': 'baby',
        'name': '小满',
        'birthday': '2026-04-24',
      });
      family.babies[baby.id] = baby;
      final media = FamilyAsset({
        'id': 'preview',
        '_localId': 'preview',
        'filename': '成长记录.png',
        'kind': 'photo',
        'width': 240,
        'height': 480,
        'date': '2026-10-05',
        'dateConfirmed': true,
        'dateSource': 'capture',
      });
      family.decisions['baby:preview'] = {
        'state': 'included',
        'origin': 'manual',
      };
      final system = LayoutPreviewAsset(0, thumbnails.first, previewOriginal);
      for (final isBaby in [false, true]) {
        final preview = isBaby
            ? MediaPreview(
                controller: family,
                asset: media,
                baby: baby,
                onTransferAsset: (_) {},
              )
            : SystemMediaPreview(
                asset: system,
                onBackupInfo: (asset) async => backupAsset = asset.id,
                onOrganize: (_) async {},
                onUpload: (_) async => false,
              );
        await tester.pumpWidget(
          RepaintBoundary(
            key: captureKey,
            child: themedApp(
              Builder(
                builder: (context) => MediaQuery(
                  data: MediaQuery.of(context).copyWith(
                    padding: const EdgeInsets.fromLTRB(12, 24, 12, 24),
                  ),
                  child: preview,
                ),
              ),
            ),
          ),
        );
        await tester.runAsync(
          () => precacheImage(
            FileImage(previewOriginal),
            tester.element(find.byType(Scaffold)),
          ),
        );
        await tester.pumpAndSettle();
        final canvas = find.byKey(
          ValueKey(isBaby ? 'preview-canvas' : 'system-preview-canvas'),
        );
        final actions = find.byKey(
          ValueKey(isBaby ? 'preview-actions' : 'system-preview-actions'),
        );
        expect(tester.getRect(canvas), Offset.zero & size);
        final rawImage = find.byType(RawImage).first;
        final decoded = tester.widget<RawImage>(rawImage).image!;
        final decodedSize = Size(
          decoded.width.toDouble(),
          decoded.height.toDouble(),
        );
        final rawRect = tester.getRect(rawImage);
        final painted = Alignment.center.inscribe(
          applyBoxFit(BoxFit.contain, decodedSize, rawRect.size).destination,
          rawRect,
        );
        expect(
          painted,
          Alignment.center.inscribe(
            applyBoxFit(BoxFit.contain, decodedSize, size).destination,
            Offset.zero & size,
          ),
        );
        if (isBaby) {
          expect(actions, findsNothing);
          expect(
            find.byKey(const ValueKey('preview-bottom-overlay')),
            findsNothing,
          );
          expect(find.text('是宝宝'), findsNothing);
          expect(find.text('不是宝宝'), findsNothing);
          await tester.tap(find.byKey(const ValueKey('preview-tools')));
          await tester.pumpAndSettle();
          for (final key in [
            'preview-included',
            'preview-excluded',
            'preview-reference',
            'preview-watermark-display',
            'preview-information',
            'preview-transfer',
          ]) {
            final item = find.byKey(ValueKey(key));
            await tester.ensureVisible(item);
            expect(item.hitTestable(), findsOneWidget);
            expect(tester.getSize(item).height, greaterThanOrEqualTo(48));
          }
          await capture(tester, 'baby-preview-${size.width.toInt()}-tools');
          await tester.tapAt(const Offset(5, 150));
          await tester.pumpAndSettle();
        } else {
          expect(tester.getSize(actions).height, 48);
        }
        expect(find.byTooltip('上一张'), findsNothing);
        expect(find.byTooltip('下一张'), findsNothing);
        if (!isBaby) {
          expect(find.text('备份信息'), findsNothing);
          await tester.tap(find.byTooltip('备份信息'));
          await tester.pumpAndSettle();
          expect(backupAsset, system.id);
        }
        final suffix =
            '${isBaby ? 'baby' : 'system'}-preview-${size.width.toInt()}${large ? '-large-text' : ''}';
        await capture(tester, suffix);
        await tester.tapAt(tester.getCenter(canvas));
        await tester.pumpAndSettle();
        expect(find.byType(AppBar), findsNothing);
        expect(actions, findsNothing);
        expect(tester.getRect(canvas), Offset.zero & size);
        await capture(tester, '$suffix-hidden-tools');
        await tester.tapAt(tester.getCenter(canvas));
        await tester.pumpAndSettle();
        expect(find.byType(AppBar), findsOneWidget);
        expect(actions, isBaby ? findsNothing : findsOneWidget);
        await tester.pumpWidget(const SizedBox.shrink());
        await tester.pumpAndSettle();
      }
    }
    tester.view.resetPhysicalSize();
    tester.view.resetDevicePixelRatio();
    tester.platformDispatcher.clearTextScaleFactorTestValue();
  });

  testWidgets('任务列表与独立详情在正常及窄屏大字体下可读', (tester) async {
    for (final size in [const Size(390, 844), const Size(320, 640)]) {
      final narrow = size.width == 320;
      final tasks = [
        for (var index = 0; index < 4; index++)
          UploadTask({
            'id': 'layout-task-$index',
            'assetId': 'layout-$index',
            'libraryId': 'layout-library',
            'hash': 'a' * 64,
            'batchId': 'layout-batch',
            'createdAt': '2026-10-01T14:30:00',
            'filename': const [
              '宝宝第一次散步.jpg',
              '周末全家合照.jpg',
              '午后的小表情.jpg',
              '宝宝学走路.mp4',
            ][index],
            'kind': index == 3 ? 'video' : 'photo',
            'state': const ['complete', 'queued', 'checking', 'failed'][index],
            if (index == 0)
              'receipt': {
                'receiverId': 'layout-receiver',
                'libraryId': 'layout-library',
                'hash': 'a' * 64,
                'size': 32 * 1024 * 1024,
              },
            'error': index == 3 ? '电脑暂时无法连接，请检查同一局域网后重试。' : '',
            'receiverId': 'layout-receiver',
            'receiverName': '家里的电脑',
            'libraryPath': r'D:\家庭照片',
            'archiveDate': '2026-10-01',
            'size': 32 * 1024 * 1024,
            'offset':
                (index == 0 || index == 2
                    ? 32
                    : index == 1
                    ? 0
                    : 12) *
                1024 *
                1024,
          }),
      ];
      await mount(tester, size: size, scale: narrow ? 1.6 : 1, tasks: tasks);
      await tester.tap(tab('传输'));
      await tester.pumpAndSettle();
      final suffix = narrow ? '320-large-text' : '390';
      await capture(tester, 'transfer-list-$suffix');
      final batchRow = find.byKey(
        const ValueKey('transfer-batch-layout-batch'),
      );
      await tester.ensureVisible(batchRow);
      await tester.tap(batchRow);
      await tester.pumpAndSettle();
      expect(find.text('批次详情'), findsOneWidget);
      await capture(tester, 'transfer-batch-$suffix');
      final row = find.byKey(const ValueKey('transfer-task-layout-task-3'));
      await tester.scrollUntilVisible(
        row,
        140,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('transfer-batch-detail')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(find.text('任务详情'), findsOneWidget);
      await capture(tester, 'transfer-detail-$suffix');
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('transfer-task-cancel')),
        160,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('transfer-task-detail')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await capture(tester, 'transfer-detail-$suffix-bottom');
      await tester.tap(find.byType(BackButton));
      await tester.pumpAndSettle();
      final waiting = find.byKey(const ValueKey('transfer-task-layout-task-2'));
      await tester.scrollUntilVisible(
        waiting,
        -140,
        scrollable: find
            .descendant(
              of: find.byKey(const ValueKey('transfer-batch-detail')),
              matching: find.byType(Scrollable),
            )
            .first,
      );
      await tester.pumpAndSettle();
      await tester.tap(waiting);
      await tester.pumpAndSettle();
      expect(find.text('等待电脑确认'), findsOneWidget);
      await capture(tester, 'transfer-waiting-$suffix');
      await tester.pumpWidget(const SizedBox.shrink());
      await tester.pumpAndSettle();
    }
  });
}
