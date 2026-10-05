import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';

class GalleryAsset extends AssetEntity {
  GalleryAsset(String id, {bool video = false})
    : super(
        id: id,
        typeInt: video ? 2 : 1,
        width: 40,
        height: 40,
        duration: video ? 72 : 0,
      );
  final _originalReads = [0];
  int get originalReads => _originalReads.single;
  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async => null;
  @override
  Future<File?> get originFile async {
    _originalReads[0]++;
    return null;
  }
}

class GallerySource extends SystemGallerySource {
  final items = [
    GalleryAsset('photo'),
    GalleryAsset('video', video: true),
    for (var i = 0; i < 18; i++) GalleryAsset('photo-$i'),
  ];
  @override
  Future<int> count() async => items.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async => number == 0 ? items : [];
}

class GalleryGateway extends SystemGalleryGateway {
  final source = GallerySource();
  final types = <RequestType>[];
  PermissionState state = PermissionState.authorized;
  @override
  Future<PermissionState> permission({required bool request}) async => state;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async {
    types.add(type);
    return source;
  }

  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class IdleTransfer extends TransferController {
  int albumReads = 0, hashReads = 0;
  @override
  Future<void> initialize() async {}
  @override
  Future<void> loadPhotos({bool requestPermission = true}) async {
    albumReads++;
  }

  @override
  Future<Map<String, dynamic>> inspectPhoto(
    AssetEntity asset, {
    bool useCache = false,
  }) async {
    hashReads++;
    throw StateError('浏览不得读取原图指纹');
  }
}

class IdleFamily extends FamilyController {
  IdleFamily(super.transfer);
  int scans = 0;
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }

  @override
  Future<void> scan({bool requestPermission = true}) async {
    scans++;
  }
}

class ReconnectingTransfer extends IdleTransfer {
  final reconnectGate = Completer<void>();
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
    await reconnectGate.future;
  }
}

void smallScreen(
  WidgetTester tester, {
  double width = 320,
  double scale = 1.6,
}) {
  tester.view.physicalSize = Size(width, 640);
  tester.view.devicePixelRatio = 1;
  tester.platformDispatcher.textScaleFactorTestValue = scale;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
}

void main() {
  testWidgets('详情按钮跟随初始化和传输状态恢复，原文件只读取一次', (tester) async {
    final gateway = GalleryGateway();
    final gallery = SystemGalleryController(gateway: gateway);
    await gallery.initialize();
    final available = ValueNotifier(false);
    addTearDown(available.dispose);
    addTearDown(gallery.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ValueListenableBuilder(
            valueListenable: available,
            builder: (_, ready, _) => SystemGalleryScreen(
              controller: gallery,
              actionsChanged: available,
              canUpload: ready,
              canOrganize: ready,
              uploadAvailable: () => available.value,
              organizeAvailable: () => available.value,
              onUpload: (_) async => false,
              onOrganize: (_) async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    final upload = find.byWidgetPredicate((widget) => widget is FilledButton);
    final organize = find.byWidgetPredicate((widget) => widget is TextButton);
    expect(tester.widget<FilledButton>(upload).onPressed, isNull);
    expect(tester.widget<TextButton>(organize).onPressed, isNull);
    available.value = true;
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(upload).onPressed, isNotNull);
    expect(tester.widget<TextButton>(organize).onPressed, isNotNull);
    expect(gateway.source.items.first.originalReads, 1);
  });

  testWidgets('离线电脑重连不阻塞本地宝宝档案，模型就绪后再开始整理', (tester) async {
    final gateway = GalleryGateway();
    final gallery = SystemGalleryController(gateway: gateway);
    final transfer = ReconnectingTransfer();
    final family = IdleFamily(transfer);
    family.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-02-01',
      'autoMatch': true,
      'referenceFaces': [
        {'assetId': 'photo', 'faceId': 'face'},
      ],
    });
    family.activeBaby = 'baby';
    family.assets['photo'] = FamilyAsset({
      'id': 'photo',
      '_localId': 'photo',
      'faces': [
        {
          'id': 'face',
          'embedding': List.generate(128, (index) => index == 0 ? 1.0 : 0.0),
        },
      ],
    });
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: transfer,
          familyController: family,
          galleryController: gallery,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('宝宝'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('小满'), findsOneWidget);
    expect(family.ready, isTrue);
    expect(transfer.reconnectGate.isCompleted, isFalse);
    expect(family.scans, 0);
    family.modelReady = true;
    family.changed();
    await tester.pumpAndSettle();
    expect(family.scans, 1);
    family.changed();
    await tester.pumpAndSettle();
    expect(family.scans, 1);
    transfer.reconnectGate.complete();
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('系统相册独立于传输初始化直接显示，首页不核对或识别人脸', (tester) async {
    smallScreen(tester);
    final gateway = GalleryGateway();
    final gallery = SystemGalleryController(gateway: gateway);
    final transfer = IdleTransfer();
    final family = IdleFamily(transfer);
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: transfer,
          familyController: family,
          galleryController: gallery,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byType(SystemPhotoTile), findsWidgets);
    expect(
      tester.getTopLeft(find.byType(SystemPhotoTile).first).dy,
      lessThan(170),
    );
    expect(find.text('按月份扫描'), findsNothing);
    expect(find.text('尚未连接电脑'), findsNothing);
    expect(find.text('传到电脑'), findsNothing);
    expect(transfer.albumReads, 0);
    expect(transfer.hashReads, 0);
    expect(family.scans, 0);
    expect(gateway.source.items.first.originalReads, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('长按进入多选后才显示上传，取消恢复网格，大字体不溢出', (tester) async {
    smallScreen(tester, width: 280, scale: 2);
    final gallery = SystemGalleryController(gateway: GalleryGateway());
    await gallery.initialize();
    addTearDown(gallery.dispose);
    Set<String>? uploaded;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SafeArea(
            child: SystemGalleryScreen(
              controller: gallery,
              onUpload: (ids) async {
                uploaded = ids;
                return true;
              },
              onOrganize: (_) async {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('传到电脑'), findsNothing);
    await tester.longPress(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    expect(find.text('已选 1 项'), findsOneWidget);
    expect(find.text('传到电脑'), findsOneWidget);
    expect(find.text('1:12'), findsOneWidget);
    await tester.tap(find.text('传到电脑'));
    await tester.pumpAndSettle();
    expect(uploaded, {'photo'});
    expect(find.text('传到电脑'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('点击直接预览原文件，宝宝整理仅由明确按钮触发', (tester) async {
    smallScreen(tester);
    final gateway = GalleryGateway();
    final gallery = SystemGalleryController(gateway: gateway);
    await gallery.initialize();
    addTearDown(gallery.dispose);
    var organized = 0;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            onUpload: (_) async => false,
            onOrganize: (_) async {
              organized++;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    expect(find.byType(SystemMediaPreview), findsOneWidget);
    expect(gateway.source.items.first.originalReads, 1);
    expect(organized, 0);
    await tester.tap(find.text('宝宝整理'));
    await tester.pumpAndSettle();
    expect(organized, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('部分授权网格可浏览且类型筛选查询系统，权限撤销有简洁入口', (tester) async {
    smallScreen(tester);
    final gateway = GalleryGateway()..state = PermissionState.limited;
    final gallery = SystemGalleryController(gateway: gateway);
    await gallery.initialize();
    addTearDown(gallery.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            onUpload: (_) async => false,
            onOrganize: (_) async {},
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('仅显示已授权的照片和视频'), findsOneWidget);
    await tester.tap(find.byTooltip('相册操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('只看视频'));
    await tester.pumpAndSettle();
    expect(gateway.types.last, RequestType.video);
    gateway.state = PermissionState.denied;
    await gallery.refresh();
    await tester.pumpAndSettle();
    expect(find.byType(SystemPhotoTile), findsNothing);
    expect(find.text('允许访问相册'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
