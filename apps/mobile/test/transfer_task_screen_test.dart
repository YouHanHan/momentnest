import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/home_screen.dart';
import 'package:momentnest_mobile/models.dart';
import 'package:momentnest_mobile/system_gallery.dart';
import 'package:momentnest_mobile/transfer_controller.dart';
import 'package:momentnest_mobile/transfer_task_screen.dart';
import 'package:photo_manager/photo_manager.dart';

class DetailTestController extends TransferController {
  int retries = 0, cancellations = 0, pauses = 0;
  UploadTask? operatedTask;
  Object? cancelError;

  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }

  @override
  Future<void> checkPhotos({bool restart = false}) async {}

  @override
  void pause() {
    pauses++;
    super.pause();
    running = false;
    changed();
  }

  @override
  Future<void> retry(UploadTask task) async {
    retries++;
    operatedTask = task;
    task.state = 'queued';
    task.data['error'] = '';
    changed();
  }

  @override
  Future<void> cancel(UploadTask task) async {
    cancellations++;
    operatedTask = task;
    final error = cancelError;
    if (error != null) throw error;
    task.state = 'cancelled';
    changed();
  }
}

class DetailTestFamily extends FamilyController {
  DetailTestFamily(super.transfer);

  @override
  Future<void> initialize() async {
    ready = true;
    changed();
  }
}

class DetailTestGallery extends SystemGalleryController {
  @override
  Future<void> initialize() async {
    ready = true;
    permission = PermissionState.denied;
    notifyListeners();
  }
}

UploadTask syntheticTask({
  String id = 'sample-task',
  String state = 'failed',
  String filename = '宝宝周末照片.jpg',
  String error = '电脑暂时无法连接，请在同一局域网重试。',
  String libraryPath = r'D:\家庭照片',
  int offset = 256,
  Json? receipt,
}) => UploadTask({
  'id': id,
  'assetId': 'synthetic-media',
  'receiverId': 'synthetic-receiver',
  'receiverName': '家里的电脑',
  'libraryId': 'synthetic-library',
  'libraryPath': libraryPath,
  'filename': filename,
  'kind': 'photo',
  'hash': List.filled(64, '0').join(),
  'size': 1024,
  'offset': offset,
  'archiveDate': '2026-10-01',
  'createdAt': '2026-10-01T12:00:00.000Z',
  'state': state,
  'error': error,
  'receipt': receipt == null
      ? null
      : {
          'receiverId': 'synthetic-receiver',
          'libraryId': 'synthetic-library',
          'hash': List.filled(64, '0').join(),
          'size': 1024,
          ...receipt,
        },
});

Future<void> mountDetail(
  WidgetTester tester,
  DetailTestController controller,
) => tester.pumpWidget(
  MaterialApp(
    home: TransferTaskDetailScreen(
      controller: controller,
      taskId: 'sample-task',
    ),
  ),
);

ButtonStyleButton taskButton(WidgetTester tester, String key) =>
    tester.widget<ButtonStyleButton>(find.byKey(ValueKey(key)));

Finder detailScrollable() => find
    .descendant(
      of: find.byKey(const ValueKey('transfer-task-detail')),
      matching: find.byType(Scrollable),
    )
    .first;

void main() {
  testWidgets('活动批次卡片内可暂停队列，历史批次仍按需进入详情', (tester) async {
    final controller = DetailTestController()
      ..running = true
      ..tasks = [
        syntheticTask(id: 'active', state: 'uploading', error: ''),
        syntheticTask(id: 'history', state: 'failed'),
      ];
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: controller,
          familyController: DetailTestFamily(controller),
          galleryController: DetailTestGallery(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('传输'),
      ),
    );
    await tester.pumpAndSettle();
    final pause = find.byKey(const ValueKey('transfer-pause-queue'));
    await tester.ensureVisible(pause);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('active-batch-card-active')),
        matching: pause,
      ),
      findsOneWidget,
    );
    await tester.tap(pause);
    await tester.pumpAndSettle();
    expect(controller.pauses, 1);
    expect(controller.running, isFalse);
    final history = find.byKey(const ValueKey('transfer-batch-history'));
    await tester.ensureVisible(history);
    await tester.tap(history);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('transfer-batch-detail')), findsOneWidget);
    expect(controller.tasks, hasLength(2));
    expect(tester.takeException(), isNull);
  });

  testWidgets('已配对电脑首页只显示概况，连接与目录设置在独立页面查看', (tester) async {
    const libraryPath = r'D:\家庭照片\原文件归档';
    final controller = DetailTestController()
      ..connection = const ReceiverConnection(
        id: 'synthetic-receiver',
        name: '家里的电脑',
        address: 'https://192.168.1.8:45831',
        fingerprint: 'synthetic-fingerprint',
        deviceId: 'synthetic-device',
      )
      ..online = true
      ..libraries = [
        {'id': 'synthetic-library', 'path': libraryPath},
      ]
      ..libraryId = 'synthetic-library'
      ..tasks = [syntheticTask(libraryPath: libraryPath)];
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: controller,
          familyController: DetailTestFamily(controller),
          galleryController: DetailTestGallery(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('传输'),
      ),
    );
    await tester.pumpAndSettle();
    expect(find.text(libraryPath), findsNothing);
    expect(find.text('配对新电脑'), findsNothing);
    expect(find.text('本次接收目录'), findsNothing);
    await tester.tap(find.text('家里的电脑'));
    await tester.pumpAndSettle();
    expect(find.text('连接与接收目录'), findsOneWidget);
    expect(find.text('电脑当前照片库'), findsOneWidget);
    expect(find.byType(DropdownButtonFormField<String>), findsNothing);
    expect(find.text(libraryPath), findsWidgets);
    expect(find.text('配对新电脑'), findsOneWidget);
    expect(find.text('重新连接'), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('transfer-batch-sample-task'));
    await tester.ensureVisible(row);
    expect(row, findsOneWidget);
    expect(find.text('本次接收目录'), findsNothing);
    expect(find.text(libraryPath), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('传输列表收纳任务信息，点任务后进入独立详情页', (tester) async {
    final task = syntheticTask();
    final controller = DetailTestController()
      ..tasks = [task]
      ..notice = task.error;
    await tester.pumpWidget(
      MaterialApp(
        home: HomeScreen(
          controller: controller,
          familyController: DetailTestFamily(controller),
          galleryController: DetailTestGallery(),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.tap(
      find.descendant(
        of: find.byType(NavigationBar),
        matching: find.text('传输'),
      ),
    );
    await tester.pumpAndSettle();
    final row = find.byKey(const ValueKey('transfer-batch-sample-task'));
    await tester.ensureVisible(row);
    expect(find.text(task.filename), findsNothing);
    expect(find.textContaining(task.error), findsNothing);
    expect(find.textContaining(task.data['libraryPath']), findsNothing);
    expect(find.byKey(const ValueKey('transfer-task-retry')), findsNothing);
    expect(find.byKey(const ValueKey('transfer-task-cancel')), findsNothing);

    await tester.tap(row);
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('transfer-batch-detail')), findsOneWidget);
    expect(find.byType(NavigationBar), findsNothing);
    await tester.tap(find.byKey(const ValueKey('transfer-task-sample-task')));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('transfer-task-detail')), findsOneWidget);
    expect(find.textContaining(task.filename), findsWidgets);
    await tester.scrollUntilVisible(
      find.textContaining(task.data['libraryPath']),
      160,
      scrollable: detailScrollable(),
    );
    expect(find.textContaining(task.data['libraryPath']), findsOneWidget);
    await tester.scrollUntilVisible(
      find.textContaining(task.error),
      -160,
      scrollable: detailScrollable(),
    );
    expect(find.textContaining(task.error), findsOneWidget);
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(row, findsOneWidget);
    expect(find.byKey(const ValueKey('transfer-task-detail')), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('详情按任务标识读取替换后的任务并实时更新进度与保存回执', (tester) async {
    final controller = DetailTestController()
      ..tasks = [syntheticTask(state: 'uploading', error: '')];
    addTearDown(controller.dispose);
    await mountDetail(tester, controller);
    await tester.pump();
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      0.25,
    );

    final refreshed = syntheticTask(
      state: 'paused',
      filename: '宝宝视频.mp4',
      error: '',
      offset: 768,
    )..data['kind'] = 'video';
    controller.tasks = [refreshed];
    controller.changed();
    await tester.pump();
    expect(find.textContaining('宝宝视频.mp4'), findsWidgets);
    expect(find.textContaining('已暂停'), findsWidgets);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      0.75,
    );

    controller.tasks = [
      syntheticTask(
        state: 'complete',
        error: '',
        offset: 1024,
        receipt: {'relativePath': '2026-10-01/宝宝周末照片.jpg'},
      ),
    ];
    controller.changed();
    await tester.pump();
    await tester.ensureVisible(find.textContaining('2026-10-01/宝宝周末照片.jpg'));
    expect(find.textContaining('2026-10-01/宝宝周末照片.jpg'), findsOneWidget);
    expect(find.textContaining('已保存'), findsWidgets);
    expect(tester.takeException(), isNull);
  });

  testWidgets('字节已发送到百分之百仍保持核对状态，等待真实保存回执', (tester) async {
    final controller = DetailTestController()
      ..tasks = [syntheticTask(state: 'checking', offset: 1024, error: '')];
    addTearDown(controller.dispose);
    await mountDetail(tester, controller);
    await tester.pump();
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      1,
    );
    expect(find.textContaining('校验'), findsWidgets);
    expect(find.text('已上传'), findsNothing);
    expect(find.byKey(const ValueKey('transfer-task-retry')), findsNothing);
    expect(find.byKey(const ValueKey('transfer-task-cancel')), findsNothing);
  });

  testWidgets('详情重试使用最新任务记录，不操作被替换的旧对象', (tester) async {
    final original = syntheticTask();
    final controller = DetailTestController()..tasks = [original];
    addTearDown(controller.dispose);
    await mountDetail(tester, controller);
    await tester.pump();
    final replacement = syntheticTask(error: '新的任务错误');
    controller.tasks = [replacement];
    controller.changed();
    await tester.pump();
    final retry = find.byKey(const ValueKey('transfer-task-retry'));
    await tester.ensureVisible(retry);
    await tester.pumpAndSettle();
    await tester.tap(retry);
    await tester.pumpAndSettle();
    expect(controller.retries, 1);
    expect(controller.operatedTask, same(replacement));
    expect(replacement.state, 'queued');
    expect(original.state, 'failed');
    expect(find.textContaining('新的任务错误'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('全局运行或处理其他操作时，详情重试与取消不可点击', (tester) async {
    final controller = DetailTestController()..tasks = [syntheticTask()];
    addTearDown(controller.dispose);
    await mountDetail(tester, controller);
    await tester.pump();
    for (final busy in [true, false]) {
      controller.busy = busy;
      controller.running = !busy;
      controller.changed();
      await tester.pump();
      await tester.scrollUntilVisible(
        find.byKey(const ValueKey('transfer-task-cancel')),
        160,
        scrollable: detailScrollable(),
      );
      await tester.pump();
      expect(taskButton(tester, 'transfer-task-retry').onPressed, isNull);
      expect(taskButton(tester, 'transfer-task-cancel').onPressed, isNull);
    }
    controller.busy = false;
    controller.running = false;
    controller.changed();
    await tester.pump();
    expect(taskButton(tester, 'transfer-task-retry').onPressed, isNotNull);
    expect(taskButton(tester, 'transfer-task-cancel').onPressed, isNotNull);
    expect(controller.retries, 0);
    expect(controller.cancellations, 0);
    expect(tester.takeException(), isNull);
  });

  testWidgets('电脑已完成保存而取消失败时，错误在当前详情可见并保留任务', (tester) async {
    final task = syntheticTask(error: '');
    final controller = DetailTestController()
      ..tasks = [task]
      ..cancelError = StateError('电脑已经完成保存，请继续任务以取回回执。');
    addTearDown(controller.dispose);
    await mountDetail(tester, controller);
    await tester.pump();
    final cancel = find.byKey(const ValueKey('transfer-task-cancel'));
    await tester.ensureVisible(cancel);
    await tester.pumpAndSettle();
    await tester.tap(cancel);
    await tester.pumpAndSettle();
    expect(controller.cancellations, 1);
    expect(task.state, 'failed');
    expect(find.textContaining('电脑已经完成保存，请继续任务以取回回执。'), findsWidgets);
    expect(controller.busy, isFalse);
    expect(tester.takeException(), isNull);
  });

  testWidgets('已上传、跳过与取消任务不再提供重试或取消入口', (tester) async {
    final controller = DetailTestController();
    addTearDown(controller.dispose);
    for (final state in ['complete', 'skipped', 'cancelled']) {
      controller.tasks = [syntheticTask(state: state, error: '')];
      await mountDetail(tester, controller);
      controller.changed();
      await tester.pump();
      expect(find.byKey(const ValueKey('transfer-task-retry')), findsNothing);
      expect(find.byKey(const ValueKey('transfer-task-cancel')), findsNothing);
    }
    expect(tester.takeException(), isNull);
  });

  testWidgets('窄屏大字体下任务列表与长路径详情可滚动阅读', (tester) async {
    tester.view.physicalSize = const Size(320, 640);
    tester.view.devicePixelRatio = 1;
    tester.platformDispatcher.textScaleFactorTestValue = 1.6;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
    final task = syntheticTask(
      filename: '${List.filled(7, '宝宝成长记录长名称').join()}.mp4',
      libraryPath: '${r'D:\家庭照片\'}${List.filled(10, '很长的归档目录').join()}',
      error: '当前电脑接收目录暂时无法访问。${List.filled(8, '请检查局域网连接和保存目录权限。').join()}',
    )..data['kind'] = 'video';
    final controller = DetailTestController()..tasks = [task];
    addTearDown(controller.dispose);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: TransferTaskTile(task: task, onTap: () {}),
        ),
      ),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await mountDetail(tester, controller);
    await tester.pump();
    await tester.scrollUntilVisible(
      find.textContaining(task.data['libraryPath']),
      160,
      scrollable: detailScrollable(),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.textContaining(task.error),
      -160,
      scrollable: detailScrollable(),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
    await tester.scrollUntilVisible(
      find.byKey(const ValueKey('transfer-task-retry')),
      160,
      scrollable: detailScrollable(),
    );
    await tester.pump();
    expect(tester.takeException(), isNull);
  });
}
