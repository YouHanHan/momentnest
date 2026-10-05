import 'dart:math' as math;
import 'package:flutter/material.dart';

const galleryGreen = Color(0xFF3B755C);
const galleryInk = Color(0xFF232B27);
const galleryMuted = Color(0xFF718078);
const galleryBackground = Color(0xFFFEFEFE);
const gallerySelected = Color(0xFFEDF2F0);
const transferPending = Color(0xFF78909C);

/// 三个模块共用简单线图标，选中时只改变颜色。
class GalleryModuleIcon extends StatelessWidget {
  const GalleryModuleIcon(this.module, {super.key, this.selected = false});
  final int module;
  final bool selected;
  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 24,
    child: CustomPaint(
      painter: _ModulePainter(module, selected ? galleryGreen : galleryMuted),
    ),
  );
}

class _ModulePainter extends CustomPainter {
  _ModulePainter(this.module, this.color);
  final int module;
  final Color color;
  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()
      ..color = color
      ..style = PaintingStyle.stroke
      ..strokeWidth = 1.8
      ..strokeCap = StrokeCap.round
      ..strokeJoin = StrokeJoin.round;
    if (module == 0) {
      canvas.drawRRect(
        RRect.fromRectAndRadius(
          const Rect.fromLTWH(2, 3, 20, 18),
          const Radius.circular(2),
        ),
        paint,
      );
      canvas.drawCircle(const Offset(8, 8), 1.2, paint);
      canvas.drawPath(
        Path()
          ..moveTo(5, 17)
          ..lineTo(10, 12)
          ..lineTo(13, 15)
          ..lineTo(16, 11)
          ..lineTo(20, 17),
        paint,
      );
    } else if (module == 1) {
      canvas.drawCircle(const Offset(12, 12), 9, paint);
      canvas.drawCircle(
        const Offset(8.5, 10),
        .7,
        paint..style = PaintingStyle.fill,
      );
      canvas.drawCircle(const Offset(15.5, 10), .7, paint);
      paint.style = PaintingStyle.stroke;
      canvas.drawArc(
        const Rect.fromLTWH(7, 10, 10, 8),
        .2,
        math.pi - .4,
        false,
        paint,
      );
    } else {
      canvas.drawPath(
        Path()
          ..moveTo(3, 7)
          ..lineTo(21, 7)
          ..moveTo(17, 3)
          ..lineTo(21, 7)
          ..lineTo(17, 11)
          ..moveTo(21, 17)
          ..lineTo(3, 17)
          ..moveTo(7, 13)
          ..lineTo(3, 17)
          ..lineTo(7, 21),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(_ModulePainter oldDelegate) =>
      oldDelegate.module != module || oldDelegate.color != color;
}

/// 日期分组使用自然日；未知日期单独展示。
String mediaDateHeading(String? value, {DateTime? now}) {
  final date = DateTime.tryParse(value ?? '');
  if (date == null) return '日期待确认';
  final today = now ?? DateTime.now();
  if (date.year == today.year &&
      date.month == today.month &&
      date.day == today.day) {
    return '今天';
  }
  return '${date.year}年${date.month}月${date.day}日';
}
