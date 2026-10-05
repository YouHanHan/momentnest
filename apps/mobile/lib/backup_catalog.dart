import 'package:photo_manager/photo_manager.dart';
import 'models.dart';

/// 月份使用相册提供的本地日期，缺少日期的照片单独归组。
String photoMonth(AssetEntity asset) {
  if ((asset.createDateSecond ?? 0) <= 0) return 'unknown';
  final date = asset.createDateTime;
  return '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}';
}

String monthLabel(String month) => month == 'unknown'
    ? '日期未知'
    : '${month.substring(0, 4)} 年 ${int.parse(month.substring(5))} 月';

/// 媒体版本变化后必须重新计算内容指纹，不能继承旧备份状态。
String photoVersion(AssetEntity asset) =>
    '${asset.modifiedDateSecond}:${asset.createDateSecond}:${asset.width}:${asset.height}:${asset.title}:${asset.relativePath}';

/// 不完整的扫描不能证明文件未备份；已有文件仍可由有效证据确认。
String backupState(Json result) {
  if (result['receipt'] != null) return 'uploaded';
  if (result['previousReceipt'] != null &&
      ['missing', 'corrupt'].contains(result['receiptState'])) {
    return 'missing';
  }
  if (result['receiptState'] == 'unavailable') return 'unknown';
  if ((result['matches'] as List? ?? []).isNotEmpty) return 'exists';
  if (result['previousReceipt'] != null) return 'unknown';
  return result['complete'] == true ? 'pending' : 'unknown';
}

const galleryBackupLabels = {
  'uploaded': '已传入',
  'exists': '电脑其他目录已有',
  'pending': '未传入',
  'missing': '需补传',
  'unknown': '尚未核对',
};

bool matchesBackupFilter(String state, String filter) =>
    filter == 'all' ||
    (filter == 'backed'
        ? ['uploaded', 'exists'].contains(state)
        : state == filter);
