import 'dart:io';
import 'dart:typed_data';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';

class OriginalGalleryAsset extends AssetEntity {
  OriginalGalleryAsset(this.original)
    : super(id: 'original', typeInt: 1, width: 4800, height: 80);
  final File original;
  final _reads = [0, 0];
  int get originalReads => _reads[0];
  int get thumbnailReads => _reads[1];

  @override
  Future<File?> get originFile async {
    _reads[0]++;
    return original;
  }

  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async {
    _reads[1]++;
    return null;
  }
}

class OriginalPreviewController extends FamilyController {
  OriginalPreviewController(super.transfer, this.original);
  final File original;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => original;
}

void main() {
  late File original;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp(
      'momentnest-original-',
    );
    original = File('${directory.path}/original.png');
    final recorder = ui.PictureRecorder();
    final canvas = ui.Canvas(recorder);
    canvas.drawRect(
      const ui.Rect.fromLTWH(0, 0, 4800, 80),
      ui.Paint()..color = const Color(0xFF284AA6),
    );
    canvas.drawRect(
      const ui.Rect.fromLTWH(4700, 0, 100, 80),
      ui.Paint()..color = const Color(0xFFFFA421),
    );
    final picture = recorder.endRecording();
    final image = await picture.toImage(4800, 80);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await original.writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
    picture.dispose();
  });

  /// 检查加载来源、解码尺寸与显示方式，避免以后用缩略图优化普通预览。
  Future<void> expectOriginal(WidgetTester tester, Widget preview) async {
    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));
    await tester.runAsync(
      () => precacheImage(
        FileImage(original),
        tester.element(find.byType(MaterialApp)),
      ),
    );
    await tester.pumpWidget(MaterialApp(home: preview));
    await tester.pumpAndSettle();
    final image = tester.widget<Image>(find.byType(Image).first);
    expect(image.image, isA<FileImage>());
    expect((image.image as FileImage).file.path, original.path);
    expect(image.fit, BoxFit.contain);
    final rendered = tester.widget<RawImage>(find.byType(RawImage).first);
    expect(rendered.image!.width, 4800);
    expect(rendered.image!.height, 80);
    expect(tester.takeException(), isNull);
  }

  testWidgets('系统相册预览读取完整原图，不请求缩略图或限制大图尺寸', (tester) async {
    final asset = OriginalGalleryAsset(original);
    await expectOriginal(tester, SystemMediaPreview(asset: asset));
    expect(asset.originalReads, 1);
    expect(asset.thumbnailReads, 0);
  });

  testWidgets('宝宝普通预览忽略缩略图缓存，保留原图完整分辨率', (tester) async {
    final transfer = TransferController();
    final controller = OriginalPreviewController(transfer, original);
    addTearDown(() {
      controller.dispose();
      transfer.dispose();
    });
    final asset = FamilyAsset({
      'id': 'original',
      '_localId': 'original',
      '_thumb': '${original.parent.path}/thumbnail.jpg',
      'filename': 'original.png',
      'kind': 'photo',
      'width': 4800,
      'height': 80,
      'faces': [],
    });
    final bytes = await tester.runAsync(original.readAsBytes);
    await expectOriginal(
      tester,
      MediaPreview(controller: controller, asset: asset),
    );
    expect(await tester.runAsync(original.readAsBytes), bytes);
  });
}
