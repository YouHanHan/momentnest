import 'dart:math';
import 'models.dart';

/// 宝宝归类记录与传输回执独立，统一按原内容的完整指纹关联两端。
class BabyProfile {
  BabyProfile(this.data);
  final Json data;
  String get id => data['id'] as String;
  String get name => data['name'] as String;
  String get birthday => data['birthday'] as String;
  bool get autoMatch => data['autoMatch'] == true;
  String? get avatarPath => data['_avatarPath'] as String?;
  List<Json> get references => (data['referenceFaces'] as List? ?? [])
      .map((value) => Map<String, dynamic>.from(value as Map))
      .toList();
}

class FamilyAsset {
  FamilyAsset(this.data);
  final Json data;
  String get id => data['id'] as String;
  String get filename => data['filename'] as String? ?? '媒体';
  String get kind => data['kind'] as String? ?? 'photo';
  String? get date => data['date'] as String?;
  String? get localId => data['_localId'] as String?;
  String? get localPath => data['_path'] as String?;
  String? get thumbnailPath => data['_thumb'] as String?;
  List<Json> get faces => (data['faces'] as List? ?? [])
      .map((value) => Map<String, dynamic>.from(value as Map))
      .toList();
}

/// 归属与参考分别展示，创建时间不能被当作准确拍摄月龄。
String babyStatusLabel(Json? decision) {
  if (decision?['state'] == 'candidate') return '疑似';
  if (decision?['state'] == 'included') {
    return decision?['origin'] == 'manual' ? '人工确认' : '自动匹配';
  }
  return decision?['state'] == 'excluded' ? '已排除' : '未归类';
}

String? watermarkUnavailableReason(FamilyAsset asset, BabyProfile baby) {
  if (asset.kind != 'photo') return '视频暂不支持成长水印';
  if (asset.date == null ||
      asset.data['dateConfirmed'] != true ||
      !{'capture', 'manual'}.contains(asset.data['dateSource'])) {
    return '拍摄日期待确认，请在照片信息中确认日期';
  }
  final capture = DateTime.tryParse(asset.date!);
  if (capture == null ||
      '${capture.year.toString().padLeft(4, '0')}-${capture.month.toString().padLeft(2, '0')}-${capture.day.toString().padLeft(2, '0')}' !=
          asset.date) {
    return '日期无效，请修改拍摄日期';
  }
  if (dayCountAt(baby.birthday, asset.date!) <= 0) return '拍摄日期早于出生日期，请修正日期';
  if (asset.data['available'] == false) return '本机原文件暂不可用，请检查相册权限或重新选择照片';
  return null;
}

/// 自动显示仅使用确认归属与真实拍摄日，疑似和视频不标确定成长年龄。
String? growthWatermarkDisplayText(
  FamilyAsset asset,
  BabyProfile baby,
  String? membership,
) {
  if (membership != 'included' ||
      asset.kind != 'photo' ||
      asset.data['dateConfirmed'] != true ||
      !{'capture', 'manual'}.contains(asset.data['dateSource'])) {
    return null;
  }
  bool validDate(String? value) {
    final date = DateTime.tryParse(value ?? '');
    return date != null &&
        '${date.year.toString().padLeft(4, '0')}-${date.month.toString().padLeft(2, '0')}-${date.day.toString().padLeft(2, '0')}' ==
            value;
  }

  if (!validDate(baby.birthday) ||
      !validDate(asset.date) ||
      dayCountAt(baby.birthday, asset.date!) <= 0) {
    return null;
  }
  return watermarkText(baby, asset.date!, template: 'growth', showName: false);
}

String contentAssetId(String hash, int size) => '$hash-$size';

/// 使用自然日和日历月计算月龄，月底出生与闰年不会产生负天数。
String ageAt(String birthday, String date) {
  final age = _calendarAge(birthday, date);
  if (age == null) return '出生前';
  final year = age.months ~/ 12, month = age.months % 12;
  return '${year > 0 ? '$year 岁 ' : ''}${month > 0 || year == 0 ? '$month 个月 ' : ''}${age.days} 天';
}

/// 在生日所在日夹取月底，普通月龄与成长水印共用同一计算口径。
({int months, int days})? _calendarAge(String birthday, String date) {
  final birth = DateTime.parse(birthday), capture = DateTime.parse(date);
  final first = DateTime.utc(birth.year, birth.month, birth.day);
  final last = DateTime.utc(capture.year, capture.month, capture.day);
  if (last.isBefore(first)) return null;
  var months = (capture.year - birth.year) * 12 + capture.month - birth.month;
  DateTime anniversary(int value) {
    final start = DateTime.utc(birth.year, birth.month + value);
    final end = DateTime.utc(start.year, start.month + 1, 0);
    return DateTime.utc(start.year, start.month, min(birth.day, end.day));
  }

  if (last.isBefore(anniversary(months))) months--;
  final days = last.difference(anniversary(months)).inDays;
  return (months: months, days: days);
}

/// 出生当天为第一天，使用日历日期避免时区跨日。
int dayCountAt(String birthday, String date) {
  final birth = DateTime.parse(birthday), capture = DateTime.parse(date);
  return DateTime.utc(
        capture.year,
        capture.month,
        capture.day,
      ).difference(DateTime.utc(birth.year, birth.month, birth.day)).inDays +
      1;
}

/// 只比较有效的 128 维人物特征，不把照片内容指纹当成人物身份。
double cosineSimilarity(List<double> left, List<double> right) {
  if (left.length != 128 || right.length != 128) return -1;
  var product = 0.0, leftNorm = 0.0, rightNorm = 0.0;
  for (var index = 0; index < left.length; index++) {
    if (!left[index].isFinite || !right[index].isFinite) return -1;
    product += left[index] * right[index];
    leftNorm += left[index] * left[index];
    rightNorm += right[index] * right[index];
  }
  if (leftNorm <= 0 || rightNorm <= 0) return -1;
  return (product / sqrt(leftNorm * rightNorm)).clamp(-1.0, 1.0);
}

/// 高置信自动归类，较弱匹配留给用户确认；不改变用户手动决定。
String? recognitionState(double score) => score >= 0.65
    ? 'included'
    : score >= 0.4
    ? 'candidate'
    : null;

/// 从已确认的拍摄日期生成可选成长信息。
String watermarkText(
  BabyProfile baby,
  String date, {
  bool showName = true,
  bool showAge = true,
  bool showDays = false,
  bool showDate = true,
  String template = 'classic',
  String growthMode = 'auto',
}) => template == 'growth'
    ? [
        [
          if (showName) baby.name,
          growthWatermarkLabel(baby.birthday, date, mode: growthMode),
        ].join(' · '),
        if (showDate) date.replaceAll('-', ' · '),
      ].join('\n')
    : [
        if (showName) baby.name,
        if (showAge) ageAt(baby.birthday, date),
        if (showDays && dayCountAt(baby.birthday, date) > 0)
          '出生第 ${dayCountAt(baby.birthday, date)} 天',
        if (showDate) date,
      ].join(' · ');

/// 成长文字使用日历月与自然日，出生当天为第 1 天，整周年沿用月底夹取规则。
String growthWatermarkLabel(
  String birthday,
  String date, {
  String mode = 'auto',
}) {
  final age = _calendarAge(birthday, date);
  if (age == null) return '出生前';
  if (mode == 'day-count') return '出生第 ${dayCountAt(birthday, date)} 天';
  final months = age.months, days = age.days;
  if (months == 0) return '出生第 ${dayCountAt(birthday, date)} 天';
  final years = months ~/ 12, remaining = months % 12;
  if (years > 0 && remaining == 0 && days == 0) return '$years 岁啦';
  return [
    if (years > 0) '$years 岁',
    if (remaining > 0) '$remaining 个月',
    if (days > 0) '$days 天',
  ].join(' ');
}
