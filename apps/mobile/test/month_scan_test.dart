import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/month_scan.dart';
import 'backup_test.dart' as fixtures;

class GeneratedMonth extends MonthPhotoSource {
  GeneratedMonth(this.month, this.length);
  final int month, length;
  final pages = <int>[];
  @override
  Future<int> count() async => length;
  @override
  Future<List<AssetEntity>> page(int number) async {
    pages.add(number);
    final start = number * monthPageSize;
    return List.generate(
      (length - start).clamp(0, monthPageSize),
      (index) => fixtures.photo('$month-${start + index}', month),
    );
  }
}

class MonthController extends fixtures.CheckController {
  MonthController(super.respond, this.sources) {
    online = false;
    album = AssetPathEntity(
      id: 'all',
      name: '测试相册',
      isAll: true,
      type: RequestType.image,
    );
  }
  final Map<String, MonthPhotoSource> sources;
  @override
  Future<MonthPhotoSource> openMonthSource(
    AssetPathEntity source,
    String month,
  ) async => sources[month]!;
}

class DelayedMonth extends GeneratedMonth {
  DelayedMonth() : super(2, 1);
  final entered = Completer<void>(), release = Completer<void>();
  @override
  Future<List<AssetEntity>> page(int number) async {
    entered.complete();
    await release.future;
    return super.page(number);
  }
}

class InterruptedMonth extends GeneratedMonth {
  InterruptedMonth() : super(2, 250);
  bool interrupted = false;
  @override
  Future<List<AssetEntity>> page(int number) async {
    if (number == 1 && !interrupted) {
      interrupted = true;
      throw StateError('系统相册读取中断');
    }
    return super.page(number);
  }
}

class ShortMonth extends GeneratedMonth {
  ShortMonth() : super(2, 250);
  bool shortened = false;
  @override
  Future<List<AssetEntity>> page(int number) async {
    final batch = await super.page(number);
    if (number == 1 && !shortened) {
      shortened = true;
      return batch.take(99).toList();
    }
    return batch;
  }
}

void main() {
  test('原生查询月份区间覆盖闰年、月初月末、日期回退及视频', () async {
    final start = DateTime(2024, 2).millisecondsSinceEpoch;
    final end = DateTime(2024, 3).millisecondsSinceEpoch;
    final rows = [
      [1, 1, start, 0],
      [2, 1, start - 1, 0],
      [3, 1, end - 1, 0],
      [4, 1, end, 0],
      [5, 1, null, start ~/ 1000],
      [6, 1, 0, start ~/ 1000],
      [7, 1, start - 86400000, start ~/ 1000],
      [8, 3, start, start ~/ 1000],
      [9, 1, 0, 0],
      [10, 1, -1000, start ~/ 1000],
      [11, 1, 299, start ~/ 1000],
    ];
    Future<List<dynamic>> query(String month, bool modern) async {
      final run = await Process.run('node', [
        File('test/month_sql_fixture.mjs').absolute.path,
        jsonEncode({
          'where': monthWhere(month, usesDateTaken: modern),
          'rows': rows,
        }),
      ]);
      expect(run.exitCode, 0, reason: run.stderr.toString());
      return jsonDecode(run.stdout as String) as List;
    }

    expect(await query('2024-02', true), [1, 3, 5, 6, 8, 11]);
    expect(await query('2024-02', false), [5, 6, 7, 8, 10, 11]);
    expect(await query('unknown', true), [9, 10]);
    expect(
      () => monthWhere('2024-13', usesDateTaken: true),
      throwsFormatException,
    );
    expect(
      () => monthWhere("2024-02' OR 1=1", usesDateTaken: true),
      throwsFormatException,
    );
  });

  test('五万条本月记录自动全部展示和全选，不枚举其他月份或读取原图', () async {
    final month = GeneratedMonth(2, 50000), other = GeneratedMonth(1, 20000);
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
      '2024-01': other,
    });
    addTearDown(model.dispose);
    await model.loadMonth();
    expect(month.pages, List.generate(500, (index) => index));
    expect(other.pages, isEmpty);
    expect(model.photos.length, 50000);
    expect(model.monthProgress.total, 50000);
    expect(model.monthProgress.unknown, 50000);
    expect(model.photos.first.id, '2-0');
    expect(model.photos.last.id, '2-49999');
    expect(model.hasMore, isFalse);
    expect(model.selected.length, 50000);
    model.toggle('2-0');
    expect(model.selected, isNot(contains('2-0')));
    expect(model.selected.length, 49999);
    expect(model.inspected, isEmpty);
  });

  test('本月全部展示5000条并逐批核对，汇总和补传覆盖整月', () async {
    final month = GeneratedMonth(2, 5000), other = GeneratedMonth(1, 1);
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
      '2024-01': other,
    });
    addTearDown(model.dispose);
    await model.loadMonth();
    model.online = true;
    await model.checkPhotos();
    expect(model.inspected.length, 5000);
    expect(model.photos.length, 5000);
    expect(model.observations.length, 5000);
    expect(model.monthProgress.pending, 5000);
    expect(model.monthProgress.unknown, 0);
    expect(other.pages, isEmpty);
    model.selectUnbackedMonth();
    expect(model.selected.length, 5000);
    expect(model.tasks, isEmpty);
    model.online = false;
    model.filter = 'pending';
    await model.selectMonth('2024-01');
    expect(model.filter, 'all');
    expect(model.visiblePhotos.single.id, '1-0');
    expect(model.monthProgress.total, 1);
    expect(model.monthProgress.pending, 0);
    expect(model.selected, {'1-0'});
    expect(model.photos.single.id, '1-0');
  });

  test('月度扫描暂停后不读取下一批，继续时跳过本轮已核对记录', () async {
    var requests = 0;
    late MonthController model;
    final month = GeneratedMonth(2, 250);
    model = MonthController((data) async {
      if (++requests == 3) model.stopChecking(pause: true);
      return fixtures.result(data);
    }, {'2024-02': month});
    addTearDown(model.dispose);
    await model.loadMonth();
    model.online = true;
    await model.checkPhotos();
    expect(model.monthProgress.pending, 2);
    expect(month.pages, [0, 1, 2, 0]);
    expect(model.checkPaused, isTrue);
    await model.resumeChecking();
    expect(requests, 251);
    expect(model.monthProgress.pending, 250);
    expect(model.photos.length, 250);
  });

  test('整月读取中断可继续追加剩余照片，已选项不清空', () async {
    final month = InterruptedMonth();
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
    });
    addTearDown(model.dispose);
    await expectLater(model.loadMonth(), throwsStateError);
    expect(model.photos.length, 100);
    expect(model.hasMore, isTrue);
    expect(model.catalogComplete, isFalse);
    model.toggle('2-0');
    await model.morePhotos();
    expect(model.photos.length, 250);
    expect(model.photos.map((asset) => asset.id).toSet().length, 250);
    expect(model.selected.length, 249);
    expect(model.selected, isNot(contains('2-0')));
    expect(model.catalogComplete, isTrue);
    expect(model.hasMore, isFalse);
  });

  test('取消整月选择后继续读取目录不会重新勾选', () async {
    final month = InterruptedMonth();
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
    });
    addTearDown(model.dispose);
    await expectLater(model.loadMonth(), throwsStateError);
    expect(model.selected, hasLength(100));
    model.clearSelection();
    await model.morePhotos();
    expect(model.photos, hasLength(250));
    expect(model.selected, isEmpty);
    model.selectVisible();
    expect(model.selected, hasLength(250));
    expect(model.inspected, isEmpty);
  });

  test('返回前台保留整月撤选和取消状态，不重读目录自动勾选', () async {
    final month = GeneratedMonth(2, 250);
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
    });
    addTearDown(model.dispose);
    await model.loadMonth();
    model.toggle('2-0');
    model.foreground(false);
    model.foreground(true);
    await Future<void>.delayed(Duration.zero);
    expect(model.selected, hasLength(249));
    expect(model.selected, isNot(contains('2-0')));
    model.clearSelection();
    model.foreground(false);
    model.foreground(true);
    await Future<void>.delayed(Duration.zero);
    expect(model.selected, isEmpty);
    expect(month.pages, [0, 1, 2]);
    expect(model.inspected, isEmpty);
  });

  test('按月备份遇到短页保留读取位置，重试补齐后才完成整月选择', () async {
    final month = ShortMonth();
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': month,
    });
    addTearDown(model.dispose);
    await expectLater(model.loadMonth(), throwsStateError);
    expect(model.catalogComplete, isFalse);
    expect(model.photos, hasLength(100));
    expect(model.selected, hasLength(100));
    await model.morePhotos();
    expect(month.pages, [0, 1, 1, 2]);
    expect(model.catalogComplete, isTrue);
    expect(model.selected, hasLength(250));
    expect(model.inspected, isEmpty);
  });

  test('切换月份后旧页面查询迟到结果不能覆盖新月份', () async {
    final delayed = DelayedMonth(), next = GeneratedMonth(1, 2);
    final model = MonthController((data) async => fixtures.result(data), {
      '2024-02': delayed,
      '2024-01': next,
    });
    addTearDown(model.dispose);
    final old = model.loadMonth();
    await delayed.entered.future;
    await model.selectMonth('2024-01');
    delayed.release.complete();
    await old;
    expect(model.selectedMonth, '2024-01');
    expect(model.photos.map((item) => item.id), ['1-0', '1-1']);
    expect(model.monthProgress.total, 2);
    expect(model.loadingPhotos, isFalse);
  });
}
