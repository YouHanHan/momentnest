import 'dart:async';
import 'package:flutter/material.dart';

/// 年份查询与相册列表分开，只在选择月份时读取日期范围。
class GalleryYearField extends StatefulWidget {
  const GalleryYearField({
    super.key,
    required this.initialYear,
    required this.loadYears,
    required this.onChanged,
  });

  final int initialYear;
  final Future<List<int>> Function() loadYears;
  final ValueChanged<int> onChanged;

  @override
  State<GalleryYearField> createState() => _GalleryYearFieldState();
}

class _GalleryYearFieldState extends State<GalleryYearField> {
  bool _loading = true, _failed = false, _empty = false;
  List<int> _years = [];
  late int _year = widget.initialYear;

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  /// 读取失败可重试，关闭选择框后忽略迟到结果。
  Future<void> _load() async {
    setState(() {
      _loading = true;
      _failed = false;
    });
    try {
      final years = await widget.loadYears();
      if (!mounted) return;
      _empty = years.isEmpty;
      _years = years.isEmpty ? [_year] : years;
      if (!_years.contains(_year)) _year = _years.first;
      setState(() => _loading = false);
      widget.onChanged(_year);
    } catch (_) {
      if (mounted) {
        setState(() {
          _loading = false;
          _failed = true;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    if (_loading) {
      return const Row(
        children: [
          SizedBox(
            width: 18,
            height: 18,
            child: CircularProgressIndicator(strokeWidth: 2),
          ),
          SizedBox(width: 12),
          Expanded(child: Text('正在读取相册年份…')),
        ],
      );
    }
    if (_failed) {
      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Text('暂时无法读取相册年份。'),
          TextButton(onPressed: _load, child: const Text('重新读取年份')),
        ],
      );
    }
    return DropdownButtonFormField<int>(
      initialValue: _year,
      isExpanded: true,
      decoration: InputDecoration(
        labelText: '年份',
        helperText: _empty ? '未找到有日期的媒体，保留所选年份' : null,
      ),
      items: [
        for (final year in _years)
          DropdownMenuItem(value: year, child: Text('$year年')),
      ],
      onChanged: (year) {
        if (year != null) {
          _year = year;
          widget.onChanged(year);
        }
      },
    );
  }
}
