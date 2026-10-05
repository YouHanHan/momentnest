import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 合成原文件和可控分析时序验证暂停与恢复，不访问个人相册。
class ResumeMedia extends AssetEntity {
  ResumeMedia(String id, this.original, {int version = 1})
    : super(
        id: id,
        typeInt: 1,
        width: 2,
        height: 2,
        title: '$id.jpg',
        modifiedDateSecond: version,
        createDateSecond: 1700000000,
      );
  final File original;
  @override
  Future<File?> get originFile async => original;
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

class ResumeSource extends SystemGallerySource {
  final items = <ResumeMedia>[];
  int countOffset = 0;
  @override
  Future<int> count() async => items.length + countOffset;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async => items.skip(number * size).take(size).toList();
}

class ResumeGateway extends SystemGalleryGateway {
  ResumeGateway(this.source);
  final ResumeSource source;
  PermissionState access = PermissionState.authorized;
  @override
  Future<PermissionState> permission({required bool request}) async => access;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async =>
      source;
  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class ResumeStore extends LocalStore {
  final values = <String, Object?>{};
  String? failedKey;
  bool closed = false;
  @override
  Future<void> open() async {}
  @override
  Future<dynamic> preference(String key) async => values[key];
  @override
  Future<void> setPreference(String key, Object? value) async {
    if (closed || key == failedKey) throw StateError('合成保存失败 $key');
    values[key] = jsonDecode(jsonEncode(value));
  }

  @override
  Future<void> close() async {
    closed = true;
  }
}

class ResumeTransfer extends TransferController {
  final inspected = <String>[];
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }

  @override
  Future<Json> inspectPhoto(AssetEntity media, {bool useCache = false}) async {
    inspected.add(media.id);
    final file = await media.originFile;
    final bytes = await file!.readAsBytes(), stat = await file.stat();
    return {
      'hash': sha256.convert(bytes).toString(),
      'size': stat.size,
      'filename': media.title,
      'kind': 'photo',
      'path': file.path,
      'fileModified': stat.modified.millisecondsSinceEpoch,
      'captureDate': '2026-06-01',
    };
  }
}

class AnalysisGate {
  final started = Completer<void>(), release = Completer<void>();
}

class ResumeFamily extends FamilyController {
  ResumeFamily(
    ResumeTransfer super.transfer,
    ResumeStore store,
    ResumeGateway gateway,
  ) : super(
        store: store,
        galleryGateway: gateway,
        mediaResolver: (id) async =>
            gateway.source.items.where((item) => item.id == id).firstOrNull,
      );
  final gates = <String, AnalysisGate>{};
  final analyzed = <String>[];
  final failures = <String>{};
  int active = 0, maximumActive = 0;
  @override
  Future<void> analyze(FamilyAsset asset) async {
    final id = asset.localId!;
    active++;
    if (active > maximumActive) maximumActive = active;
    analyzed.add(id);
    try {
      final gate = gates.remove(id);
      if (gate != null) {
        gate.started.complete();
        await gate.release.future;
      }
      if (failures.contains(id)) {
        asset.data['faceState'] = 'error';
        asset.data['faceError'] = '合成分析失败 $id';
        throw StateError('合成分析失败 $id');
      }
      asset.data['faces'] = [];
      asset.data['faceState'] = 'done';
      asset.data['_faceModel'] = 'sface-mobile-v1';
      asset.data.remove('faceError');
    } finally {
      active--;
    }
  }
}

/// 页面测试使用已知索引，避免真实文件 I/O 与测试虚拟时钟互相等待。
class PageScanFamily extends ResumeFamily {
  PageScanFamily(super.transfer, super.store, super.gateway);
  @override
  Future<FamilyAsset> registerMedia(
    AssetEntity media, {
    bool persistRecord = true,
  }) async => assets.putIfAbsent(
    media.id,
    () => FamilyAsset({
      'id': media.id,
      '_localId': media.id,
      'filename': media.title,
      'kind': 'photo',
      'faceState': 'pending',
    }),
  );
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
  late Directory directory;
  late ResumeSource source;
  late ResumeGateway gateway;
  late ResumeStore store;
  late ResumeTransfer transfer;
  late ResumeFamily family;
  var homeOwnsControllers = false;

  Future<ResumeMedia> media(String id) async {
    final file = File('${directory.path}/$id.jpg');
    await file.writeAsBytes(utf8.encode('synthetic-$id'));
    return ResumeMedia(id, file);
  }

  setUp(() async {
    homeOwnsControllers = false;
    directory = await Directory.systemTemp.createTemp('jinchuan-scan-resume-');
    messenger.setMockMethodCallHandler(
      directoryChannel,
      (_) async => directory.path,
    );
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'ready': true},
    );
    source = ResumeSource();
    for (var i = 0; i < 5; i++) {
      source.items.add(await media('$i'));
    }
    gateway = ResumeGateway(source);
    store = ResumeStore();
    transfer = ResumeTransfer();
    family = ResumeFamily(transfer, store, gateway);
    await family.initialize();
  });

  tearDown(() {
    if (!homeOwnsControllers) {
      family.dispose();
      transfer.dispose();
    }
    messenger.setMockMethodCallHandler(directoryChannel, null);
    messenger.setMockMethodCallHandler(FamilyController.channel, null);
  });

  Future<ResumeFamily> restore({bool legacy = false}) async {
    final restored = ResumeStore()..values.addAll(store.values);
    if (legacy) restored.values.remove('family-scan-progress');
    final secondTransfer = ResumeTransfer();
    final second = ResumeFamily(secondTransfer, restored, gateway);
    addTearDown(() {
      second.dispose();
      secondTransfer.dispose();
    });
    await second.initialize();
    return second;
  }

  test('暂停立即继续等待当前项，保留进度、不重复指纹或分析、不并行推理', () async {
    final gate = AnalysisGate();
    family.gates['2'] = gate;
    final first = family.scan();
    await gate.started.future;
    expect(family.scanProcessed, 2);
    family.pauseScan();
    final counts = <int>[];
    family.addListener(() => counts.add(family.scanProcessed));
    final resumed = family.scan();
    expect(family.scanProcessed, 2);
    await Future<void>.delayed(Duration.zero);
    expect(family.analyzed, ['0', '1', '2']);
    gate.release.complete();
    await Future.wait([first, resumed]);
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(transfer.inspected, ['0', '1', '2', '3', '4']);
    expect(family.maximumActive, 1);
    expect(counts.every((count) => count >= 2), isTrue);
    expect(family.scanProcessed, 5);
    expect(family.scanPaused, isFalse);
  });

  test('重开恢复已完成计数，继续只分析剩余媒体，旧版缓存也能接续', () async {
    final gate = AnalysisGate();
    family.gates['2'] = gate;
    final first = family.scan();
    await gate.started.future;
    family.pauseScan();
    gate.release.complete();
    await first;
    expect(family.scanProcessed, 3);
    expect((store.values['family-scan-progress'] as Map)['unfinished'], isTrue);
    for (final legacy in [false, true]) {
      final second = await restore(legacy: legacy);
      expect(second.scanProcessed, 3);
      final counts = <int>[];
      second.addListener(() => counts.add(second.scanProcessed));
      await second.scan();
      expect(second.analyzed, ['3', '4']);
      expect((second.transfer as ResumeTransfer).inspected, ['3', '4']);
      expect(counts.every((count) => count >= 3), isTrue);
      expect(second.scanProcessed, 5);
    }
  });

  test('缓存核对后仅新增及原文件变化项重算指纹，旧人工归属保留', () async {
    await family.scan();
    final old = family.localAssets.singleWhere((item) => item.localId == '1');
    family.decisions['baby:${old.id}'] = {
      'babyId': 'baby',
      'assetId': old.id,
      'state': 'included',
      'origin': 'manual',
    };
    await family.persist();
    final file = source.items[1].original;
    await file.writeAsBytes(utf8.encode('modified-content-1'));
    await file.setLastModified(DateTime.now().add(const Duration(seconds: 3)));
    source.items.add(await media('5'));
    final second = await restore();
    await second.scan();
    expect(second.analyzed.toSet(), {'1', '5'});
    expect((second.transfer as ResumeTransfer).inspected.toSet(), {'1', '5'});
    expect(second.assets[old.id]?.localId, isNull);
    expect(second.decision('baby', old.id), 'included');
    expect(second.scanProcessed, 6);
  });

  test('授权范围收窄不把旧计数冒充当前完成数，未授权记录仍保留', () async {
    await family.scan();
    final removed = family.localAssets.singleWhere(
      (item) => item.localId == '0',
    );
    source.items.removeWhere((item) => !['3', '4'].contains(item.id));
    source.items.add(await media('5'));
    gateway.access = PermissionState.limited;
    final second = await restore();
    await second.scan();
    expect(second.scanTotal, 3);
    expect(second.scanProcessed, 3);
    expect(second.scanCached, 2);
    expect(second.analyzed, ['5']);
    expect(second.assets[removed.id]?.data['_authorized'], isFalse);
    expect(second.assets.length, 6);
  });

  test('授权读取失败保留断点和已完成记录，重新授权后可继续', () async {
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final first = family.scan();
    await gate.started.future;
    family.pauseScan();
    gate.release.complete();
    await first;
    gateway.access = PermissionState.denied;
    await family.scan();
    expect(family.scanPaused, isTrue);
    expect(family.scanProcessed, 2);
    expect(family.notice, contains('请授权'));
    gateway.access = PermissionState.authorized;
    await family.scan();
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(family.scanProcessed, 5);
  });

  test('进入后台后回到前台自动接续，手工暂停不会因生命周期变化重启', () async {
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final first = family.scan();
    await gate.started.future;
    family.foreground(false);
    expect(family.scanPaused, isTrue);
    family.foreground(true);
    gate.release.complete();
    await first;
    await family.waitForScan();
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(family.scanProcessed, 5);
    final extra = await media('5');
    source.items.add(extra);
    final nextGate = AnalysisGate();
    family.gates['5'] = nextGate;
    final next = family.scan();
    await nextGate.started.future;
    family.pauseScan();
    nextGate.release.complete();
    await next;
    family.foreground(false);
    family.foreground(true);
    transfer.changed();
    await Future<void>.delayed(Duration.zero);
    expect(family.scanPaused, isTrue);
    expect(family.scanning, isFalse);
    expect(family.analyzed, ['0', '1', '2', '3', '4', '5']);
  });

  test('实际传输暂停识别并在传输结束后自动续接，浏览传输页不暂停', () async {
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final first = family.scan();
    await gate.started.future;
    transfer.running = true;
    transfer.changed();
    expect(family.scanning, isFalse);
    expect(family.scanPaused, isTrue);
    gate.release.complete();
    await first;
    expect(family.scanProcessed, 2);
    transfer.running = false;
    transfer.changed();
    await family.waitForScan();
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(family.scanProcessed, 5);
    expect(family.maximumActive, 1);
  });

  test('仅重试失败的断点保留范围，继续不重复已尝试项或扩成整库扫描', () async {
    family.failures.addAll(['0', '1', '2']);
    await family.scan();
    expect(family.scanFailures.length, 3);
    family.failures.clear();
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final retry = family.retryScanFailures();
    await gate.started.future;
    expect(family.scanProcessed, 1);
    family.pauseScan();
    final resumed = family.scan();
    gate.release.complete();
    await Future.wait([retry, resumed]);
    expect(family.analyzed, ['0', '1', '2', '3', '4', '0', '1', '2']);
    expect(family.scanFailures, isEmpty);
    expect(family.scanTotal, 3);
    expect(family.scanProcessed, 3);
    expect(family.maximumActive, 1);
  });

  test('重试失败的范围与计数可重开恢复，继续只处理未尝试失败项', () async {
    family.failures.addAll(['0', '1', '2']);
    await family.scan();
    family.failures.clear();
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final retry = family.retryScanFailures();
    await gate.started.future;
    family.pauseScan();
    gate.release.complete();
    await retry;
    final second = await restore();
    expect(second.scanProcessed, 2);
    expect(second.scanTotal, 3);
    await second.scan();
    expect(second.analyzed, ['2']);
    expect(second.scanProcessed, 3);
    expect(second.scanFailures, isEmpty);
  });

  test('检查点保存失败明确提示，恢复存储后继续复用结果', () async {
    store.failedKey = 'family-scan-progress';
    await family.scan();
    expect(family.scanPaused, isTrue);
    expect(family.notice, contains('整理进度保存失败'));
    expect(family.scanProcessed, 5);
    store.failedKey = null;
    await family.scan();
    expect(family.scanPaused, isFalse);
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(
      (store.values['family-scan-progress'] as Map)['unfinished'],
      isFalse,
    );
  });

  test('枚举期间媒体数量变化保留缓存，不把未完成范围标为成功', () async {
    await family.scan();
    source.countOffset = 1;
    await family.scan();
    expect(family.scanPaused, isTrue);
    expect(family.notice, contains('系统相册在整理中发生变化'));
    expect(family.localAssets.length, 5);
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    source.countOffset = 0;
    await family.scan();
    expect(family.scanPaused, isFalse);
    expect(family.scanProcessed, 5);
  });

  test('关闭前等待当前项与暂停检查点保存，存储不先于整理关闭', () async {
    final gate = AnalysisGate();
    family.gates['1'] = gate;
    final task = family.scan();
    await gate.started.future;
    family.pauseScan();
    family.dispose();
    transfer.dispose();
    homeOwnsControllers = true;
    expect(store.closed, isFalse);
    gate.release.complete();
    await task;
    await Future<void>.delayed(Duration.zero);
    expect(store.closed, isTrue);
    final checkpoint = store.values['family-scan-progress'] as Map;
    expect(checkpoint['processed'], 2);
    expect(checkpoint['unfinished'], isTrue);
  });

  testWidgets('切换相册、传输及子页面后整理仍处理后续媒体', (tester) async {
    family.dispose();
    family = PageScanFamily(transfer, ResumeStore(), gateway)
      ..ready = true
      ..modelReady = true;
    final firstGate = AnalysisGate(), lastGate = AnalysisGate();
    family.gates.addAll({'1': firstGate, '4': lastGate});
    final task = family.scan();
    final gallery = SystemGalleryController(gateway: gateway);
    homeOwnsControllers = true;
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: transfer,
          familyController: family,
          galleryController: gallery,
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(firstGate.started.isCompleted, isTrue);
    Finder tab(String label) => find.descendant(
      of: find.byType(NavigationBar),
      matching: find.text(label),
    );
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    await tester.tap(tab('传输'));
    await tester.pumpAndSettle();
    expect(family.scanning, isTrue);
    firstGate.release.complete();
    await tester.pumpAndSettle();
    expect(lastGate.started.isCompleted, isTrue);
    expect(family.scanProcessed, 4);
    await tester.tap(tab('相册'));
    await tester.pumpAndSettle();
    expect(family.scanning, isTrue);
    Navigator.of(tester.element(find.byType(HomeScreen))).push<void>(
      MaterialPageRoute(builder: (_) => const Scaffold(body: Text('其他页面'))),
    );
    await tester.pumpAndSettle();
    lastGate.release.complete();
    await tester.pumpAndSettle();
    await task;
    expect(family.scanProcessed, 5);
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(family.scanPaused, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });

  testWidgets('宝宝页自动启动后反复切页与返回沿用同一任务和完成计数', (tester) async {
    family.dispose();
    family = PageScanFamily(transfer, ResumeStore(), gateway)
      ..ready = true
      ..modelReady = true;
    family.assets['reference'] = FamilyAsset({
      'id': 'reference',
      '_localId': 'reference',
      'filename': '参考照片.jpg',
      'kind': 'photo',
      'faceState': 'done',
      'faces': [
        {
          'id': 'face',
          'embedding': List<double>.generate(128, (i) => i == 0 ? 1 : 0),
        },
      ],
    });
    family.babies['baby'] = BabyProfile({
      'id': 'baby',
      'name': '宝宝',
      'birthday': '2024-02-01',
      'autoMatch': true,
      'referenceFaces': [
        {'assetId': 'reference', 'faceId': 'face'},
      ],
    });
    family.activeBaby = 'baby';
    final firstGate = AnalysisGate(), lastGate = AnalysisGate();
    family.gates.addAll({'1': firstGate, '4': lastGate});
    homeOwnsControllers = true;
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: transfer,
          familyController: family,
          galleryController: SystemGalleryController(gateway: gateway),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(family.analyzed, isEmpty);
    Finder tab(String label) => find.descendant(
      of: find.byType(NavigationBar),
      matching: find.text(label),
    );
    await tester.tap(tab('宝宝'));
    await tester.pumpAndSettle();
    expect(firstGate.started.isCompleted, isTrue);
    expect(family.scanProcessed, 1);
    final task = family.waitForScan();

    for (final destination in ['相册', '传输', '宝宝', '相册', '宝宝']) {
      await tester.tap(tab(destination));
      await tester.pumpAndSettle();
      expect(family.scanning, isTrue);
      expect(family.scanPaused, isFalse);
      expect(family.scanProcessed, 1);
      expect(identical(family.waitForScan(), task), isTrue);
      expect(family.analyzed, ['0', '1']);
    }
    Navigator.of(tester.element(find.byType(HomeScreen))).push<void>(
      MaterialPageRoute(builder: (_) => const Scaffold(body: Text('普通子页面'))),
    );
    await tester.pumpAndSettle();
    firstGate.release.complete();
    await tester.pumpAndSettle();
    expect(lastGate.started.isCompleted, isTrue);
    expect(family.scanProcessed, 4);
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('普通子页面'), findsNothing);
    expect(family.scanning, isTrue);
    expect(family.scanProcessed, 4);
    expect(identical(family.waitForScan(), task), isTrue);
    lastGate.release.complete();
    await tester.pumpAndSettle();
    await task;
    expect(family.analyzed, ['0', '1', '2', '3', '4']);
    expect(family.maximumActive, 1);
    expect(family.scanProcessed, 5);
    expect(family.scanPaused, isFalse);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
  });
}
