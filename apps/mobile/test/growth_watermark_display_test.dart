import 'dart:io';
import 'dart:ui' as ui;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'preview_test_helpers.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/growth_watermark_overlay.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

class DisplayStore extends LocalStore {
  final values = <String, Object?>{};
  bool fail = false;
  @override
  Future<void> open() async {}
  @override
  Future<void> close() async {}
  @override
  Future<dynamic> preference(String key) async => values[key];
  @override
  Future<void> setPreference(String key, Object? value) async {
    if (fail) throw StateError('设置保存失败');
    values[key] = value;
  }
}

class DisplayFamily extends FamilyController {
  DisplayFamily(super.transfer, this.file, DisplayStore store)
    : super(store: store);
  final File file;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => file;
}

BabyProfile displayBaby([String id = 'baby']) => BabyProfile({
  'id': id,
  'name': '小满',
  'birthday': '2025-08-05',
  'autoMatch': false,
  'referenceFaces': [],
});

FamilyAsset displayPhoto(String id, [String? thumbnail]) => FamilyAsset({
  'id': id,
  '_localId': id,
  'filename': '$id.png',
  'kind': 'photo',
  'date': '2025-08-12',
  'dateSource': 'capture',
  'dateConfirmed': true,
  'width': 320,
  'height': 400,
  'faces': [
    {
      'id': 'face',
      'x': 0.1,
      'y': 0.1,
      'width': 0.2,
      'height': 0.2,
      'embedding': List.generate(128, (index) => index == 0 ? 1.0 : 0.0),
    },
  ],
  '_thumb': ?thumbnail,
});

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late File image;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-display-',
    );
    image = File('${directory.path}/synthetic.png');
    final recorder = ui.PictureRecorder();
    ui.Canvas(recorder).drawRect(
      const ui.Rect.fromLTWH(0, 0, 320, 400),
      ui.Paint()..color = const ui.Color(0xFFD9E5DF),
    );
    final picture = recorder.endRecording();
    final rendered = await picture.toImage(320, 400);
    final bytes = await rendered.toByteData(format: ui.ImageByteFormat.png);
    await image.writeAsBytes(bytes!.buffer.asUint8List());
    picture.dispose();
    rendered.dispose();
  });

  test('自动显示只允许确认归属与可靠日期，沿用成长日历口径', () {
    final photo = displayPhoto('photo'), baby = displayBaby();
    expect(
      growthWatermarkDisplayText(photo, baby, 'included'),
      '出生第 8 天\n2025 · 08 · 12',
    );
    for (final state in ['candidate', 'excluded', null]) {
      expect(growthWatermarkDisplayText(photo, baby, state), isNull);
    }
    for (final change in [
      {'kind': 'video'},
      {'dateConfirmed': false},
      {'dateSource': 'creation'},
      {'date': null},
      {'date': '2025-02-30'},
      {'date': '2025-08-04'},
    ]) {
      expect(
        growthWatermarkDisplayText(
          FamilyAsset({...photo.data, ...change}),
          baby,
          'included',
        ),
        isNull,
      );
    }
    photo.data['date'] = '2026-02-08';
    expect(
      growthWatermarkDisplayText(photo, baby, 'included'),
      '6 个月 3 天\n2026 · 02 · 08',
    );
    expect(
      growthWatermarkDisplayText(
        photo,
        BabyProfile({...baby.data, 'birthday': 'invalid'}),
        'included',
      ),
      isNull,
    );
  });

  test('水印显示按宝宝独立记住，保存失败保留原开关', () async {
    final transfer = TransferController(), store = DisplayStore();
    final model = FamilyController(transfer, store: store);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    for (final id in ['first', 'second']) {
      model.babies[id] = displayBaby(id);
    }
    expect(model.growthWatermarkVisible('first'), isTrue);
    await model.setGrowthWatermarkDisplay('first', false);
    expect(model.growthWatermarkVisible('first'), isFalse);
    expect(model.growthWatermarkVisible('second'), isTrue);
    expect(store.values['family-growth-watermark:first'], isFalse);
    store.fail = true;
    await expectLater(
      model.setGrowthWatermarkDisplay('first', true),
      throwsStateError,
    );
    expect(model.growthWatermarkVisible('first'), isFalse);
    expect(store.values, isNot(contains('family-babies')));
  });

  testWidgets('重开手机相册从本地偏好恢复显示开关', (tester) async {
    const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(
      directoryChannel,
      (_) async => image.parent.path,
    );
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'ready': true},
    );
    addTearDown(() {
      messenger.setMockMethodCallHandler(directoryChannel, null);
      messenger.setMockMethodCallHandler(FamilyController.channel, null);
    });
    final store = DisplayStore();
    store.values['family-babies'] = [
      displayBaby().data,
      displayBaby('second').data,
    ];
    store.values['family-growth-watermark:baby'] = false;
    final transfer = TransferController();
    final model = FamilyController(transfer, store: store);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    await tester.runAsync(model.initialize);
    expect(model.notice, isEmpty);
    expect(model.ready, isTrue);
    expect(model.growthWatermarkVisible('baby'), isFalse);
    expect(model.growthWatermarkVisible('second'), isTrue);
  });

  testWidgets('宝宝缩略图默认显示成长水印，疑似不显示，开关不生成媒体', (tester) async {
    tester.view.physicalSize = const Size(360, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final transfer = TransferController(), store = DisplayStore();
    final model = DisplayFamily(transfer, image, store)
      ..ready = true
      ..activeBaby = 'baby';
    model.babies['baby'] = displayBaby();
    model.babies['baby']!.data['referenceFaces'] = [
      {'assetId': 'included', 'faceId': 'face'},
    ];
    for (final id in ['included', 'candidate']) {
      model.assets[id] = displayPhoto(id, image.path);
      model.decisions['baby:$id'] = {'state': id, 'origin': 'manual'};
    }
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final original = await tester.runAsync(image.readAsBytes);
    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));
    await tester.runAsync(
      () => precacheImage(
        FileImage(image),
        tester.element(find.byType(MaterialApp)),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BabyScreen(controller: model, onTransfer: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      find.byKey(const ValueKey('baby-growth-overlay-included')),
      findsOneWidget,
    );
    expect(
      find.byKey(const ValueKey('baby-growth-overlay-candidate')),
      findsNothing,
    );
    final tile = find.byKey(const ValueKey('baby-media-included'));
    final date = find.descendant(
      of: tile,
      matching: find.text('2025 · 08 · 12'),
    );
    final reference = find.descendant(of: tile, matching: find.text('已作参考'));
    expect(tester.getRect(date).overlaps(tester.getRect(reference)), isFalse);
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pumpAndSettle();
    final toggle = find.byKey(const ValueKey('baby-watermark-display'));
    await tester.ensureVisible(toggle);
    await tester.tap(toggle);
    await tester.pumpAndSettle();
    expect(find.text('水印显示已关'), findsOneWidget);
    Navigator.pop(tester.element(toggle));
    await tester.pumpAndSettle();
    expect(find.byType(GrowthWatermarkOverlay), findsNothing);
    expect(await tester.runAsync(image.readAsBytes), original);
    expect(model.assets.length, 2);
    expect(store.values.keys, ['family-growth-watermark:baby']);
    expect(tester.takeException(), isNull);
  });

  testWidgets('预览和缩略图共用水印开关，重开保留设置，选参考隐藏且底图不变', (tester) async {
    final transfer = TransferController(), store = DisplayStore();
    final model = DisplayFamily(transfer, image, store);
    final baby = displayBaby(), photo = displayPhoto('photo');
    model.babies['baby'] = baby;
    model.assets[photo.id] = photo;
    model.decisions['baby:${photo.id}'] = {
      'state': 'included',
      'origin': 'manual',
    };
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    await tester.pumpWidget(const MaterialApp(home: SizedBox.shrink()));
    await tester.runAsync(
      () => precacheImage(
        FileImage(image),
        tester.element(find.byType(MaterialApp)),
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(controller: model, asset: photo, baby: baby),
      ),
    );
    await tester.pumpAndSettle();
    final overlay = find.byKey(const ValueKey('preview-growth-overlay'));
    expect(overlay, findsOneWidget);
    expect(
      find.ancestor(of: overlay, matching: find.byType(InteractiveViewer)),
      findsOneWidget,
    );
    final viewer = tester.widget<InteractiveViewer>(
      find.byType(InteractiveViewer),
    );
    final fitted = tester.getSize(overlay).width;
    viewer.transformationController!.value = Matrix4.diagonal3Values(2, 2, 1);
    await tester.pump();
    expect(overlay, findsOneWidget);
    expect(tester.getRect(overlay).width, closeTo(fitted * 2, 0.01));
    await choosePreviewTool(tester, 'preview-watermark-display');
    expect(overlay, findsNothing);
    expect(model.growthWatermarkVisible('baby'), isFalse);
    await choosePreviewTool(tester, 'preview-watermark-display');
    expect(overlay, findsOneWidget);
    await choosePreviewTool(tester, 'preview-reference');
    expect(overlay, findsNothing);
    expect(find.byKey(const ValueKey('preview-face-0')), findsOneWidget);
    expect(model.growthWatermarkVisible('baby'), isTrue);
    expect(store.values, {'family-growth-watermark:baby': true});
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(
          key: const ValueKey('reopened'),
          controller: model,
          asset: photo,
          baby: baby,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(overlay, findsOneWidget);
    expect(find.byKey(const ValueKey('preview-face-0')), findsNothing);
    await model.setGrowthWatermarkDisplay('baby', false);
    await tester.pumpAndSettle();
    expect(overlay, findsNothing);
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(
          key: const ValueKey('reopened-off'),
          controller: model,
          asset: photo,
          baby: baby,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(overlay, findsNothing);
    final preview = tester.widget<Image>(find.byType(Image).first);
    expect((preview.image as FileImage).file.path, image.path);
    expect(store.values, {'family-growth-watermark:baby': false});
    expect(tester.takeException(), isNull);
  });
}
