import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/media_preview.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

Json referenceFace(String id) => {
  'id': id,
  'x': 0.1,
  'y': 0.1,
  'width': 0.3,
  'height': 0.3,
  'embedding': List<double>.generate(128, (index) => index == 0 ? 1 : 0),
};

class ReferenceMedia extends AssetEntity {
  ReferenceMedia(String id, {bool video = false})
    : super(id: id, typeInt: video ? 2 : 1, width: 1, height: 1, duration: 0);
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

class ReferenceSource extends SystemGallerySource {
  ReferenceSource(this.media);
  final List<AssetEntity> media;
  @override
  Future<int> count() async => media.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async => media.skip(number * size).take(size).toList();
}

class ReferenceGateway extends SystemGalleryGateway {
  final types = <RequestType>[];
  final media = [ReferenceMedia('photo'), ReferenceMedia('video', video: true)];
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async {
    types.add(type);
    return ReferenceSource(type == RequestType.image ? [media.first] : media);
  }

  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class ReferenceTransfer extends TransferController {
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

/// 合成原图与检测结果验证完整选脸流程，不读取私人照片或调用原生模型。
class ReferenceFamily extends FamilyController {
  ReferenceFamily(super.transfer, this.file);
  final File file;
  int analyses = 0, registrations = 0, scans = 0;
  bool readable = true;
  Completer<void>? detectionGate;
  Completer<void>? persistenceGate;
  List<Json> analysisFaces = [referenceFace('first'), referenceFace('second')];
  @override
  Future<void> initialize() async {
    ready = true;
    modelReady = true;
    changed();
  }

  @override
  Future<void> scan({bool requestPermission = true}) async {
    scans++;
  }

  @override
  Future<FamilyAsset> registerMedia(
    AssetEntity media, {
    bool persistRecord = true,
  }) async {
    registrations++;
    return assets.putIfAbsent(
      media.id,
      () => FamilyAsset({
        'id': media.id,
        '_localId': media.id,
        'filename': '合成照片.png',
        'kind': 'photo',
        'width': 1,
        'height': 1,
        'faces': <Json>[],
      }),
    );
  }

  @override
  Future<File?> fileFor(FamilyAsset asset) async => readable ? file : null;
  @override
  Future<void> analyze(FamilyAsset asset) async {
    analyses++;
    await detectionGate?.future;
    asset.data['faces'] = List<Json>.of(analysisFaces);
    changed();
  }

  @override
  Future<void> persist() async => await persistenceGate?.future;
}

void main() {
  late ReferenceTransfer transfer;
  late ReferenceFamily model;
  late BabyProfile baby;
  bool homeOwnsControllers = false;
  setUp(() async {
    homeOwnsControllers = false;
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-reference-',
    );
    final photo = File('${directory.path}/pixel.png');
    await photo.writeAsBytes(
      base64Decode(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
      ),
    );
    transfer = ReferenceTransfer();
    model = ReferenceFamily(transfer, photo);
    baby = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-02-01',
      'autoMatch': true,
      'referenceFaces': <Json>[],
    });
    model.babies[baby.id] = baby;
    model.activeBaby = baby.id;
  });
  tearDown(() {
    if (!homeOwnsControllers) {
      model.dispose();
      transfer.dispose();
    }
  });

  testWidgets('宝宝参考入口选照片后直接选脸，保存指定人脸并回到宝宝页', (tester) async {
    homeOwnsControllers = true;
    final gateway = ReferenceGateway();
    final gallery = SystemGalleryController(gateway: gateway);
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: transfer,
          familyController: model,
          galleryController: gallery,
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.text('宝宝').last);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('管理人脸参考'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('选择宝宝照片').last);
    await tester.pumpAndSettle();
    expect(find.text('点选一张宝宝照片'), findsOneWidget);
    expect(find.byType(SystemPhotoTile), findsOneWidget);
    expect(gateway.types.last, RequestType.image);
    expect(model.registrations, 0);
    expect(model.analyses, 0);
    expect(
      tester
          .widget<SystemPhotoTile>(find.byType(SystemPhotoTile).first)
          .onLongPress,
      isNull,
    );
    expect(find.text('传到电脑'), findsNothing);
    // 选择期间切换当前宝宝，不改变这次参考所属的档案。
    final other = BabyProfile({...baby.data, 'id': 'other', 'name': '小雨'});
    model.babies[other.id] = other;
    model.activeBaby = other.id;
    model.changed();
    await tester.tap(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    expect(find.byType(SystemMediaPreview), findsNothing);
    expect(find.text('请选择宝宝对应的脸'), findsOneWidget);
    expect(model.analyses, 1);
    expect(model.scans, 0);
    expect(
      tester
          .widget<FilledButton>(
            find.widgetWithText(FilledButton, '将选中人脸设为宝宝参考'),
          )
          .onPressed,
      isNull,
    );
    await tester.tap(find.text('换张照片'));
    await tester.pumpAndSettle();
    expect(find.text('点选一张宝宝照片'), findsOneWidget);
    expect(baby.references, isEmpty);
    await tester.tap(find.byType(SystemPhotoTile).first);
    await tester.pumpAndSettle();
    expect(model.analyses, 1);
    await tester.tap(find.text('人脸 2'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('将选中人脸设为宝宝参考'));
    await tester.pumpAndSettle();
    expect(baby.references.single, {'assetId': 'photo', 'faceId': 'second'});
    expect(other.references, isEmpty);
    expect(model.decision(baby.id, 'photo'), 'included');
    expect(find.byType(MediaPreview), findsNothing);
    expect(find.text('点选一张宝宝照片'), findsNothing);
    expect(gallery.type, RequestType.common);
    expect(gallery.assets.length, 2);
    expect(model.scans, 1);
    model.activeBaby = baby.id;
    model.scanning = true;
    model.changed();
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('管理人脸参考'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await tester.tap(find.text('选择宝宝照片').last);
    await tester.pumpAndSettle();
    expect(model.scanning, isFalse);
    expect(model.scans, 1);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(model.scans, 2);
    expect(baby.references.single['faceId'], 'second');
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  Future<void> preview(WidgetTester tester, FamilyAsset asset) async {
    model.assets[asset.id] = asset;
    await tester.pumpWidget(
      MaterialApp(
        home: MediaPreview(
          controller: model,
          asset: asset,
          baby: baby,
          selectReference: true,
        ),
      ),
    );
  }

  testWidgets('检测和保存阶段显示等待时间，完成后要求明确点选人脸', (tester) async {
    model.detectionGate = Completer<void>();
    model.persistenceGate = Completer<void>();
    await preview(tester, FamilyAsset({'id': 'photo'}));
    await tester.pump();
    await tester.runAsync(
      () async => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
    expect(find.textContaining('正在读取照片并检测人脸'), findsOneWidget);
    expect(find.textContaining('已等待 0 秒'), findsOneWidget);
    await tester.pump(const Duration(seconds: 3));
    expect(find.textContaining('已等待 3 秒'), findsOneWidget);
    expect(baby.references, isEmpty);
    model.detectionGate!.complete();
    await tester.pump();
    await tester.pump();
    expect(find.textContaining('正在保存检测结果'), findsOneWidget);
    expect(find.text('人脸 2'), findsNothing);
    expect(baby.references, isEmpty);
    model.persistenceGate!.complete();
    await tester.pumpAndSettle();
    expect(find.textContaining('已等待'), findsNothing);
    expect(find.text('人脸 2'), findsOneWidget);
    expect(baby.references, isEmpty);
  });

  testWidgets('检测等待期间退出预览停止计时，迟到结果不更新页面', (tester) async {
    model.detectionGate = Completer<void>();
    await preview(tester, FamilyAsset({'id': 'photo'}));
    await tester.pump();
    await tester.runAsync(
      () async => Future<void>.delayed(const Duration(milliseconds: 20)),
    );
    await tester.pump();
    expect(find.textContaining('正在读取照片并检测人脸'), findsOneWidget);
    await tester.pumpWidget(const SizedBox.shrink());
    await tester.pump(const Duration(seconds: 3));
    model.detectionGate!.complete();
    await tester.pump();
    expect(find.textContaining('已等待'), findsNothing);
    expect(baby.references, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('本机原文件不可读时仅提示本机权限，重新读取后进入选脸', (tester) async {
    model.readable = false;
    await preview(tester, FamilyAsset({'id': 'photo', '_localId': 'photo'}));
    await tester.pumpAndSettle();
    expect(find.text('取回原文件'), findsNothing);
    expect(find.text('本机原文件暂不可读，请检查相册权限，并确认照片仍在手机相册中。'), findsOneWidget);
    expect(model.analyses, 0);
    model.readable = true;
    await tester.tap(find.text('重新读取本机照片'));
    await tester.pumpAndSettle();
    expect(model.analyses, 1);
    expect(find.text('请选择宝宝对应的脸'), findsOneWidget);
    expect(baby.references, isEmpty);
    expect(tester.takeException(), isNull);
  });

  testWidgets('没有检测到人脸时可重试，成功后恢复选脸且不自动保存', (tester) async {
    model.analysisFaces = [];
    await preview(tester, FamilyAsset({'id': 'photo'}));
    await tester.pumpAndSettle();
    expect(find.text('未检测到可用人脸，请换一张清晰正面照片，或重新检测。'), findsOneWidget);
    expect(find.text('换张照片'), findsOneWidget);
    expect(baby.references, isEmpty);
    model.analysisFaces = [referenceFace('retry')];
    await tester.tap(find.text('重新检测人脸'));
    await tester.pumpAndSettle();
    expect(model.analyses, 2);
    expect(find.text('人脸 1'), findsOneWidget);
    expect(find.text('重新检测人脸'), findsNothing);
    expect(baby.references, isEmpty);
    expect(tester.takeException(), isNull);
  });

  for (final entry in <Object>[
    List<double>.filled(128, 0),
    List<double>.filled(128, double.nan),
    List<double>.filled(128, double.infinity),
    List<String>.filled(128, 'bad'),
    'bad',
  ].indexed) {
    final invalid = entry.$2;
    testWidgets('旧缓存特征无效时自动重新检测：${entry.$1}', (tester) async {
      await preview(
        tester,
        FamilyAsset({
          'id': 'photo',
          'faces': [
            referenceFace('valid'),
            {...referenceFace('invalid'), 'embedding': invalid},
          ],
        }),
      );
      await tester.pumpAndSettle();
      expect(model.analyses, 1);
      expect(find.text('人脸 2'), findsOneWidget);
      expect(model.assets['photo']!.faces.last['id'], 'second');
      expect(baby.references, isEmpty);
      expect(tester.takeException(), isNull);
    });
  }
}
