import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 初始化测试只使用合成偏好和临时目录，不读取个人媒体或连接电脑。
class InitializationStore extends LocalStore {
  final values = <String, Object?>{};
  String? failedKey;
  bool failOpen = false;
  int opens = 0, writes = 0;
  Completer<void>? opening;

  @override
  Future<void> open() async {
    opens++;
    if (failOpen) throw StateError('本地存储暂不可用');
    await opening?.future;
  }

  @override
  Future<dynamic> preference(String key) async {
    if (key == failedKey) throw const FormatException('合成记录读取失败');
    return values[key];
  }

  @override
  Future<void> setPreference(String key, Object? value) async {
    writes++;
    values[key] = value;
  }

  @override
  Future<void> close() async {}
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const directoryChannel = MethodChannel('plugins.flutter.io/path_provider');
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late Directory directory;
  late InitializationStore store;
  late TransferController transfer;
  late FamilyController model;
  int directoryRequests = 0;
  bool failDirectory = false, failModel = false;

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('jinchuan-initialize-');
    store = InitializationStore();
    transfer = TransferController();
    model = FamilyController(transfer, store: store);
    directoryRequests = 0;
    failDirectory = false;
    failModel = false;
    messenger.setMockMethodCallHandler(directoryChannel, (_) async {
      directoryRequests++;
      if (failDirectory) {
        throw PlatformException(code: 'DIRECTORY', message: '目录暂不可用');
      }
      return directory.path;
    });
    messenger.setMockMethodCallHandler(FamilyController.channel, (call) async {
      if (call.method == 'ready') {
        if (failModel) {
          throw PlatformException(code: 'MODEL', message: '合成模型不可用');
        }
        return {'ready': true};
      }
      throw MissingPluginException(call.method);
    });
  });

  tearDown(() {
    model.dispose();
    transfer.dispose();
    messenger.setMockMethodCallHandler(directoryChannel, null);
    messenger.setMockMethodCallHandler(FamilyController.channel, null);
  });

  void existingRecords() {
    store.values['family-babies'] = [
      {
        'id': 'baby',
        'name': '小满',
        'birthday': '2025-08-05',
        'referenceFaces': [],
      },
    ];
    store.values['family-assets'] = [
      {'id': 'photo', 'filename': 'synthetic.jpg'},
    ];
    store.values['family-decisions'] = [
      {
        'babyId': 'baby',
        'assetId': 'photo',
        'state': 'included',
        'origin': 'manual',
      },
    ];
    store.values['family-growth-watermark:baby'] = false;
  }

  test('首次启动可读取空相册，不写入模拟档案或媒体', () async {
    await model.initialize();
    expect(model.ready, isTrue);
    expect(model.notice, isEmpty);
    expect(model.modelReady, isTrue);
    expect(directoryRequests, 1);
    expect(await Directory('${directory.path}/family').exists(), isTrue);
    expect(store.writes, 0);
  });

  test('升级恢复保留宝宝、人工归属和水印偏好，不重写本地记录', () async {
    existingRecords();
    await model.initialize();
    expect(model.ready, isTrue);
    expect(model.activeBaby, 'baby');
    expect(model.babies['baby']!.name, '小满');
    expect(model.decision('baby', 'photo'), 'included');
    expect(model.growthWatermarkVisible('baby'), isFalse);
    expect(store.writes, 0);
  });

  test('读取中途失败不展示半份档案，重试后完整恢复且不清空旧记录', () async {
    existingRecords();
    store.failedKey = 'family-dates';
    await model.initialize();
    expect(model.ready, isFalse);
    expect(model.babies, isEmpty);
    expect(model.notice, contains('读取失败'));
    store.failedKey = null;
    await model.initialize();
    expect(model.ready, isTrue);
    expect(model.notice, isEmpty);
    expect(model.babies.length, 1);
    expect(model.decision('baby', 'photo'), 'included');
    expect(store.writes, 0);
  });

  test('存储或目录失败后可重试，已成功初始化不重复加载', () async {
    store.failOpen = true;
    await model.initialize();
    expect(model.ready, isFalse);
    store.failOpen = false;
    failDirectory = true;
    await model.initialize();
    expect(model.ready, isFalse);
    expect(model.notice, contains('目录暂不可用'));
    failDirectory = false;
    await model.initialize();
    expect(model.ready, isTrue);
    expect(model.notice, isEmpty);
    await model.initialize();
    expect(store.opens, 3);
    expect(store.writes, 0);
  });

  test('并发读取只执行一次，模型不可用不阻止档案和照片恢复', () async {
    existingRecords();
    store.opening = Completer<void>();
    final first = model.initialize();
    final second = model.initialize();
    failModel = true;
    store.opening!.complete();
    await Future.wait([first, second]);
    expect(store.opens, 1);
    expect(model.ready, isTrue);
    expect(model.notice, isEmpty);
    expect(model.modelReady, isFalse);
    expect(model.modelError, contains('模型不可用'));
    expect(model.decision('baby', 'photo'), 'included');
  });

  testWidgets('读取失败显示重试，读取成功前不提供建档入口', (tester) async {
    store.failOpen = true;
    await tester.runAsync(model.initialize);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: model,
            builder: (_, _) =>
                BabyScreen(controller: model, onTransfer: (_) {}),
          ),
        ),
      ),
    );
    expect(find.text('重新读取'), findsOneWidget);
    expect(find.text('建立宝宝档案'), findsNothing);
    expect(find.textContaining('本地存储暂不可用'), findsOneWidget);
    store.failOpen = false;
    await tester.runAsync(() async {
      await tester.tap(find.text('重新读取'));
      await Future<void>.delayed(const Duration(milliseconds: 30));
    });
    await tester.pumpAndSettle();
    expect(model.ready, isTrue);
    expect(find.text('重新读取'), findsNothing);
    expect(find.text('建立宝宝档案'), findsOneWidget);
    expect(store.writes, 0);
  });
}
