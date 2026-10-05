import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 使用合成原图验证弹层返回，不读取系统相册或建立网络连接。
class ToolPreviewController extends FamilyController {
  ToolPreviewController(super.transfer, this.original)
    : super(mediaResolver: (_) async => null);

  final File original;

  @override
  Future<File?> fileFor(FamilyAsset asset) async => original;
}

void main() {
  late TransferController transfer;
  late ToolPreviewController model;
  late BabyProfile baby;

  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('momentnest-tools-');
    final photo = File('${directory.path}/pixel.png');
    await photo.writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
      ),
    );
    transfer = TransferController();
    model = ToolPreviewController(transfer, photo)..ready = true;
    baby = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-02-01',
      'autoMatch': false,
      'referenceFaces': [
        for (var index = 0; index < 16; index++)
          {'assetId': 'photo-$index', 'faceId': 'face-$index'},
      ],
    });
    model.babies[baby.id] = baby;
    model.activeBaby = baby.id;
    for (var index = 0; index < 16; index++) {
      model.assets['photo-$index'] = FamilyAsset({
        'id': 'photo-$index',
        '_localId': 'photo-$index',
        '_thumb': photo.path,
        'filename': '参考照片-$index.png',
      });
    }
  });

  tearDown(() {
    model.dispose();
    transfer.dispose();
  });

  testWidgets('参考照片反复预览后返回同一弹层并保留滚动位置', (tester) async {
    tester.view.physicalSize = const Size(360, 640);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BabyScreen(controller: model, onTransfer: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('管理人脸参考'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('参考照片-10.png'));
    await tester.pumpAndSettle();
    final scrollable = tester.state<ScrollableState>(
      find.descendant(
        of: find.byType(BottomSheet),
        matching: find.byType(Scrollable),
      ),
    );
    final offset = scrollable.position.pixels;
    expect(offset, greaterThan(0));

    for (var attempt = 0; attempt < 2; attempt++) {
      await tester.tap(find.text('参考照片-10.png'));
      await tester.pumpAndSettle();
      expect(find.byType(MediaPreview), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(MediaPreview),
          matching: find.byType(Image),
        ),
        findsOneWidget,
      );
      if (attempt == 0) {
        await tester.tap(find.byTooltip('返回相册'));
      } else {
        await tester.binding.handlePopRoute();
      }
      await tester.pumpAndSettle();
      expect(find.byType(MediaPreview), findsNothing);
      expect(find.text('小满的人脸参考'), findsOneWidget);
      expect(
        tester.state<ScrollableState>(
          find.descendant(
            of: find.byType(BottomSheet),
            matching: find.byType(Scrollable),
          ),
        ),
        same(scrollable),
      );
      expect(scrollable.position.pixels, offset);
    }

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(BottomSheet), findsNothing);
    expect(find.byKey(const ValueKey('baby-tools')), findsOneWidget);
    expect(baby.references, hasLength(16));
    expect(model.assets, hasLength(16));
    expect(tester.takeException(), isNull);
  });
}
