import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'preview_test_helpers.dart';

class PreviewController extends FamilyController {
  PreviewController(super.transfer, this.file);
  final File file;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => file;
  @override
  Future<void> analyze(FamilyAsset asset) async {
    asset.data['faces'] = [face('replacement')];
    changed();
  }
}

Json face(String id) => {
  'id': id,
  'x': 0.1,
  'y': 0.1,
  'width': 0.3,
  'height': 0.3,
  'embedding': List<double>.generate(128, (index) => index == 0 ? 1 : 0),
};

BabyProfile baby() => BabyProfile({
  'id': 'baby',
  'name': '小满',
  'birthday': '2024-02-01',
  'autoMatch': true,
  'referenceFaces': [],
});

void main() {
  late File photo;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('momentnest-widget-');
    photo = File('${directory.path}/pixel.png');
    await photo.writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
      ),
    );
  });

  testWidgets('出生前日期不能调用水印导出，向用户说明需要修正日期', (tester) async {
    var invoked = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(FamilyController.channel, (_) async {
          invoked++;
          return {'path': photo.path, 'gallery': false};
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(FamilyController.channel, null),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: FamilyAsset({
            'id': 'photo',
            'date': '2024-01-31',
            'dateConfirmed': true,
            'dateSource': 'capture',
          }),
          baby: baby(),
          file: photo,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('导出水印副本'));
    await tester.tap(find.text('导出水印副本'));
    await tester.pumpAndSettle();
    expect(invoked, 0);
    expect(find.text('拍摄日期早于宝宝出生日期，请先修正日期。'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('重新分析人脸后清空旧选择，避免使用已不存在的人脸索引', (tester) async {
    final transfer = TransferController();
    final model = PreviewController(transfer, photo);
    final asset = FamilyAsset({
      'id': 'photo',
      '_localId': 'photo',
      'filename': 'pixel.png',
      'kind': 'photo',
      'size': 1,
      'faces': [face('first'), face('second')],
    });
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(controller: model, asset: asset, baby: baby()),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('preview-face-0')), findsNothing);
    await choosePreviewTool(tester, 'preview-reference');
    await tester.ensureVisible(find.text('人脸 2'));
    await tester.tap(find.text('人脸 2'));
    await tester.pumpAndSettle();
    await choosePreviewTool(tester, 'preview-information');
    await tester.ensureVisible(find.text('离线分析人脸'));
    await tester.tap(find.text('离线分析人脸'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('关闭信息'));
    await tester.pumpAndSettle();
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '将选中人脸设为宝宝参考'),
    );
    expect(button.onPressed, isNull);
    expect(tester.takeException(), isNull);
  });
}
