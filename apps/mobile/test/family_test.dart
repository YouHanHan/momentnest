import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/receiver_api.dart';
import 'package:momentnest_mobile/backup_catalog.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:photo_manager/photo_manager.dart';

class FamilyMemoryStore extends LocalStore {
  final values = <String, Object?>{};
  @override
  Future<void> setPreference(String key, Object? value) async {
    values[key] = value;
  }
}

/// 本机宝宝操作一旦尝试访问电脑，测试立即失败。
class LocalTransfer extends TransferController {
  LocalTransfer() {
    connection = const ReceiverConnection(
      id: 'computer',
      name: '电脑',
      address: 'https://127.0.0.1:45831',
      fingerprint: 'test',
      deviceId: 'device',
    );
  }
  int networkAttempts = 0;
  @override
  Future<ReceiverApi> openApi(ReceiverConnection target) async {
    networkAttempts++;
    throw StateError('宝宝相册不应访问电脑。');
  }
}

class LocalFileAsset extends AssetEntity {
  LocalFileAsset(this.original)
    : super(id: 'phone-media', typeInt: 1, width: 1, height: 1);
  final File original;
  @override
  Future<File?> get originFile async => original;
}

class LocalFileTransfer extends LocalTransfer {
  LocalFileTransfer(this.original);
  final File original;
  int identityReads = 0;
  String hash = 'a'.padLeft(64, 'a');
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    identityReads++;
    final stat = await original.stat();
    return {
      'hash': hash,
      'size': stat.size,
      'path': original.path,
      'fileModified': stat.modified.millisecondsSinceEpoch,
    };
  }
}

class VersionTransfer extends TransferController {
  var revision = 0;
  @override
  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async =>
      {
        'hash': '${++revision}'.padLeft(64, '0'),
        'size': 10,
        'filename': 'edited.jpg',
        'kind': 'photo',
        'captureDate': '2024-02-01',
        'path': '/edited.jpg',
        'fileModified': revision,
      };
}

BabyProfile profile() => BabyProfile({
  'id': 'baby',
  'name': '小满',
  'birthday': '2024-01-31',
  'autoMatch': true,
  'referenceFaces': [
    {'assetId': 'reference', 'faceId': 'face'},
  ],
  'updatedAt': '2026-01-01T00:00:00.000Z',
});

void main() {
  test('旧电脑参考不能参与手机匹配或设为本机参考', () async {
    final transfer = LocalTransfer();
    final model = FamilyController(transfer);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final baby = profile();
    model.babies[baby.id] = baby;
    final face = {
      'id': 'face',
      'embedding': List.generate(128, (i) => i == 0 ? 1.0 : 0.0),
    };
    final remote = FamilyAsset({
      'id': 'reference',
      '_receiverId': 'computer',
      'faces': [face],
    });
    final phone = FamilyAsset({
      'id': 'phone',
      '_localId': 'phone',
      'faces': [face],
    });
    model.assets.addAll({remote.id: remote, phone.id: phone});
    expect(model.validReferenceCount(baby), 0);
    await model.rematchCached();
    expect(model.decision(baby.id, phone.id), isNull);
    await expectLater(
      model.reference(baby, remote, remote.faces.first),
      throwsStateError,
    );
    expect(transfer.networkAttempts, 0);
  });
  test('连接或切换电脑不会同步宝宝档案，旧同步接口不访问网络', () async {
    final transfer = LocalTransfer();
    final model = FamilyController(transfer)..ready = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final baby = profile();
    model.babies[baby.id] = baby;
    transfer.online = true;
    transfer.changed();
    await Future<void>.delayed(Duration.zero);
    await model.sync();
    expect(transfer.networkAttempts, 0);
    expect(model.babies[baby.id], same(baby));
    expect(model.assets, isEmpty);
    expect(transfer.observations, isEmpty);
    expect(transfer.tasks, isEmpty);
  });

  test('只展示当前手机媒体，旧电脑记录与失去授权的记录保留但不混入相册', () async {
    final transfer = LocalTransfer();
    final model = FamilyController(transfer)..ready = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    for (final id in ['phone', 'remote', 'missing']) {
      model.assets[id] = FamilyAsset({
        'id': id,
        if (id != 'remote') '_localId': id,
        if (id == 'remote') '_receiverId': 'computer',
        if (id == 'missing') '_authorized': false,
      });
      model.decisions['baby:$id'] = {'state': 'included', 'origin': 'manual'};
    }
    expect(model.localAssets.map((asset) => asset.id), ['phone']);
    expect(model.collection('baby').map((asset) => asset.id), ['phone']);
    expect(model.assets.length, 3);
    expect(model.decision('baby', 'remote'), 'included');
    expect(transfer.networkAttempts, 0);
  });

  test('系统媒体 ID 复用后，旧内容只保留历史归类并明确原文件不可用', () async {
    final transfer = VersionTransfer();
    final model = FamilyController(transfer);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    AssetEntity media(int version) => AssetEntity(
      id: 'same-media-id',
      typeInt: 1,
      width: 10,
      height: 10,
      modifiedDateSecond: version,
    );
    final old = await model.registerMedia(media(1));
    model.decisions['baby:${old.id}'] = {
      'assetId': old.id,
      'babyId': 'baby',
      'state': 'included',
      'origin': 'manual',
    };
    final current = await model.registerMedia(media(2));
    expect(current.id, isNot(old.id));
    expect(current.localId, 'same-media-id');
    expect(old.localId, isNull);
    expect(old.data['_authorized'], isFalse);
    expect(old.data['available'], isFalse);
    expect((old.data['locations'] as List).first['available'], isFalse);
    expect(model.decision('baby', old.id), 'included');
    expect(model.decision('baby', current.id), isNull);
  });

  test('月龄使用日历月处理月底、闰年和出生前日期，出生天数不受时区影响', () {
    expect(ageAt('2024-01-31', '2024-02-29'), '1 个月 0 天');
    expect(ageAt('2024-01-31', '2024-03-30'), '1 个月 30 天');
    expect(ageAt('2024-02-29', '2025-02-28'), '1 岁 0 天');
    expect(ageAt('2024-02-29', '2024-02-28'), '出生前');
    expect(dayCountAt('2024-02-29', '2024-03-01'), 2);
    expect(
      watermarkText(profile(), '2024-02-29', showDays: true),
      contains('出生第 30 天'),
    );
  });

  test('人物相似度使用完整128维特征；低匹配不写排除，手工决定不被识别覆盖', () async {
    final transfer = TransferController();
    final model = FamilyController(transfer);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final vector = List<double>.generate(128, (index) => index == 0 ? 1 : 0);
    final other = List<double>.generate(128, (index) => index == 1 ? 1 : 0);
    expect(cosineSimilarity(vector, vector), 1);
    expect(cosineSimilarity(vector, other), 0);
    expect(cosineSimilarity([double.nan], vector), -1);
    expect(recognitionState(0.65), 'included');
    expect(recognitionState(0.4), 'candidate');
    expect(recognitionState(0.399), isNull);
    model.babies['baby'] = profile();
    model.assets['reference'] = FamilyAsset({
      'id': 'reference',
      '_localId': 'reference',
      'faces': [
        {'id': 'face', 'embedding': vector},
      ],
    });
    final target = FamilyAsset({
      'id': 'target',
      '_localId': 'target',
      'faces': [
        {'id': 'other', 'embedding': vector},
      ],
    });
    model.classify(target);
    expect(model.decision('baby', 'target'), 'included');
    model.decisions['baby:target']!['origin'] = 'manual';
    model.decisions['baby:target']!['state'] = 'excluded';
    model.classify(target);
    expect(model.decision('baby', 'target'), 'excluded');
    final unknown = FamilyAsset({
      'id': 'unknown',
      '_localId': 'unknown',
      'faces': [
        {'id': 'other', 'embedding': other},
      ],
    });
    model.classify(unknown);
    expect(model.decision('baby', 'unknown'), isNull);
    model.classify(
      FamilyAsset({
        'id': 'automatic',
        '_localId': 'automatic',
        'faces': [
          {'id': 'face', 'embedding': vector},
        ],
      }),
    );
    expect(model.decision('baby', 'automatic'), 'included');
    await model.clearReferences(model.babies['baby']!);
    expect(model.decision('baby', 'automatic'), isNull);
    expect(model.decision('baby', 'target'), 'excluded');
    expect(transfer.tasks, isEmpty);
    expect(transfer.observations, isEmpty);
  });

  test('原文件只读取手机相册，旧电脑下载副本不会冒充本机媒体', () async {
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-local-source-',
    );
    final original = File('${directory.path}/retained.bin');
    await original.writeAsBytes([1, 2, 3, 4]);
    final transfer = LocalTransfer();
    final model = FamilyController(transfer, mediaResolver: (_) async => null);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final remote = FamilyAsset({
      'id': 'remote',
      '_receiverId': 'computer',
      '_download': original.path,
      'available': true,
    });
    expect(await model.fileFor(remote), isNull);
    expect(await original.exists(), isTrue);
    expect(transfer.networkAttempts, 0);
  });

  test('手机缓存路径或修改时间变化时校验内容，内容未变仍可预览', () async {
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-local-cache-',
    );
    final original = File('${directory.path}/source.bin');
    await original.writeAsBytes([1, 2, 3, 4]);
    final media = LocalFileAsset(original);
    final transfer = LocalFileTransfer(original);
    final model = FamilyController(transfer, mediaResolver: (_) async => media);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final asset = FamilyAsset({
      'id': contentAssetId(transfer.hash, 4),
      '_localId': media.id,
      '_version': photoVersion(media),
      'size': 4,
      '_path': 'old-cache-path',
      '_fileModified': 1,
    });
    expect((await model.fileFor(asset))?.path, original.path);
    expect(asset.localPath, original.path);
    expect(transfer.identityReads, 1);
    expect((await model.fileFor(asset))?.path, original.path);
    expect(transfer.identityReads, 1);
    expect(transfer.networkAttempts, 0);
  });

  test('手机媒体内容已改变时拒绝以新内容替代旧记录，也不向电脑下载', () async {
    final directory = await Directory.systemTemp.createTemp(
      'jinchuan-local-change-',
    );
    final original = File('${directory.path}/source.bin');
    await original.writeAsBytes([1, 2, 3, 4]);
    final media = LocalFileAsset(original);
    final transfer = LocalFileTransfer(original);
    final model = FamilyController(transfer, mediaResolver: (_) async => media);
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final asset = FamilyAsset({
      'id': contentAssetId('b'.padLeft(64, 'b'), 4),
      '_localId': media.id,
      '_version': photoVersion(media),
      'size': 4,
      '_path': 'old-cache-path',
      '_fileModified': 1,
    });
    expect(await model.fileFor(asset), isNull);
    expect(asset.localPath, 'old-cache-path');
    expect(await original.exists(), isTrue);
    expect(transfer.networkAttempts, 0);
  });

  test('本机开关自动整理只让识别加入退回候选，人工记录与图片保留', () async {
    final transfer = LocalTransfer();
    final model = FamilyController(transfer, store: FamilyMemoryStore())
      ..ready = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    model.babies['baby'] = profile();
    final vector = List<double>.generate(128, (index) => index == 0 ? 1 : 0);
    for (final id in [
      'reference',
      'automatic',
      'candidate',
      'manual-included',
      'manual-excluded',
    ]) {
      model.assets[id] = FamilyAsset({
        'id': id,
        '_localId': id,
        '_path': '/retained-$id.jpg',
        'faces': [
          {'id': 'face', 'embedding': vector},
        ],
      });
      if (id != 'reference') {
        model.decisions['baby:$id'] = {
          'id': 'baby-$id',
          'babyId': 'baby',
          'assetId': id,
          'state': id == 'candidate'
              ? 'candidate'
              : id == 'manual-excluded'
              ? 'excluded'
              : 'included',
          'origin': id.startsWith('manual-') ? 'manual' : 'recognition',
          'updatedAt': '2026-01-01T00:00:00.000Z',
        };
      }
    }
    final manualIncluded = Map<String, dynamic>.from(
      model.decisions['baby:manual-included']!,
    );
    final manualExcluded = Map<String, dynamic>.from(
      model.decisions['baby:manual-excluded']!,
    );
    await model.saveBaby(
      id: 'baby',
      name: '小满',
      birthday: '2024-01-31',
      autoMatch: false,
    );
    expect(model.decision('baby', 'automatic'), 'candidate');
    expect(model.decision('baby', 'candidate'), 'candidate');
    expect(model.decisions['baby:manual-included'], manualIncluded);
    expect(model.decisions['baby:manual-excluded'], manualExcluded);
    await model.saveBaby(
      id: 'baby',
      name: '小满',
      birthday: '2024-01-31',
      autoMatch: true,
    );
    expect(model.decision('baby', 'automatic'), 'included');
    await model.saveBaby(
      id: 'baby',
      name: '小满',
      birthday: '2024-01-31',
      autoMatch: false,
    );
    expect(transfer.networkAttempts, 0);
    expect(model.babies['baby']!.autoMatch, isFalse);
    expect(model.decision('baby', 'automatic'), 'candidate');
    expect(model.decisions['baby:manual-included'], manualIncluded);
    expect(model.decisions['baby:manual-excluded'], manualExcluded);
    expect(model.babies['baby']!.references, hasLength(1));
    expect(model.assets, hasLength(5));
    expect(model.assets['automatic']!.localPath, '/retained-automatic.jpg');
    expect(transfer.tasks, isEmpty);
  });
}
