import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_localizations/flutter_localizations.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:photo_manager/photo_manager.dart';

class TestController extends TransferController {
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }

  @override
  Future<void> setMode(String value) async {
    mode = value;
    changed();
  }

  @override
  Future<void> loadPhotos({bool requestPermission = true}) async {
    changed();
  }
}

class TestGalleryController extends SystemGalleryController {
  @override
  Future<List<int>> loadYears({RequestType? mediaType}) async => [2024, 2023];

  @override
  Future<void> initialize() async {
    ready = true;
    permission = PermissionState.denied;
    notifyListeners();
  }
}

Finder navigationTab(String label) =>
    find.descendant(of: find.byType(NavigationBar), matching: find.text(label));

class TestFamilyController extends FamilyController {
  TestFamilyController(super.transfer);
  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

void main() {
  testWidgets('首页返回先确认，取消和返回关闭弹窗，只有明确退出才关闭应用', (tester) async {
    var exits = 0;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (call) async {
          if (call.method == 'SystemNavigator.pop') exits++;
          return null;
        });
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );
    final model = TestController();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: model,
          familyController: TestFamilyController(model),
          galleryController: TestGalleryController(),
        ),
      ),
    );
    await tester.pumpAndSettle();

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('退出拾光匣？'), findsOneWidget);
    expect(exits, 0);
    expect(
      tester
          .widget<TextButton>(find.widgetWithText(TextButton, '取消'))
          .autofocus,
      isTrue,
    );
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsNothing);
    expect(exits, 0);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(exits, 0);

    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    await tester.tap(find.text('退出'));
    await tester.pumpAndSettle();
    expect(exits, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('子页面返回仅关闭当前页面，不触发首页退出确认', (tester) async {
    final model = TestController();
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: model,
          familyController: TestFamilyController(model),
          galleryController: TestGalleryController(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    Navigator.of(tester.element(find.byType(HomeScreen))).push<void>(
      MaterialPageRoute(builder: (_) => const Scaffold(body: Text('照片预览页面'))),
    );
    await tester.pumpAndSettle();
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.text('照片预览页面'), findsNothing);
    expect(find.text('退出拾光匣？'), findsNothing);
    expect(find.byType(HomeScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('月份统计和仅上传入口在窄屏大字体下可读，待核对独立显示', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final model = TestController();
    model.selectedMonth = '2024-02';
    model.catalogComplete = true;
    model.photos = List.generate(
      3,
      (index) => AssetEntity(
        id: '$index',
        typeInt: 1,
        width: 20,
        height: 20,
        createDateSecond: DateTime(2024, 2, 5).millisecondsSinceEpoch ~/ 1000,
        modifiedDateSecond: 1,
      ),
    );
    model.observations = {
      for (var i = 0; i < 2; i++)
        '$i': {
          'version': model.version(model.photos[i]),
          'status': i == 0 ? 'pending' : 'exists',
        },
    };
    model.monthProgress.reset(3);
    model.monthProgress.record(model.photos[0], 'pending');
    model.monthProgress.record(model.photos[1], 'exists');
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: model,
          familyController: TestFamilyController(model),
          galleryController: TestGalleryController(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('已备份 1'), findsNothing);
    expect(find.text('尚未连接电脑'), findsNothing);
    await tester.tap(navigationTab('传输'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('传输操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('按月备份'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.byKey(const ValueKey('choose-scan-month')));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('choose-scan-month')));
    await tester.pumpAndSettle();
    expect(find.text('选择扫描月份'), findsOneWidget);
    await tester.ensureVisible(find.text('12 月'));
    await tester.tap(find.text('12 月'));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    expect(find.text('已备份 1'), findsOneWidget);
    expect(find.text('未备份 1'), findsOneWidget);
    expect(find.text('待核对 1'), findsOneWidget);
    await tester.ensureVisible(
      find.byKey(const ValueKey('upload-month-unbacked')),
    );
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    expect(find.text('1 项待核对媒体不包含在本次上传中。'), findsOneWidget);
    await tester.ensureVisible(find.text('只看未备份'));
    await tester.tap(find.text('只看未备份'));
    await tester.pumpAndSettle();
    expect(model.visiblePhotos.length, 1);
    expect(find.text('本月显示 1 项 · 已选 0 项'), findsOneWidget);
    await tester.ensureVisible(find.text('全选本月筛选结果'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('全选本月筛选结果'));
    await tester.pumpAndSettle();
    expect(model.selected, {'0'});
    expect(find.text('下一批'), findsNothing);
    expect(find.text('上一批'), findsNothing);
  });

  testWidgets('窄屏、大字体下可浏览空状态、配置日期并进入真实配对入口', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final model = TestController();
    await tester.pumpWidget(
      MaterialApp(
        locale: const Locale('zh', 'CN'),
        supportedLocales: const [Locale('zh', 'CN')],
        localizationsDelegates: GlobalMaterialLocalizations.delegates,
        home: HomeScreen(
          controller: model,
          familyController: TestFamilyController(model),
          galleryController: TestGalleryController(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text('允许访问相册'), findsOneWidget);
    expect(find.text('尚未连接电脑'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.tap(navigationTab('传输'));
    await tester.pumpAndSettle();
    await tester.scrollUntilVisible(find.text('还没有传输任务'), 200);
    expect(find.text('还没有传输任务'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.byTooltip('传输操作'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('设置'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('指定日期'));
    await tester.pumpAndSettle();
    final dateButton = find.byType(OutlinedButton);
    await tester.ensureVisible(dateButton);
    await tester.tap(dateButton);
    await tester.pumpAndSettle();
    expect(find.byType(DatePickerDialog), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(find.text('取消'));
    await tester.pumpAndSettle();
    await tester.tap(find.byTooltip('返回'));
    await tester.pumpAndSettle();
    await tester.tap(navigationTab('宝宝'));
    await tester.pumpAndSettle();
    expect(find.text('建立宝宝档案'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await tester.tap(navigationTab('传输'));
    await tester.pumpAndSettle();
    await tester.ensureVisible(find.text('连接家里的电脑'));
    await tester.tap(find.text('连接家里的电脑'));
    await tester.pumpAndSettle();
    expect(find.text('使用配对信息连接'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
