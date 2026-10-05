import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/gallery_backup_controller.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/system_gallery_screen.dart';
import 'package:momentnest_mobile/models.dart';
import 'backup_test.dart' as fixtures;
import 'system_gallery_screen_test.dart' as ui;

class Source extends SystemGallerySource {
  final items = [
    for (final id in ['a', 'b', 'c']) ui.GalleryAsset(id),
  ];
  final pages = <int>[];
  @override
  Future<int> count() async => items.length;
  @override
  Future<List<AssetEntity>> page({
    required int number,
    required int size,
  }) async {
    pages.add(number);
    final start = number * size;
    return start >= items.length
        ? []
        : items.sublist(start, (start + size).clamp(0, items.length));
  }
}

class Gateway extends SystemGalleryGateway {
  final source = Source();
  @override
  Future<PermissionState> permission({required bool request}) async =>
      PermissionState.authorized;
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async =>
      source;
  @override
  Future<void> manageAccess({required bool limited}) async {}
}

class Transfer extends fixtures.CheckController {
  Transfer(super.respond) {
    currentLibraryAvailable = true;
    setMonthActive(false);
  }
  @override
  Future<void> reconnect() async {}
}

Future<void> settle() async {
  for (var i = 0; i < 5; i++) {
    await Future<void>.delayed(Duration.zero);
  }
}

void main() {
  test('普通打开只恢复首屏状态；筛选会读到后续页面，且不计算原图指纹', () async {
    final gateway = Gateway(),
        transfer = Transfer((request) async => fixtures.result(request));
    final gallery = SystemGalleryController(gateway: gateway, pageSize: 1);
    final backup = GalleryBackupController(gallery, transfer);
    addTearDown(() {
      backup.dispose();
      gallery.dispose();
      transfer.dispose();
    });
    await transfer.store.observe(
      'b',
      'computer',
      'first',
      transfer.version(gateway.source.items[1]),
      {'status': 'missing'},
    );
    await gallery.initialize();
    await settle();
    expect(gallery.assets.length, 1);
    expect(gateway.source.pages, [0]);
    await backup.setFilter('missing');
    expect(backup.visible.map((asset) => asset.id), ['b']);
    expect(backup.idsFor('missing'), {'b'});
    expect(gallery.assets.length, 3);
    expect(transfer.inspected, isEmpty);
  });

  test('显式核对覆盖未加载照片；目标切换不会串用旧状态', () async {
    final transfer = Transfer((request) async {
      final id = ((request['assets'] as List).single as Json)['hash'];
      return {
        'results': [
          {
            'hash': id,
            'size': 12,
            'complete': true,
            'matches': [],
            if (id == 'a') 'receipt': {'id': 'saved'},
            if (id == 'b') ...{
              'previousReceipt': {'id': 'old'},
              'receiptState': 'missing',
            },
            if (id == 'c') 'receiptState': 'none',
          },
        ],
        'roots': [],
      };
    });
    final gateway = Gateway(),
        gallery = SystemGalleryController(gateway: Gateway(), pageSize: 1);
    final backup = GalleryBackupController(gallery, transfer);
    addTearDown(() {
      backup.dispose();
      gallery.dispose();
      transfer.dispose();
    });
    await gallery.initialize();
    await settle();
    await backup.check();
    expect(transfer.inspected, ['a', 'b', 'c']);
    expect(backup.state(gallery.assets.first), 'uploaded');
    await backup.setFilter('missing');
    expect(backup.visible.map((asset) => asset.id), ['b']);
    transfer.libraryId = 'second';
    transfer.changed();
    await settle();
    expect(backup.state(gateway.source.items[0]), 'unknown');
    expect(backup.filter, 'all');
  });

  test('核对中切换目标丢弃迟到结果，旧成功证据保留但不归新目标', () async {
    final entered = Completer<Json>(), response = Completer<Json>();
    final transfer = Transfer((request) {
      if (!entered.isCompleted) entered.complete(request);
      return response.future;
    });
    final gallery = SystemGalleryController(gateway: Gateway(), pageSize: 1);
    final backup = GalleryBackupController(gallery, transfer);
    addTearDown(() {
      backup.dispose();
      gallery.dispose();
      transfer.dispose();
    });
    await gallery.initialize();
    await settle();
    final job = backup.check();
    final request = await entered.future;
    transfer.applyReceiverSnapshot({
      'currentLibraryId': 'second',
      'currentLibraryAvailable': true,
      'libraries': [
        {'id': 'second'},
      ],
    });
    transfer.changed();
    response.complete(fixtures.result(request));
    await job;
    await settle();
    expect(backup.state(gallery.assets.first), 'unknown');
    expect(
      (transfer.store as fixtures.MemoryStore).saved['computer:first'],
      isNull,
    );
  });

  testWidgets('相册展示三种状态及核对入口，需补传提供明确的批量补传', (tester) async {
    tester.view.physicalSize = const Size(360, 740);
    tester.view.devicePixelRatio = 1;
    addTearDown(() {
      tester.view.resetPhysicalSize();
      tester.view.resetDevicePixelRatio();
    });
    final transfer = Transfer((request) async => fixtures.result(request));
    final gateway = Gateway(),
        gallery = SystemGalleryController(gateway: Gateway(), pageSize: 1);
    final backup = GalleryBackupController(gallery, transfer);
    addTearDown(() {
      backup.dispose();
      gallery.dispose();
      transfer.dispose();
    });
    await transfer.store.observe(
      'a',
      'computer',
      'first',
      transfer.version(gateway.source.items[0]),
      {
        'status': 'missing',
        'receiptState': 'missing',
        'previousReceipt': {'relativePath': 'old/photo.jpg'},
      },
    );
    await gallery.initialize();
    Set<String>? sent;
    bool? restoring;
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SystemGalleryScreen(
            controller: gallery,
            backup: backup,
            onUpload: (_) async => true,
            onOrganize: (_) async {},
            onBackupUpload: (ids, restore) async {
              sent = ids;
              restoring = restore;
              return true;
            },
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('核对电脑'), findsOneWidget);
    expect(find.text('未传入'), findsOneWidget);
    expect(find.text('待核对'), findsNothing);
    await tester.tap(
      find.byKey(const ValueKey('gallery-backup-filter-missing')),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('gallery-upload-backup-filter')),
    );
    await tester.pumpAndSettle();
    expect(sent, {'a'});
    expect(restoring, isTrue);
    expect(tester.takeException(), isNull);
  });
}
