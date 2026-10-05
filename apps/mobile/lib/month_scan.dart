import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'backup_catalog.dart';

const monthPageSize = 100;

String calendarMonth(DateTime date) =>
    '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}';

/// 日期区间采用本地月初到下月月初，避免月底、闰年和时区边界遗漏。
String monthWhere(String month, {required bool usesDateTaken}) {
  final fallback =
      '(datetaken IS NULL OR (datetaken > -1000 AND datetaken < 1000))';
  if (month == 'unknown') {
    return usesDateTaken
        ? 'media_type IN (1,3) AND (datetaken <= -1000 OR ($fallback AND (date_added IS NULL OR date_added <= 0)))'
        : 'media_type IN (1,3) AND (date_added IS NULL OR date_added <= 0)';
  }
  if (!RegExp(r'^\d{4}-(0[1-9]|1[0-2])$').hasMatch(month)) {
    throw const FormatException('请选择有效月份。');
  }
  final year = int.parse(month.substring(0, 4)),
      number = int.parse(month.substring(5));
  final start = DateTime(year, number).millisecondsSinceEpoch ~/ 1000;
  final end = DateTime(year, number + 1).millisecondsSinceEpoch ~/ 1000;
  final added =
      '(date_added > 0 AND date_added >= $start AND date_added < $end)';
  return usesDateTaken
      ? 'media_type IN (1,3) AND ((datetaken >= 1000 AND datetaken >= ${start * 1000} AND datetaken < ${end * 1000}) OR ($fallback AND $added))'
      : 'media_type IN (1,3) AND $added';
}

/// 从系统媒体库按月筛选并分页，不先枚举其他月份的照片。
abstract class MonthPhotoSource {
  Future<int> count();
  Future<List<AssetEntity>> page(int number);

  static Future<MonthPhotoSource> open(
    AssetPathEntity album,
    String month,
  ) async {
    final sdk = await const MethodChannel(
      'dev.momentnest/media',
    ).invokeMethod<int>('sdkInt');
    if (sdk == null) throw StateError('无法读取 Android 相册版本。');
    final filter = CustomFilter.sql(
      where: monthWhere(month, usesDateTaken: sdk >= 29),
      orderBy: const [OrderByItem.desc('_id')],
    )..needTitle = true;
    return _MediaStoreMonth(
      AssetPathEntity(
        id: album.id,
        name: album.name,
        isAll: album.isAll,
        type: RequestType.common,
        filterOption: filter,
      ),
    );
  }
}

class _MediaStoreMonth extends MonthPhotoSource {
  _MediaStoreMonth(this.album);
  final AssetPathEntity album;
  @override
  Future<int> count() => album.assetCountAsync;
  @override
  Future<List<AssetEntity>> page(int number) =>
      album.getAssetListPaged(page: number, size: monthPageSize);
}

/// 仅保留当前月的轻量状态，逐张修正计数，界面无需反复遍历照片。
class MonthScanProgress {
  int total = 0;
  final Map<String, ({String version, String state})> _states = {};
  final Map<String, int> _counts = {};
  int get pending => _counts['pending'] ?? 0;
  int get missing => _counts['missing'] ?? 0;
  int get backed => (_counts['uploaded'] ?? 0) + (_counts['exists'] ?? 0);
  int get unknown => (total - pending - backed - missing).clamp(0, total);
  Iterable<String> get pendingIds => _states.entries
      .where((entry) => entry.value.state == 'pending')
      .map((entry) => entry.key);
  int get tracked => _states.length;

  void reset(int count) {
    total = count;
    _states.clear();
    _counts.clear();
  }

  String? state(AssetEntity asset) {
    final value = _states[asset.id];
    return value?.version == photoVersion(asset) ? value?.state : null;
  }

  void record(AssetEntity asset, String state) {
    final previous = _states[asset.id];
    if (previous != null) _counts.update(previous.state, (count) => count - 1);
    _states[asset.id] = (version: photoVersion(asset), state: state);
    _counts.update(state, (count) => count + 1, ifAbsent: () => 1);
    if (_states.length > total) total = _states.length;
  }
}
