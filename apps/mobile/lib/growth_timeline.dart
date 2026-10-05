import 'dart:math';
import 'models.dart';

/// 月末生日按目标月最后一天取周年日，保持与月龄计算一致。
DateTime growthAnniversary(String birthday, int months) {
  final birth = DateTime.parse(birthday);
  final start = DateTime.utc(birth.year, birth.month + months);
  final end = DateTime.utc(start.year, start.month + 1, 0);
  return DateTime.utc(start.year, start.month, min(birth.day, end.day));
}

/// 只有调用方已确认的实际拍摄日才用于成长月份筛选。
int? growthMonth(String birthday, String? date) {
  final value = DateTime.tryParse(date ?? '');
  if (value == null) return null;
  final birth = DateTime.parse(birthday);
  final day = DateTime.utc(value.year, value.month, value.day);
  if (day.isBefore(growthAnniversary(birthday, 0))) return null;
  var month = (value.year - birth.year) * 12 + value.month - birth.month;
  if (day.isBefore(growthAnniversary(birthday, month))) month--;
  return month;
}

String growthRange(String birthday, int months) {
  final first = growthAnniversary(birthday, months);
  final last = growthAnniversary(birthday, months + 1).subtract(const Duration(days: 1));
  return '${dateLabel(first)} – ${dateLabel(last)}';
}
