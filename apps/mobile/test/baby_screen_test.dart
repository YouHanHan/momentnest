import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 页面测试只操作合成记录，不读取系统相册或建立网络连接。
class BabyPageController extends FamilyController {
  BabyPageController(super.transfer);
  int scans = 0, pauses = 0;

  @override
  Future<void> scan({bool requestPermission = true}) async {
    scans++;
    scanning = true;
    progress = '已整理 2 项';
    changed();
  }

  @override
  void pauseScan() {
    pauses++;
    scanning = false;
    changed();
  }
}

BabyProfile profile(String id, String name, {bool references = false}) =>
    BabyProfile({
      'id': id,
      'name': name,
      'birthday': '2024-02-01',
      'autoMatch': true,
      'referenceFaces': references
          ? [
              {'assetId': 'photo', 'faceId': 'face'},
            ]
          : [],
    });

void main() {
  late TransferController transfer;
  late BabyPageController model;

  setUp(() {
    transfer = TransferController();
    model = BabyPageController(transfer)..ready = true;
  });

  tearDown(() {
    model.dispose();
    transfer.dispose();
  });

  Future<void> mount(WidgetTester tester, {VoidCallback? choose}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: ListenableBuilder(
            listenable: model,
            builder: (_, _) => BabyScreen(
              controller: model,
              onTransfer: (_) {},
              onChooseMedia: choose,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Future<void> tools(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('baby-tools')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
  }

  testWidgets('窄屏大字体空态可直接建档或去相册，无需先扫描', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    var chosen = 0;
    await mount(tester, choose: () => chosen++);
    expect(find.text('建立宝宝档案'), findsOneWidget);
    expect(find.text('整理手机照片和视频'), findsNothing);
    expect(find.text('同步电脑相册'), findsNothing);
    await tester.ensureVisible(find.text('选择宝宝照片'));
    await tester.tap(find.text('选择宝宝照片'));
    await tester.pumpAndSettle();
    expect(chosen, 1);
    expect(model.scans, 0);
    expect(tester.takeException(), isNull);
    await tools(tester);
    await tester.ensureVisible(find.text('媒体类型'));
    expect(find.text('媒体类型'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('主视图只显示成长与待确认，工具筛选和全部媒体仍可用', (tester) async {
    final baby = profile('baby', '小满', references: true);
    model.babies[baby.id] = baby;
    model.activeBaby = baby.id;
    for (final entry in {'photo': 'photo', 'video': 'video'}.entries) {
      model.assets[entry.key] = FamilyAsset({
        'id': entry.key,
        '_localId': entry.key,
        'kind': entry.value,
        if (entry.value == 'video') 'duration': 72,
        'date': '2024-03-01',
        'dateConfirmed': true,
      });
      model.decisions['baby:${entry.key}'] = {
        'babyId': 'baby',
        'assetId': entry.key,
        'state': entry.key == 'photo' ? 'included' : 'candidate',
        'origin': 'manual',
      };
    }
    await mount(tester);
    expect(find.text('小满'), findsOneWidget);
    expect(find.text('成长相册'), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-media-photo')), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-media-video')), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-edit-profile')), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-avatar')), findsOneWidget);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('baby-candidates')),
        matching: find.text('疑似 1'),
      ),
      findsOneWidget,
    );
    expect(find.text('全部已整理媒体'), findsNothing);
    expect(find.byType(InkWell), findsWidgets);
    await tester.tap(find.byKey(const ValueKey('baby-candidates')));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.videocam), findsOneWidget);
    expect(find.text('01:12'), findsOneWidget);
    await tools(tester);
    await tester.tap(find.text('全部已整理媒体'));
    await tester.pumpAndSettle();
    expect(find.text('全部已整理媒体'), findsOneWidget);
    await tools(tester);
    await tester.tap(find.text('媒体类型'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('照片'));
    await tester.pumpAndSettle();
    expect(find.text('仅照片'), findsOneWidget);
    expect(find.byIcon(Icons.videocam), findsNothing);
    await tester.tap(find.byTooltip('显示照片和视频'));
    await tester.pumpAndSettle();
    expect(find.byIcon(Icons.videocam), findsOneWidget);
    await tester.tap(find.byTooltip('返回成长相册'));
    await tester.pumpAndSettle();
    expect(find.text('成长相册'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('切换宝宝与参考工具可用，移除参考不移除媒体和人工归属', (tester) async {
    final baby = profile('first', '小满', references: true);
    model.babies.addAll({'first': baby, 'second': profile('second', '小雨')});
    model.activeBaby = 'first';
    model.assets['photo'] = FamilyAsset({'id': 'photo', '_localId': 'photo'});
    model.decisions['first:photo'] = {
      'babyId': 'first',
      'assetId': 'photo',
      'state': 'included',
      'origin': 'manual',
    };
    model.decisions['first:auto'] = {
      'babyId': 'first',
      'assetId': 'auto',
      'state': 'included',
      'origin': 'recognition',
    };
    var chosen = 0;
    await mount(tester, choose: () => chosen++);
    await tools(tester);
    await tester.tap(find.text('管理人脸参考'));
    await tester.pumpAndSettle();
    expect(find.text('已选 1 个本机参考。'), findsOneWidget);
    await tester.tap(find.text('移除参考关联'));
    await tester.pumpAndSettle();
    expect(baby.references, isEmpty);
    expect(model.assets, contains('photo'));
    expect(model.decision('first', 'photo'), 'included');
    expect(model.decisions, isNot(contains('first:auto')));
    await tools(tester);
    await tester.tap(find.text('管理人脸参考'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('选择宝宝照片').last);
    await tester.pumpAndSettle();
    expect(chosen, 1);
    expect(model.scans, 0);
    await tester.tap(find.text('小满'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('小雨'));
    await tester.pumpAndSettle();
    expect(model.activeBaby, 'second');
    expect(find.text('选择宝宝照片'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('同一宝宝编辑或同步出生日期后重新选择真实成长月份', (tester) async {
    final baby = profile('baby', '小满');
    model.babies['baby'] = baby;
    model.activeBaby = 'baby';
    model.assets['photo'] = FamilyAsset({
      'id': 'photo',
      '_localId': 'photo',
      'date': '2025-02-01',
      'dateConfirmed': true,
    });
    model.decisions['baby:photo'] = {
      'babyId': 'baby',
      'assetId': 'photo',
      'state': 'included',
      'origin': 'manual',
    };
    await mount(tester);
    await tester.tap(find.byKey(const ValueKey('growth-month-12')));
    await tester.pumpAndSettle();
    expect(find.text('2025-02-01 – 2025-02-28'), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-media-photo')), findsOneWidget);
    baby.data['birthday'] = '2024-12-01';
    model.changed();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('growth-month-2')), findsOneWidget);
    expect(find.byKey(const ValueKey('growth-month-12')), findsNothing);
    await tester.tap(find.byKey(const ValueKey('growth-month-2')));
    await tester.pumpAndSettle();
    expect(find.text('2025-02-01 – 2025-02-28'), findsOneWidget);
    expect(find.byKey(const ValueKey('baby-media-photo')), findsOneWidget);
    expect(find.text('这个成长月份还没有照片'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('整理与暂停仅操作本机相册，工具中不提供电脑同步', (tester) async {
    model.babies['baby'] = profile('baby', '小满');
    model.activeBaby = 'baby';
    await mount(tester);
    await tools(tester);
    await tester.ensureVisible(find.text('整理手机照片和视频'));
    await tester.tap(find.text('整理手机照片和视频'));
    await tester.pump();
    expect(model.scans, 1);
    await tester.pump(const Duration(seconds: 1));
    await tools(tester);
    expect(find.text('已整理 2 项'), findsOneWidget);
    await tester.ensureVisible(find.text('暂停整理'));
    await tester.tap(find.text('暂停整理'));
    await tester.pumpAndSettle();
    expect(model.pauses, 1);
    await tools(tester);
    expect(find.text('同步电脑相册'), findsNothing);
    expect(find.text('连接电脑后同步相册记录'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('编辑档案直接可见，保存失败保留草稿并可在当前弹窗修正', (tester) async {
    model.babies['baby'] = profile('baby', '小满');
    model.activeBaby = 'baby';
    await mount(tester);
    await tester.tap(find.byKey(const ValueKey('baby-edit-profile')));
    await tester.pumpAndSettle();
    await tester.enterText(find.byType(TextField), '');
    await tester.tap(find.text('保存档案'));
    await tester.pumpAndSettle();
    expect(find.text('编辑宝宝档案'), findsOneWidget);
    expect(find.textContaining('请填写宝宝姓名'), findsOneWidget);
    await tester.enterText(find.byType(TextField), '小雨');
    await tester.tap(find.text('保存档案'));
    await tester.pumpAndSettle();
    expect(find.text('编辑宝宝档案'), findsNothing);
    expect(model.babies['baby']!.name, '小雨');
    expect(model.scans, 0);
    expect(tester.takeException(), isNull);
  });
}
