import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/preview_swipe_navigation.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';
import 'preview_test_helpers.dart';

class SwipeAsset extends AssetEntity {
  SwipeAsset(String id, this.original)
    : super(id: id, typeInt: 1, width: 1, height: 1);
  final Future<File?> original;

  @override
  Future<File?> get originFile => original;

  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async => null;
}

class SwipeSource extends SystemGallerySource {
  SwipeSource(this.items);
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

class SwipeGateway extends SystemGalleryGateway {
  SwipeGateway(this.source);
  final SwipeSource source;

  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;

  @override
  Future<SystemGallerySource?> open({required RequestType type}) async =>
      source;

  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class SwipeFamily extends FamilyController {
  SwipeFamily(super.transfer, this.original);
  final File original;

  @override
  Future<File?> fileFor(FamilyAsset asset) async => original;
}

void main() {
  late File photo;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('jinchuan-swipe-');
    photo = File('${directory.path}/photo.png');
    await photo.writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
      ),
    );
  });

  Future<void> swipe(WidgetTester tester, double horizontal) async {
    await tester.drag(
      find.byKey(const ValueKey('system-preview-canvas')),
      Offset(horizontal, 0),
    );
    await tester.pumpAndSettle();
  }

  testWidgets('从相册点图后可左右切换、末尾追加下一页，操作始终使用当前照片', (tester) async {
    final items = [
      for (var i = 0; i < 3; i++) SwipeAsset('$i', Future.value(photo)),
    ];
    final source = SwipeSource(items);
    final gallery = SystemGalleryController(
      gateway: SwipeGateway(source),
      pageSize: 2,
    );
    addTearDown(gallery.dispose);
    await gallery.initialize();
    Set<String>? uploaded;
    String? organized;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            onUpload: (ids) async {
              uploaded = ids;
              return false;
            },
            onOrganize: (asset) async {
              organized = asset.id;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    expect(find.text('1 / 2'), findsOneWidget);
    await swipe(tester, 120);
    expect(find.text('1 / 2'), findsOneWidget);
    await swipe(tester, -120);
    expect(find.text('2 / 2'), findsOneWidget);
    await swipe(tester, -120);
    expect(find.text('3 / 3'), findsOneWidget);
    expect(source.pages, [0, 1]);
    await tester.tap(find.text('传到电脑'));
    await tester.pumpAndSettle();
    expect(uploaded, {'2'});
    await tester.tap(find.text('宝宝整理'));
    await tester.pumpAndSettle();
    expect(organized, '2');
    await swipe(tester, -120);
    expect(find.text('3 / 3'), findsOneWidget);
    await swipe(tester, 120);
    expect(find.text('2 / 3'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('缩放、竖滑和双指操作不切图，图片外留白仍可滑动切换', (tester) async {
    final first = SwipeAsset('first', Future.value(photo));
    final second = SwipeAsset('second', Future.value(photo));
    await tester.pumpWidget(
      MaterialApp(
        home: SystemMediaPreview(asset: first, sequence: [first, second]),
      ),
    );
    await tester.pumpAndSettle();
    final viewer = tester.widget<InteractiveViewer>(
      find.byType(InteractiveViewer),
    );
    viewer.transformationController!.value = Matrix4.diagonal3Values(2, 2, 1);
    await swipe(tester, -120);
    expect(find.text('1 / 2'), findsOneWidget);
    viewer.transformationController!.value = Matrix4.identity();
    await tester.drag(
      find.byKey(const ValueKey('system-preview-canvas')),
      const Offset(0, -120),
    );
    await tester.pumpAndSettle();
    expect(find.text('1 / 2'), findsOneWidget);
    final center = tester.getCenter(
      find.byKey(const ValueKey('system-preview-canvas')),
    );
    final left = await tester.startGesture(
      center - const Offset(30, 0),
      pointer: 1,
    );
    final right = await tester.startGesture(
      center + const Offset(30, 0),
      pointer: 2,
    );
    await left.moveBy(const Offset(-120, 0));
    await right.moveBy(const Offset(-120, 0));
    await left.up();
    await right.up();
    await tester.pumpAndSettle();
    expect(find.text('1 / 2'), findsOneWidget);
    viewer.transformationController!.value = Matrix4.identity();
    final corner =
        tester.getTopLeft(find.byKey(const ValueKey('system-preview-canvas'))) +
        const Offset(200, 80);
    await tester.dragFrom(corner, const Offset(-120, 0));
    await tester.pumpAndSettle();
    expect(find.text('2 / 2'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('快速连续切换时旧原图迟到不会覆盖当前照片', (tester) async {
    final delayed = Completer<File?>();
    final first = SwipeAsset('first', delayed.future);
    final second = SwipeAsset('second', Future.value(photo));
    await tester.pumpWidget(
      MaterialApp(
        home: SystemMediaPreview(asset: first, sequence: [first, second]),
      ),
    );
    await tester.pump();
    await swipe(tester, -120);
    expect(find.text('2 / 2'), findsOneWidget);
    delayed.complete(null);
    await tester.pumpAndSettle();
    expect(find.text('暂时无法预览此文件，可检查权限或直接传到电脑。'), findsNothing);
    expect(
      (tester.widget<Image>(find.byType(Image)).image as FileImage).file.path,
      photo.path,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('宝宝相册共用手势，左右切图后继续读取原文件', (tester) async {
    final transfer = TransferController();
    final family = SwipeFamily(transfer, photo);
    addTearDown(() {
      family.dispose();
      transfer.dispose();
    });
    final items = [
      for (var i = 0; i < 2; i++)
        FamilyAsset({
          'id': '$i',
          'filename': '$i.png',
          'kind': 'photo',
          'width': 1,
          'height': 1,
        }),
    ];
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(
          controller: family,
          asset: items.first,
          sequence: items,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.drag(
      find.byKey(const ValueKey('preview-canvas')),
      const Offset(-120, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('1.png'), findsOneWidget);
    await tester.drag(
      find.byKey(const ValueKey('preview-canvas')),
      const Offset(120, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('0.png'), findsOneWidget);
    expect(
      (tester.widget<Image>(find.byType(Image)).image as FileImage).file.path,
      photo.path,
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets('宝宝菜单确认和上传作用于滑动后的当前照片，日常预览没有底栏', (tester) async {
    final transfer = TransferController();
    final family = SwipeFamily(transfer, photo);
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
    final items = [
      for (var i = 0; i < 2; i++)
        FamilyAsset({
          'id': '$i',
          '_localId': '$i',
          'filename': '$i.png',
          'kind': 'photo',
          'width': 1,
          'height': 1,
        }),
    ];
    String? uploaded;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: Builder(
            builder: (context) => TextButton(
              onPressed: () => Navigator.push<void>(
                context,
                MaterialPageRoute(
                  builder: (_) => MediaPreview(
                    controller: family,
                    asset: items.first,
                    sequence: items,
                    baby: baby,
                    onTransferAsset: (asset) => uploaded = asset.id,
                  ),
                ),
              ),
              child: const Text('打开宝宝照片'),
            ),
          ),
        ),
      ),
    );
    await tester.tap(find.text('打开宝宝照片'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('preview-bottom-overlay')), findsNothing);
    await tester.drag(
      find.byKey(const ValueKey('preview-canvas')),
      const Offset(-120, 0),
    );
    await tester.pumpAndSettle();
    await choosePreviewTool(tester, 'preview-included');
    expect(family.decision(baby.id, items.last.id), 'included');
    expect(family.decision(baby.id, items.first.id), isNull);
    expect(baby.references, isEmpty);
    expect(find.byKey(const ValueKey('preview-bottom-overlay')), findsNothing);
    await choosePreviewTool(tester, 'preview-excluded');
    expect(family.decision(baby.id, items.last.id), 'excluded');
    await choosePreviewTool(tester, 'preview-transfer');
    expect(uploaded, items.last.id);
    expect(find.byType(MediaPreview), findsNothing);
    expect(find.text('打开宝宝照片'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('切图跟手移动并有过渡，短滑和首尾边界回弹', (tester) async {
    final first = SwipeAsset('first', Future.value(photo));
    final second = SwipeAsset('second', Future.value(photo));
    await tester.pumpWidget(
      MaterialApp(
        home: SystemMediaPreview(asset: first, sequence: [first, second]),
      ),
    );
    await tester.pumpAndSettle();
    double offset() => tester
        .widget<Transform>(find.byKey(const ValueKey('preview-swipe-offset')))
        .transform
        .getTranslation()
        .x;
    final canvas = find.byKey(const ValueKey('system-preview-canvas'));
    final short = await tester.startGesture(tester.getCenter(canvas));
    await short.moveBy(const Offset(-20, 0));
    await tester.pump();
    expect(offset(), lessThan(0));
    await short.up();
    await tester.pumpAndSettle();
    expect(offset(), 0);
    expect(find.text('1 / 2'), findsOneWidget);
    final drag = await tester.startGesture(tester.getCenter(canvas));
    await drag.moveBy(const Offset(-100, 0));
    await tester.pump();
    expect(offset(), lessThan(-45));
    expect(find.text('1 / 2'), findsOneWidget);
    await drag.up();
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 60));
    expect(offset(), lessThan(-100));
    expect(find.text('1 / 2'), findsOneWidget);
    await tester.pumpAndSettle();
    expect(find.text('2 / 2'), findsOneWidget);
    expect(offset(), 0);
    await swipe(tester, -150);
    expect(find.text('2 / 2'), findsOneWidget);
    expect(offset(), 0);
    expect(find.byTooltip('上一张'), findsNothing);
    expect(find.byTooltip('下一张'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('系统减少动画时切图直接完成，原图读取等待不阻止继续切换', (tester) async {
    final delayed = Completer<File?>();
    final items = [
      SwipeAsset('first', Future.value(photo)),
      SwipeAsset('delayed', delayed.future),
      SwipeAsset('last', Future.value(photo)),
    ];
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => MediaQuery(
            data: MediaQuery.of(context).copyWith(disableAnimations: true),
            child: SystemMediaPreview(asset: items.first, sequence: items),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.drag(
      find.byType(PreviewSwipeNavigation),
      const Offset(-150, 0),
    );
    await tester.pump();
    expect(find.text('2 / 3'), findsOneWidget);
    expect(
      tester
          .widget<Transform>(find.byKey(const ValueKey('preview-swipe-offset')))
          .transform
          .getTranslation()
          .x,
      0,
    );
    await tester.drag(
      find.byType(PreviewSwipeNavigation),
      const Offset(-150, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('3 / 3'), findsOneWidget);
    delayed.complete(null);
    await tester.pumpAndSettle();
    expect(find.text('3 / 3'), findsOneWidget);
    expect(find.text('暂时无法预览此文件，可检查权限或直接传到电脑。'), findsNothing);
    expect(tester.takeException(), isNull);
  });
}
