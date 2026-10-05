import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

// 大图库检查只使用合成媒体，不读取个人相册或连接电脑。
class SyntheticMedia extends AssetEntity {
  SyntheticMedia(int index)
    : super(id: '$index', typeInt: 1, width: 40, height: 40);
  final counts = [0, 0];
  @override
  Future<Uint8List?> thumbnailDataWithSize(
    ThumbnailSize size, {
    ThumbnailFormat format = ThumbnailFormat.jpeg,
    int quality = 100,
    PMProgressHandler? progressHandler,
    PMCancelToken? cancelToken,
    int frame = 0,
  }) async {
    counts[0]++;
    return null;
  }

  @override
  Future<File?> get originFile async {
    counts[1]++;
    throw StateError('缩略图浏览不能读取原文件');
  }
}

class SyntheticSource extends SystemGallerySource {
  SyntheticSource(this.media);
  final List<SyntheticMedia> media;
  @override
  Future<int> count() async => media.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async => media.skip(number * size).take(size).toList();
}

class SyntheticGateway extends SystemGalleryGateway {
  SyntheticGateway(this.media);
  final List<SyntheticMedia> media;
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async =>
      SyntheticSource(media);
  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class MemoryStore extends LocalStore {
  final values = <String, Object?>{};
  @override
  Future<void> open() async {}
  @override
  Future<dynamic> preference(String key) async => values[key];
  @override
  Future<void> setPreference(String key, Object? value) async =>
      values[key] = value;
  @override
  Future<void> close() async {}
}

class SyntheticTransfer extends TransferController {
  int inspected = 0;
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    inspected++;
    return {
      'hash': int.parse(asset.id).toRadixString(16).padLeft(64, '0'),
      'size': 1024,
      'filename': '${asset.id}.jpg',
      'kind': 'photo',
      'path': '/synthetic/${asset.id}.jpg',
      'fileModified': 1,
      'captureDate': '2024-03-01',
    };
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
  late FamilyController model;
  late SyntheticTransfer transfer;
  late List<SyntheticMedia> media;

  setUp(() async {
    media = List.generate(10000, SyntheticMedia.new);
    transfer = SyntheticTransfer();
    model = FamilyController(
      transfer,
      store: MemoryStore(),
      galleryGateway: SyntheticGateway(media),
      mediaResolver: (id) async => media[int.parse(id)],
    );
    final directory = await Directory.systemTemp.createTemp('momentnest-load-');
    messenger.setMockMethodCallHandler(
      directoryChannel,
      (_) async => directory.path,
    );
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'ready': false},
    );
    await model.initialize();
  });

  tearDown(() {
    model.dispose();
    transfer.dispose();
    messenger.setMockMethodCallHandler(directoryChannel, null);
    messenger.setMockMethodCallHandler(FamilyController.channel, null);
  });

  test('一万项索引扫描不预生成缩略图，进度通知合并且完成立即可见', () async {
    var notifications = 0;
    model.addListener(() => notifications++);
    await model.scan();
    expect(model.assets.length, 10000);
    expect(model.scanProcessed, 10000);
    expect(model.scanning, isFalse);
    expect(model.scanFailures, isEmpty);
    expect(transfer.inspected, 10000);
    expect(media.every((item) => item.counts[0] == 0), isTrue);
    expect(notifications, lessThan(100));
  });

  testWidgets('宝宝首屏只请求可见缩略图，翻看照片不读取原文件指纹', (tester) async {
    model.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '小满',
      'birthday': '2024-01-01',
      'autoMatch': false,
      'referenceFaces': [],
    });
    model.activeBaby = 'baby';
    for (final item in media) {
      model.assets[item.id] = FamilyAsset({
        'id': item.id,
        '_localId': item.id,
        'kind': 'photo',
        'date': '2024-03-01',
        'dateSource': 'capture',
        'dateConfirmed': true,
      });
      model.decisions['baby:${item.id}'] = {
        'babyId': 'baby',
        'assetId': item.id,
        'origin': 'manual',
        'state': 'included',
      };
    }
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BabyScreen(controller: model, onTransfer: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final requested = media.where((item) => item.counts[0] > 0).length;
    expect(requested, greaterThan(0));
    expect(requested, lessThan(100));
    model.changed();
    await tester.pumpAndSettle();
    expect(media.every((item) => item.counts[0] <= 1), isTrue);
    expect(media.every((item) => item.counts[1] == 0), isTrue);
    expect(transfer.inspected, 0);
    expect(tester.takeException(), isNull);
  });
}
