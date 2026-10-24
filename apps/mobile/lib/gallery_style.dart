import 'dart:math' as math;
import 'package:flutter/material.dart';

/// 奶油白与柔粉色共用色板，浅色装饰和深色操作文字分别管理。
const galleryAccent = Color(0xFF7C6255);
const galleryAccentPressed = Color(0xFF674F42);
const galleryPrimary = Color(0xFFFFE2CD);
const galleryOnPrimary = Color(0xFF674F42);
const galleryAccentIndicator = Color(0xFFB9836E);
const gallerySoftPink = Color(0xFFF1BACC);
const galleryInk = Color(0xFF675C55);
const galleryMuted = Color(0xFF806F64);
const galleryBackground = Color(0xFFFFF9F2);
const gallerySurface = Color(0xFFFFFEFC);
const gallerySelected = Color(0xFFFFEBDD);
const galleryLine = Color(0xFFEEE4DC);
const galleryPeach = Color(0xFFFFF0DC);
const galleryError = Color(0xFFA55950);
const galleryPreview = Color(0xFFFFFBF6);
const galleryPreviewTransparent = Color(0x00FFFBF6);
const galleryPhotoBadge = Color(0xF5FFFBF6);
const gallerySuccess = Color(0xFF47745A);
const transferPending = Color(0xFF8C7C72);

/// 三个模块共用简单线图标，选中时只改变颜色。
class GalleryModuleIcon extends StatelessWidget {
  const GalleryModuleIcon(this.module, {super.key, this.selected = false});
  final int module;
  final bool selected;
  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 24,
    child: CustomPaint(
      painter: _ModulePainter(module, selected ? galleryAccent : galleryMuted),
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
