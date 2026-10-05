import 'package:flutter/material.dart';

/// 仅在当前图片坐标中叠加成长文字，缩放随图移动，不生成或修改文件。
class GrowthWatermarkOverlay extends StatelessWidget {
  const GrowthWatermarkOverlay({super.key, required this.text});
  final String text;

  @override
  Widget build(BuildContext context) => IgnorePointer(
    child: LayoutBuilder(
      builder: (_, constraints) {
        final size = (constraints.maxWidth * 0.05).clamp(10.0, 30.0);
        final inset = (constraints.maxWidth * 0.04).clamp(5.0, 24.0);
        final lines = text.split('\n');
        return Stack(
          children: [
            Positioned(
              left: 0,
              right: 0,
              bottom: 0,
              height: (size * 4 + inset * 2).clamp(0.0, constraints.maxHeight),
              child: const DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [Colors.transparent, Color(0x70000000)],
                  ),
                ),
              ),
            ),
            Positioned(
              left: inset,
              right: inset,
              bottom: inset,
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  FittedBox(
                    fit: BoxFit.scaleDown,
                    alignment: Alignment.centerLeft,
                    child: Text(
                      lines.first,
                      maxLines: 1,
                      style: TextStyle(
                        color: Colors.white,
                        fontSize: size,
                        fontWeight: FontWeight.w700,
                        height: 1.3,
                        shadows: const [
                          Shadow(color: Colors.black38, blurRadius: 3),
                        ],
                      ),
                    ),
                  ),
                  if (lines.length > 1) ...[
                    SizedBox(height: size * 0.2),
                    FittedBox(
                      fit: BoxFit.scaleDown,
                      alignment: Alignment.centerLeft,
                      child: Text(
                        lines[1],
                        maxLines: 1,
                        style: TextStyle(
                          color: Colors.white,
                          fontSize: (size * 0.65).clamp(8.0, 20.0),
                          letterSpacing: 0.6,
                          height: 1.3,
                        ),
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ],
        );
      },
    ),
  );
}
