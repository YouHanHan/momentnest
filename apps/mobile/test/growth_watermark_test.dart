import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/baby_screen.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/family_models.dart';
import 'package:momentnest_mobile/growth_watermark_screen.dart';
import 'package:momentnest_mobile/local_store.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

class WatermarkMemoryStore extends LocalStore {
  @override
  Future<void> setPreference(String key, Object? value) async {}
}

class WatermarkFamily extends FamilyController {
  WatermarkFamily(super.transfer, this.files)
    : super(store: WatermarkMemoryStore());
  final Map<String, File> files;
  @override
  Future<File?> fileFor(FamilyAsset asset) async => files[asset.id];
}

BabyProfile profile() => BabyProfile({
  'id': 'baby',
  'name': '小满',
  'birthday': '2025-08-05',
  'referenceFaces': [],
  'autoMatch': false,
});

FamilyAsset photoAsset(
  String id, {
  String? date = '2025-08-12',
  String kind = 'photo',
}) => FamilyAsset({
  'id': id,
  '_localId': id,
  'filename': '$id.png',
  'kind': kind,
  'date': date,
  'dateSource': 'capture',
  'dateConfirmed': date != null,
});

Finder imageWithPath(String path) => find.byWidgetPredicate(
  (widget) =>
      widget is Image &&
      widget.image is FileImage &&
      (widget.image as FileImage).file.path == path,
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final messenger =
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
  late File image, updated;
  setUp(() async {
    final directory = await Directory.systemTemp.createTemp('jinchuan-growth-');
    image = File('${directory.path}/synthetic.png');
    updated = File('${directory.path}/updated.png');
    final pixel = base64Decode(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aOz0AAAAASUVORK5CYII=',
    );
    await image.writeAsBytes(pixel);
    await updated.writeAsBytes(pixel);
  });
  tearDown(
    () => messenger.setMockMethodCallHandler(FamilyController.channel, null),
  );

  test('成长文案按自然日、日历月和周年省略零分量，旧调用保持原样', () {
    expect(growthWatermarkLabel('2025-08-05', '2025-08-05'), '出生第 1 天');
    expect(growthWatermarkLabel('2025-08-05', '2025-08-12'), '出生第 8 天');
    expect(growthWatermarkLabel('2025-08-05', '2025-09-05'), '1 个月');
    expect(growthWatermarkLabel('2025-08-05', '2026-02-08'), '6 个月 3 天');
    expect(growthWatermarkLabel('2025-08-05', '2026-08-05'), '1 岁啦');
    expect(growthWatermarkLabel('2025-08-05', '2026-08-06'), '1 岁 1 天');
    expect(growthWatermarkLabel('2025-08-05', '2026-10-08'), '1 岁 2 个月 3 天');
    expect(growthWatermarkLabel('2024-02-29', '2025-02-28'), '1 岁啦');
    expect(growthWatermarkLabel('2024-01-31', '2024-02-29'), '1 个月');
    expect(growthWatermarkLabel('2024-01-31', '2024-03-30'), '1 个月 30 天');
    expect(
      growthWatermarkLabel('2025-08-05', '2025-09-05', mode: 'day-count'),
      '出生第 32 天',
    );
    expect(
      watermarkText(
        profile(),
        '2025-08-12',
        template: 'growth',
        showName: false,
      ),
      '出生第 8 天\n2025 · 08 · 12',
    );
    expect(
      watermarkText(
        profile(),
        '2025-08-12',
        template: 'growth',
        showName: true,
        showDate: false,
      ),
      '小满 · 出生第 8 天',
    );
    expect(
      watermarkText(profile(), '2025-08-12'),
      '小满 · 0 个月 7 天 · 2025-08-12',
    );
  });

  test('创建时间与溢出的日历日期不能生成准确成长水印', () {
    final item = photoAsset('invalid', date: '2025-02-31');
    expect(watermarkUnavailableReason(item, profile()), contains('日期无效'));
    item.data['date'] = '2025-08-12';
    item.data['dateSource'] = 'creation';
    expect(watermarkUnavailableReason(item, profile()), contains('拍摄日期待确认'));
  });

  testWidgets('打开即生成左下两行预览，更多选项按需显示且照片占主体', (tester) async {
    tester.view.physicalSize = const Size(390, 844);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final calls = <Map<dynamic, dynamic>>[];
    messenger.setMockMethodCallHandler(FamilyController.channel, (call) async {
      calls.add(call.arguments as Map);
      return {'path': updated.path, 'filename': 'copy.jpg', 'gallery': false};
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: photoAsset('first'),
          baby: profile(),
          file: image,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(calls, hasLength(1));
    expect(calls.single['preview'], isTrue);
    expect(calls.single['template'], 'growth');
    expect(calls.single['text'], '出生第 8 天\n2025 · 08 · 12');
    expect(calls.single['position'], 'bottom-left');
    expect(calls.single['fontSize'], 48);
    expect(calls.single['shade'], isTrue);
    expect(find.text('显示宝宝昵称'), findsNothing);
    expect(
      tester.getRect(imageWithPath(updated.path)).height,
      greaterThan(500),
    );
    await tester.tap(find.byKey(const ValueKey('watermark-more')));
    await tester.pumpAndSettle();
    expect(find.text('显示宝宝昵称'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭设置'));
    await tester.pumpAndSettle();
    expect(find.text('显示宝宝昵称'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('选项防抖并拒绝旧预览，处理中保留照片且关闭后迟到结果安全', (tester) async {
    final pending = Completer<Map<String, dynamic>>();
    final calls = <Map<dynamic, dynamic>>[];
    messenger.setMockMethodCallHandler(FamilyController.channel, (call) async {
      calls.add(call.arguments as Map);
      if (calls.length == 1) return pending.future;
      return {'path': updated.path, 'filename': 'new.jpg'};
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: photoAsset('first'),
          baby: profile(),
          file: image,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    expect(imageWithPath(image.path), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('watermark-mode')));
    await tester.pump(const Duration(milliseconds: 350));
    await tester.tap(find.text('出生天数').last);
    await tester.pump(const Duration(milliseconds: 250));
    expect(calls, hasLength(1));
    pending.complete({'path': image.path, 'filename': 'old.jpg'});
    await tester.pumpAndSettle();
    expect(calls, hasLength(2));
    expect(calls.last['growthMode'], 'day-count');
    expect(imageWithPath(updated.path), findsOneWidget);
    final closing = Completer<Map<String, dynamic>>();
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) => closing.future,
    );
    await tester.tap(find.byKey(const ValueKey('watermark-position')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('右上').last);
    await tester.pump(const Duration(milliseconds: 250));
    expect(imageWithPath(updated.path), findsOneWidget);
    await tester.pumpWidget(const MaterialApp(home: SizedBox()));
    closing.complete({'path': image.path});
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });

  testWidgets('批量逐张计算，日期不明、视频与保存失败列出原因后继续导出', (tester) async {
    final transfer = TransferController();
    final items = [
      photoAsset('first'),
      photoAsset('unknown', date: null),
      photoAsset('video', kind: 'video'),
      photoAsset('failure'),
      photoAsset('last', date: '2025-09-05'),
    ];
    final model = WatermarkFamily(transfer, {
      for (final item in items) item.id: image,
    })..ready = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    model.babies['baby'] = profile();
    for (final item in items) {
      model.assets[item.id] = item;
      model.decisions['baby:${item.id}'] = {
        'state': 'included',
        'origin': 'manual',
      };
    }
    final exported = <Map<dynamic, dynamic>>[];
    messenger.setMockMethodCallHandler(FamilyController.channel, (call) async {
      final args = call.arguments as Map;
      if (args['preview'] != true) {
        exported.add(args);
        if (exported.length == 2) {
          throw PlatformException(code: 'write', message: '合成保存失败，副本保留');
        }
      }
      return {'path': updated.path, 'filename': 'copy.jpg', 'gallery': true};
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: items.first,
          baby: profile(),
          controller: model,
          sequence: items,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('watermark-export')));
    await tester.pumpAndSettle();
    expect(exported, hasLength(3));
    expect(exported.first['text'], '出生第 8 天\n2025 · 08 · 12');
    expect(exported.last['text'], '1 个月\n2025 · 09 · 05');
    expect(find.text('已保存 2 张副本，3 张未完成'), findsOneWidget);
    await tester.tap(find.text('查看 3 张未完成的原因'));
    await tester.pumpAndSettle();
    expect(find.text('unknown.png'), findsOneWidget);
    expect(find.text('video.png'), findsOneWidget);
    expect(find.text('failure.png'), findsOneWidget);
    expect(find.textContaining('合成保存失败'), findsOneWidget);
    expect(model.decision('baby', 'unknown'), 'included');
    expect(image.existsSync(), isTrue);
    expect(tester.takeException(), isNull);
  });

  testWidgets('新样式预览失败保留旧图并禁止保存，重试成功后才能导出新样式', (tester) async {
    var previews = 0, exports = 0;
    messenger.setMockMethodCallHandler(FamilyController.channel, (call) async {
      final args = call.arguments as Map;
      if (args['preview'] == true) {
        previews++;
        if (previews == 2) {
          throw PlatformException(code: 'preview', message: '合成预览失败，请重试');
        }
      } else {
        exports++;
        expect(args['position'], 'top-right');
      }
      return {
        'path': previews < 3 ? updated.path : image.path,
        'filename': 'copy.jpg',
        'gallery': true,
      };
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: photoAsset('ready'),
          baby: profile(),
          file: image,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(imageWithPath(updated.path), findsOneWidget);
    final previousSave = tester
        .widget<FilledButton>(find.byKey(const ValueKey('watermark-export')))
        .onPressed!;
    await tester.tap(find.byKey(const ValueKey('watermark-position')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('右上').last);
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(find.text('合成预览失败，请重试'), findsOneWidget);
    expect(imageWithPath(updated.path), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('watermark-export')))
          .onPressed,
      isNull,
    );
    await tester.tap(find.byKey(const ValueKey('watermark-export')));
    previousSave();
    await tester.pump();
    expect(exports, 0);
    await tester.tap(find.text('重试预览'));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(imageWithPath(image.path), findsOneWidget);
    expect(
      tester
          .widget<FilledButton>(find.byKey(const ValueKey('watermark-export')))
          .onPressed,
      isNotNull,
    );
    await tester.tap(find.byKey(const ValueKey('watermark-export')));
    await tester.pumpAndSettle();
    expect(exports, 1);
    expect(tester.takeException(), isNull);
  });

  testWidgets('疑似照片需明确确认是宝宝，水印不会偷偷改归属或添加参考', (tester) async {
    final transfer = TransferController();
    final item = photoAsset('candidate');
    final model = WatermarkFamily(transfer, {item.id: image});
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    final baby = profile();
    model.babies[baby.id] = baby;
    model.assets[item.id] = item;
    model.decisions['baby:${item.id}'] = {
      'state': 'candidate',
      'origin': 'automatic',
    };
    var calls = 0;
    messenger.setMockMethodCallHandler(FamilyController.channel, (_) async {
      calls++;
      return {'path': updated.path};
    });
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: item,
          baby: baby,
          file: image,
          controller: model,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    expect(calls, 0);
    expect(model.decision('baby', item.id), 'candidate');
    await tester.tap(find.text('确认是宝宝'));
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    expect(calls, 1);
    expect(model.decision('baby', item.id), 'included');
    expect(baby.references, isEmpty);
  });

  testWidgets('宝宝多选直达批量水印，返回保持所选照片', (tester) async {
    final transfer = TransferController();
    final items = [photoAsset('first'), photoAsset('last')];
    final model = WatermarkFamily(transfer, {
      for (final item in items) item.id: image,
    })..ready = true;
    addTearDown(() {
      model.dispose();
      transfer.dispose();
    });
    model.babies['baby'] = profile();
    model.activeBaby = 'baby';
    for (final item in items) {
      model.assets[item.id] = item;
      model.decisions['baby:${item.id}'] = {
        'state': 'included',
        'origin': 'manual',
      };
    }
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'path': updated.path},
    );
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: BabyScreen(controller: model, onTransfer: (_) {}),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('baby-select')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('全选当前照片'));
    await tester.pumpAndSettle();
    expect(find.text('已选 2 张'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('baby-batch-watermark')));
    await tester.pump(const Duration(milliseconds: 400));
    await tester.pumpAndSettle();
    expect(find.text('导出 2 张水印副本'), findsOneWidget);
    await tester.pageBack();
    await tester.pumpAndSettle();
    expect(find.text('已选 2 张'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('320px 大字体成长水印保持保存可见，更多设置可以独立关闭', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    messenger.setMockMethodCallHandler(
      FamilyController.channel,
      (_) async => {'path': updated.path},
    );
    await tester.pumpWidget(
      MaterialApp(
        home: WatermarkScreen(
          asset: photoAsset('narrow'),
          baby: profile(),
          file: image,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpAndSettle();
    final save = tester.getRect(find.byKey(const ValueKey('watermark-export')));
    expect(save.bottom, lessThanOrEqualTo(640));
    expect(
      tester.getRect(imageWithPath(updated.path)).height,
      greaterThan(250),
    );
    await tester.tap(find.byKey(const ValueKey('watermark-more')));
    await tester.pumpAndSettle();
    expect(find.byTooltip('关闭设置'), findsOneWidget);
    await tester.tap(find.byTooltip('关闭设置'));
    await tester.pumpAndSettle();
    expect(find.byType(WatermarkScreen), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
