import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'preview_test_helpers.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

Json syntheticFace(String id, {int axis = 0}) => {
  'id': id,
  'x': 0.1,
  'y': 0.1,
  'width': 0.25,
  'height': 0.25,
  'embedding': List<double>.generate(128, (index) => index == axis ? 1 : 0),
};

BabyProfile syntheticBaby() => BabyProfile({
  'id': 'baby',
  'name': '小满',
  'birthday': '2024-02-01',
  'autoMatch': true,
  'referenceFaces': <Json>[],
  'updatedAt': '2026-01-01T00:00:00.000Z',
});

class ScanSource extends SystemGallerySource {
  ScanSource(this.media);
  final List<AssetEntity> media;
  @override
  Future<int> count() async => media.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async => media.skip(number * size).take(size).toList();
}

class ScanGateway extends SystemGalleryGateway {
  ScanGateway(this.media);
  final List<AssetEntity> media;
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async =>
      ScanSource(media);
  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class ScanFamily extends FamilyController {
  ScanFamily(super.transfer, List<AssetEntity> media)
    : super(
        galleryGateway: ScanGateway(media),
        mediaResolver: (id) async =>
            media.where((item) => item.id == id).firstOrNull,
      );
  final analyzed = <String>[];
  @override
  Future<FamilyAsset> registerMedia(
    AssetEntity media, {
    bool persistRecord = true,
  }) async => assets[media.id]!;
  @override
  Future<void> analyze(FamilyAsset asset) async {
    analyzed.add(asset.id);
    asset.data['faceState'] = 'done';
    asset.data['_faceModel'] = 'sface-mobile-v1';
    asset.data.remove('faceError');
  }
}

class SequencedFamily extends FamilyController {
  SequencedFamily(super.transfer, this.file);
  final File file;
  final Map<String, Completer<File?>> pending = {};
  final Set<String> failed = {};
  @override
  Future<File?> fileFor(FamilyAsset asset) async {
    if (pending.containsKey(asset.id)) return pending[asset.id]!.future;
    if (failed.contains(asset.id)) throw StateError('合成预览失败');
    return file;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test('人工确认不添加参考，混合集合不混入排除或未归类媒体', () async {
    final transfer = TransferController(),
        model = FamilyController(TransferController());
    addTearDown(() {
      model.transfer.dispose();
      model.dispose();
      transfer.dispose();
    });
    for (final id in ['manual', 'candidate', 'excluded', 'unknown']) {
      model.assets[id] = FamilyAsset({'id': id, '_localId': id});
    }
    final baby = syntheticBaby();
    model.babies[baby.id] = baby;
    await model.decide('baby', 'manual', 'included');
    model.decisions['baby:candidate'] = {
      'state': 'candidate',
      'origin': 'recognition',
    };
    model.decisions['baby:excluded'] = {
      'state': 'excluded',
      'origin': 'manual',
    };
    expect(
      model
          .collection('baby', includeCandidates: true)
          .map((asset) => asset.id),
      unorderedEquals(['manual', 'candidate']),
    );
    expect(baby.references, isEmpty);
    expect(babyStatusLabel(model.decisions['baby:manual']), '人工确认');
    expect(babyStatusLabel(model.decisions['baby:candidate']), '疑似');
  });

  test('参考重匹配复用全部缓存并保留人工排除，满 20 个拒绝新参考', () async {
    final transfer = TransferController(),
        model = FamilyController(TransferController());
    addTearDown(() {
      model.transfer.dispose();
      model.dispose();
      transfer.dispose();
    });
    final baby = syntheticBaby();
    model.babies[baby.id] = baby;
    for (var index = 0; index < 120; index++) {
      model.assets['photo-$index'] = FamilyAsset({
        'id': 'photo-$index',
        '_localId': 'photo-$index',
        'faces': [syntheticFace('face-$index')],
      });
    }
    await model.decide('baby', 'photo-119', 'excluded');
    final first = model.assets['photo-0']!;
    await model.reference(baby, first, first.faces.first);
    expect(model.collection('baby'), hasLength(119));
    expect(model.decision('baby', 'photo-119'), 'excluded');
    expect(model.isReference('baby', 'photo-0'), isTrue);
    expect(model.notice, contains('新增 118 项'));
    for (var index = 1; index < 20; index++) {
      final asset = model.assets['photo-$index']!;
      await model.reference(baby, asset, asset.faces.first);
    }
    final overflow = model.assets['photo-20']!;
    await expectLater(
      model.reference(baby, overflow, overflow.faces.first),
      throwsStateError,
    );
    expect(baby.references, hasLength(20));
    expect(baby.references.first['assetId'], 'photo-0');
  });

  test('读取失败原因保留并继续后续项，普通扫描不重试失败、仅重试失败不分析完成项', () async {
    final transfer = TransferController();
    final media = [
      for (final id in ['cached', 'failed', 'pending'])
        AssetEntity(id: id, typeInt: 1, width: 2, height: 2),
    ];
    final model = ScanFamily(transfer, media)
      ..ready = true
      ..modelReady = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    for (final item in media) {
      model.assets[item.id] = FamilyAsset({
        'id': item.id,
        '_localId': item.id,
        '_faceModel': 'sface-mobile-v1',
        'faceState': item.id == 'cached'
            ? 'done'
            : item.id == 'failed'
            ? 'error'
            : 'pending',
        if (item.id == 'failed') 'faceError': '合成损坏图片',
      });
    }
    await model.scan();
    expect(model.scanProcessed, 3);
    expect(model.scanCached, 1);
    expect(model.analyzed, ['pending']);
    expect(model.scanFailures['failed']?['reason'], contains('合成损坏图片'));
    await model.retryScanFailures();
    expect(model.analyzed, ['pending', 'failed']);
    expect(model.scanFailures, isEmpty);
    await model.scan();
    expect(model.analyzed, ['pending', 'failed']);
    expect(model.scanCached, 3);
  });

  test('创建时间即使被旧记录标记确认也不能制作准确月龄水印', () {
    final asset = FamilyAsset({
      'id': 'photo',
      '_localId': 'photo',
      'kind': 'photo',
      'date': '2024-02-01',
      'dateConfirmed': true,
      'dateSource': 'creation',
    });
    expect(
      watermarkUnavailableReason(asset, syntheticBaby()),
      contains('拍摄日期待确认'),
    );
    asset.data['dateSource'] = 'manual';
    expect(watermarkUnavailableReason(asset, syntheticBaby()), isNull);
  });

  test('选择头像与保存档案独立于参考，不启动扫描或匹配', () async {
    final transfer = TransferController(),
        model = FamilyController(TransferController());
    addTearDown(() {
      model.transfer.dispose();
      model.dispose();
      transfer.dispose();
    });
    final baby = syntheticBaby();
    model.babies[baby.id] = baby;
    var picker = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(FamilyController.channel, (call) async {
          expect(call.method, 'chooseAvatar');
          picker++;
          return '/synthetic/private-avatar.jpg';
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(FamilyController.channel, null),
    );
    await model.chooseAvatar(baby);
    await model.saveBaby(
      id: baby.id,
      name: '新的名字',
      birthday: baby.birthday,
      autoMatch: true,
    );
    expect(model.babies[baby.id]!.avatarPath, '/synthetic/private-avatar.jpg');
    expect(model.babies[baby.id]!.references, isEmpty);
    expect(picker, 1);
    expect(model.matching, isFalse);
  });

  late File photo;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp(
      'momentnest-experience-',
    );
    photo = File('${directory.path}/synthetic.png');
    await photo.writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
      ),
    );
  });

  testWidgets('普通预览以照片为主体、信息按需展开，确认归属不自动标脸或添加参考', (tester) async {
    final transfer = TransferController(),
        model = SequencedFamily(TransferController(), photo);
    addTearDown(() {
      model.dispose();
      model.transfer.dispose();
      transfer.dispose();
    });
    final baby = syntheticBaby();
    model.babies[baby.id] = baby;
    final asset = FamilyAsset({
      'id': 'photo',
      'filename': '宝宝.png',
      '_localId': 'photo',
      'size': 10,
      'width': 1,
      'height': 1,
      'faces': [
        syntheticFace('baby-face'),
        syntheticFace('adult-face', axis: 1),
      ],
    });
    model.assets[asset.id] = asset;
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(controller: model, asset: asset, baby: baby),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('preview-face-0')), findsNothing);
    expect(find.text('确认或修改拍摄日期'), findsNothing);
    final canvas = tester.getRect(find.byKey(const ValueKey('preview-canvas')));
    expect(
      canvas.height,
      greaterThan(
        tester.view.physicalSize.height / tester.view.devicePixelRatio * 0.6,
      ),
    );
    await choosePreviewTool(tester, 'preview-included');
    expect(model.decision('baby', 'photo'), 'included');
    expect(baby.references, isEmpty);
    await choosePreviewTool(tester, 'preview-information');
    expect(find.text('确认或修改拍摄日期'), findsOneWidget);
    await tester.tapAt(const Offset(5, 75));
    await tester.pumpAndSettle();
    expect(find.text('确认或修改拍摄日期'), findsNothing);
    expect(find.byType(MediaPreview), findsOneWidget);
    await choosePreviewTool(tester, 'preview-reference');
    expect(find.byKey(const ValueKey('preview-face-0')), findsOneWidget);
    final save = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, '将选中人脸设为宝宝参考'),
    );
    expect(save.onPressed, isNull);
    await tester.tap(find.text('人脸 2'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('将选中人脸设为宝宝参考'));
    await tester.pumpAndSettle();
    expect(baby.references.single['faceId'], 'adult-face');
    expect(find.byKey(const ValueKey('preview-face-0')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('相邻图失败可继续左右滑动，旧图片迟到不替换新图片', (tester) async {
    final transfer = TransferController(),
        model = SequencedFamily(TransferController(), photo);
    addTearDown(() {
      model.dispose();
      model.transfer.dispose();
      transfer.dispose();
    });
    final sequence = [
      for (final id in ['first', 'failed', 'last'])
        FamilyAsset({'id': id, 'filename': '$id.png', 'size': 10}),
    ];
    model.pending['first'] = Completer<File?>();
    model.failed.add('failed');
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(
          controller: model,
          asset: sequence.first,
          sequence: sequence,
        ),
      ),
    );
    await tester.pump();
    await tester.drag(
      find.byKey(const ValueKey('preview-canvas')),
      const Offset(-150, 0),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('合成预览失败'), findsOneWidget);
    await tester.drag(
      find.byKey(const ValueKey('preview-canvas')),
      const Offset(-150, 0),
    );
    await tester.pumpAndSettle();
    expect(find.text('last.png'), findsOneWidget);
    model.pending['first']!.completeError(StateError('旧读取迟到'));
    await tester.pumpAndSettle();
    expect(find.text('last.png'), findsOneWidget);
    expect(find.textContaining('旧读取迟到'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320px 大字体预览与多人选脸保留画布，信息抽屉和关闭入口均可见', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final transfer = TransferController();
    final model = SequencedFamily(transfer, photo);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final baby = syntheticBaby()..data['name'] = '这是一份很长的宝宝昵称用于检查预览窄屏布局';
    final asset = FamilyAsset({
      'id': 'photo',
      'filename': '窄屏很长的照片名称.png',
      'size': 10,
      'width': 1,
      'height': 1,
      'faces': [syntheticFace('first'), syntheticFace('second', axis: 1)],
    });
    model.babies[baby.id] = baby;
    model.assets[asset.id] = asset;
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(controller: model, asset: asset, baby: baby),
      ),
    );
    await tester.pumpAndSettle();
    expect(
      tester.getRect(find.byKey(const ValueKey('preview-canvas'))).height,
      greaterThan(250),
    );
    await choosePreviewTool(tester, 'preview-reference');
    expect(find.text('将选中人脸设为宝宝参考'), findsOneWidget);
    expect(
      tester.getRect(find.byKey(const ValueKey('preview-canvas'))).height,
      greaterThan(180),
    );
    await choosePreviewTool(tester, 'preview-information');
    await tester.ensureVisible(find.text('确认或修改拍摄日期'));
    expect(find.byTooltip('关闭信息'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭信息'));
    await tester.pumpAndSettle();
    expect(find.byTooltip('返回相册'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
