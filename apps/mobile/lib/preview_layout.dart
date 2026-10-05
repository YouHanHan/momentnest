import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

/// 原文件铺满预览区域，工具浮在画面上，点图可收起与恢复。
class PreviewLayout extends StatefulWidget {
  const PreviewLayout({
    super.key,
    required this.topBar,
    required this.canvas,
    this.bottomBar,
    this.canHideControls = true,
  });

  final PreferredSizeWidget topBar;
  final Widget canvas;
  final Widget? bottomBar;
  final bool canHideControls;

  @override
  State<PreviewLayout> createState() => _PreviewLayoutState();
}

class _PreviewLayoutState extends State<PreviewLayout> {
  bool controlsVisible = true;

  @override
  void didUpdateWidget(PreviewLayout oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (!widget.canHideControls) controlsVisible = true;
  }

  @override
  Widget build(BuildContext context) => AnnotatedRegion<SystemUiOverlayStyle>(
    value: SystemUiOverlayStyle.light,
    child: Scaffold(
      backgroundColor: const Color(0xFF191816),
      extendBodyBehindAppBar: true,
      appBar: controlsVisible ? widget.topBar : null,
      body: Stack(
        fit: StackFit.expand,
        children: [
          GestureDetector(
            behavior: HitTestBehavior.opaque,
            onTap: widget.canHideControls
                ? () => setState(() => controlsVisible = !controlsVisible)
                : null,
            child: widget.canvas,
          ),
          if (controlsVisible) ...[
            Positioned(
              left: 0,
              right: 0,
              top: 0,
              height:
                  MediaQuery.paddingOf(context).top +
                  widget.topBar.preferredSize.height +
                  16,
              child: const IgnorePointer(
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.black87, Colors.transparent],
                    ),
                  ),
                ),
              ),
            ),
            if (widget.bottomBar != null)
              Positioned(
                key: const ValueKey('preview-bottom-overlay'),
                left: 0,
                right: 0,
                bottom: 0,
                child: DecoratedBox(
                  decoration: const BoxDecoration(
                    gradient: LinearGradient(
                      begin: Alignment.topCenter,
                      end: Alignment.bottomCenter,
                      colors: [Colors.transparent, Colors.black87],
                      stops: [0, 0.35],
                    ),
                  ),
                  child: SafeArea(
                    top: false,
                    child: Padding(
                      padding: const EdgeInsets.fromLTRB(8, 16, 8, 8),
                      child: widget.bottomBar!,
                    ),
                  ),
                ),
              ),
          ],
        ],
      ),
    ),
  );
}
