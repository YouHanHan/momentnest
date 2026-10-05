import 'dart:io';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

class SourceAsset extends AssetEntity {
  SourceAsset(this.source, {bool video = false})
    : super(id: 'source', typeInt: video ? 2 : 1, width: 10, height: 10);
  final File source;
  @override
  Future<File?> get originFile async => source;
  @override
  Future<String> get titleAsync async => 'source.jpg';
}

class IdentityStore extends LocalStore {
  Json? identity;
  @override
  Future<Json?> cachedIdentity(String asset, String version) async => identity;
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const media = MethodChannel('dev.jinchuan/media');
  late Directory directory;
  late File file;
  late IdentityStore store;
  late TransferController model;
  final calls = <MethodCall>[];
  String? captureDate, creationDate;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('jinchuan-source-date-');
    file = await File('${directory.path}/source.jpg').writeAsBytes([1, 2, 3]);
    store = IdentityStore();
    model = TransferController(store: store);
    captureDate = null;
    creationDate = '2024-02-29';
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(media, (call) async {
          calls.add(call);
          return call.method == 'captureDate' ? captureDate : creationDate;
        });
  });
  tearDown(() async {
    model.dispose();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(media, null);
    await directory.delete(recursive: true);
  });

  test('截图没有拍摄日时读取手机创建日，不采用缓存文件的创建日', () async {
    final identity = await model.inspectPhoto(SourceAsset(file));
    expect(identity['captureDate'], isNull);
    expect(identity['creationDate'], '2024-02-29');
    expect(calls.map((call) => call.method), ['captureDate', 'creationDate']);
    expect(calls.last.arguments, {'assetId': 'source', 'kind': 'photo'});
  });

  test('照片和视频保留拍摄日与手机创建日各自的来源', () async {
    captureDate = '2024-01-31';
    for (final video in [false, true]) {
      final identity = await model.inspectPhoto(
        SourceAsset(file, video: video),
      );
      expect(identity['captureDate'], '2024-01-31');
      expect(identity['creationDate'], '2024-02-29');
      expect(calls.last.arguments['kind'], video ? 'video' : 'photo');
    }
  });

  test('旧指纹缓存补齐手机创建日，复用哈希而不把创建日冒充拍摄日', () async {
    final stat = await file.stat();
    store.identity = {
      'hash': 'cached-hash',
      'size': stat.size,
      'path': file.path,
      'fileModified': stat.modified.millisecondsSinceEpoch,
      'captureDate': null,
    };
    final identity = await model.inspectPhoto(
      SourceAsset(file),
      useCache: true,
    );
    expect(identity['hash'], 'cached-hash');
    expect(identity['captureDate'], isNull);
    expect(identity['creationDate'], '2024-02-29');
    expect(calls.single.method, 'creationDate');
  });

  test('手机没有记录日期时保留空值供批次规则处理', () async {
    creationDate = null;
    final identity = await model.inspectPhoto(SourceAsset(file));
    expect(identity['captureDate'], isNull);
    expect(identity['creationDate'], isNull);
  });
}
