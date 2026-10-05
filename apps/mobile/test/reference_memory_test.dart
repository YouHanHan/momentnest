import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'preview_test_helpers.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 使用合成大图和真实解码器验证高清预览，不读取个人相册。
class MemoryPreviewController extends FamilyController {
  MemoryPreviewController(super.transfer, this.photo);
  final File photo;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => photo;
}

/// 读取真实解码尺寸，并保留独立图像句柄供断言后释放。
Future<ui.Image> decoded(ImageProvider provider) async {
  final stream = provider.resolve(ImageConfiguration.empty);
  final completion = Completer<ui.Image>();
  final listener = ImageStreamListener(
    (info, _) => completion.complete(info.image.clone()),
    onError: (Object error, StackTrace? stack) =>
        completion.completeError(error, stack),
  );
  stream.addListener(listener);
  try {
    return await completion.future;
  } finally {
    stream.removeListener(listener);
  }
}

void main() {
  for (final size in [(6000, 2000), (2000, 6000)]) {
    testWidgets('大图 ${size.$1}×${size.$2} 高清预览与选脸头像共用解码图像', (tester) async {
      final photo = File(
        'test/fixtures/reference-${size.$1 > size.$2 ? 'landscape' : 'portrait'}.png',
      );
      final transfer = TransferController();
      final model = MemoryPreviewController(transfer, photo);
      final baby = BabyProfile({
        'id': 'baby',
        'name': '小满',
        'birthday': '2024-02-01',
        'referenceFaces': [],
      });
      final asset = FamilyAsset({
        'id': 'photo',
        '_localId': 'photo',
        'kind': 'photo',
        'width': size.$1,
        'height': size.$2,
        'faces': List.generate(
          3,
          (index) => {
            'id': 'face-$index',
            'x': 0.1,
            'y': 0.1,
            'width': 0.01 * (index + 1),
            'height': 0.02,
            'embedding': List<double>.generate(
              128,
              (index) => index == 0 ? 1 : 0,
            ),
          },
        ),
      });
      model.babies[baby.id] = baby;
      model.assets[asset.id] = asset;
      addTearDown(() {
        model.dispose();
        transfer.dispose();
        PaintingBinding.instance.imageCache.clear();
        PaintingBinding.instance.imageCache.clearLiveImages();
      });
      await tester.pumpWidget(
        MaterialApp(
          home: MediaPreview(controller: model, asset: asset, baby: baby),
        ),
      );
      await tester.pumpAndSettle();
      final preview = tester.widget<Image>(find.byType(Image).first);
      final image = await tester.runAsync(() async {
        await preview.image.evict();
        return decoded(preview.image);
      });
      try {
        expect(image!.width, size.$1);
        expect(image.height, size.$2);
        expect(image.width / image.height, closeTo(size.$1 / size.$2, 0.005));
      } finally {
        image?.dispose();
      }
      await choosePreviewTool(tester, 'preview-reference');
      final providers = tester
          .widgetList<Image>(find.byType(Image))
          .map((image) => image.image)
          .toList();
      expect(providers, hasLength(4));
      expect(
        await providers.first.obtainKey(ImageConfiguration.empty),
        await preview.image.obtainKey(ImageConfiguration.empty),
        reason: '进入选脸保持同一份原尺寸大图预览',
      );
      final previewKey = await preview.image.obtainKey(
        ImageConfiguration.empty,
      );
      for (final provider in providers.skip(1)) {
        expect(
          await provider.obtainKey(ImageConfiguration.empty),
          previewKey,
          reason: '不同大小的人脸头像复用大图缓存，不再各自解码整张照片',
        );
      }
      final selectingImage = await tester.runAsync(() async {
        await providers.first.evict();
        return decoded(providers.first);
      });
      try {
        expect(selectingImage!.width, size.$1);
        expect(selectingImage.height, size.$2);
        final cacheBytes = PaintingBinding.instance.imageCache.currentSizeBytes;
        for (final provider in providers.skip(1)) {
          final avatarImage = await tester.runAsync(() => decoded(provider));
          try {
            expect(
              avatarImage!.isCloneOf(selectingImage),
              isTrue,
              reason: '真实解码后，头像与高清预览共享同一份像素数据',
            );
          } finally {
            avatarImage?.dispose();
          }
        }
        expect(
          PaintingBinding.instance.imageCache.currentSizeBytes,
          cacheBytes,
          reason: '增加选脸头像不增加整图解码缓存占用',
        );
      } finally {
        selectingImage?.dispose();
      }
      await tester.tap(find.text('退出选脸'));
      await tester.pumpAndSettle();
      expect(find.byType(ChoiceChip), findsNothing);
      expect(
        await tester
            .widget<Image>(find.byType(Image).first)
            .image
            .obtainKey(ImageConfiguration.empty),
        await preview.image.obtainKey(ImageConfiguration.empty),
        reason: '退出选脸继续保留原尺寸预览',
      );
      expect(baby.references, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox.shrink());
    });
  }

  testWidgets('原生检测内存不足时留在预览，重试后才允许选脸', (tester) async {
    final photo = File('test/fixtures/reference-landscape.png');
    final transfer = TransferController();
    final model = MemoryPreviewController(transfer, photo);
    final baby = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-02-01',
      'referenceFaces': [],
    });
    final asset = FamilyAsset({
      'id': 'photo',
      '_localId': 'photo',
      'faces': [],
    });
    model.babies[baby.id] = baby;
    model.assets[asset.id] = asset;
    var attempts = 0;
    const message = '手机可用内存不足，暂时无法检测人脸。请关闭其他应用后重试，或换一张分辨率较低的照片。';
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(FamilyController.channel, (call) async {
          if (call.method != 'analyze') throw StateError('只允许本机检测');
          if (++attempts == 1) {
            throw PlatformException(
              code: 'FAMILY_MEDIA_MEMORY',
              message: message,
            );
          }
          return {
            'faces': [
              {
                'id': 'face',
                'x': 0.1,
                'y': 0.1,
                'width': 0.3,
                'height': 0.3,
                'embedding': List<double>.generate(
                  128,
                  (index) => index == 0 ? 1 : 0,
                ),
              },
            ],
          };
        });
    addTearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(FamilyController.channel, null);
      model.dispose();
      transfer.dispose();
    });
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(controller: model, asset: asset, baby: baby),
      ),
    );
    await tester.pumpAndSettle();
    await tester.runAsync(() async {
      await choosePreviewTool(tester, 'preview-reference');
    });
    await tester.pumpAndSettle();
    expect(find.textContaining(message), findsOneWidget);
    expect(find.textContaining('已等待'), findsNothing);
    expect(find.text('人脸 1'), findsNothing);
    expect(baby.references, isEmpty);
    await tester.runAsync(() async {
      await choosePreviewTool(tester, 'preview-reference');
    });
    await tester.pumpAndSettle();
    expect(find.text('人脸 1'), findsOneWidget);
    expect(attempts, 2);
    expect(find.textContaining('已等待'), findsNothing);
    expect(baby.references, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
