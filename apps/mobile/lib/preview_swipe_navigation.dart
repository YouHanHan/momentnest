import 'dart:async';
import 'package:flutter/material.dart';

/// 普通预览共用切图手势，双指缩放和放大拖动不触发切换。
class PreviewSwipeNavigation extends StatefulWidget {
  const PreviewSwipeNavigation({
    super.key,
    required this.transform,
    required this.onMove,
    required this.child,
    this.enabled = true,
    this.canMove,
  });

  final TransformationController transform;
  final FutureOr<bool> Function(int delta) onMove;
  final Widget child;
  final bool enabled;
  final bool Function(int delta)? canMove;

  @override
  State<PreviewSwipeNavigation> createState() => _PreviewSwipeNavigationState();
}

class _PreviewSwipeNavigationState extends State<PreviewSwipeNavigation>
    with SingleTickerProviderStateMixin {
  final pointers = <int>{};
  int? swipePointer;
  Offset travel = Offset.zero;
  double offset = 0;
  bool settling = false, waiting = false;
  late final AnimationController motion;
  Animation<double>? movement;

  @override
  void initState() {
    super.initState();
    motion = AnimationController(vsync: this)
      ..addListener(() {
        if (mounted) setState(() => offset = movement!.value);
      });
  }

  @override
  void dispose() {
    motion.dispose();
    super.dispose();
  }

  bool get canSwipe =>
      widget.enabled &&
      !settling &&
      widget.transform.value.getMaxScaleOnAxis() <= 1.01;

  /// 复用当前原文件画面做位移动画，不生成降采样过渡图。
  Future<void> animateTo(double target, int milliseconds) async {
    if (!mounted) return;
    if (MediaQuery.disableAnimationsOf(context)) {
      setState(() => offset = target);
      return;
    }
    movement = Tween<double>(
      begin: offset,
      end: target,
    ).animate(CurvedAnimation(parent: motion, curve: Curves.easeOutCubic));
    motion.duration = Duration(milliseconds: milliseconds);
    await motion.forward(from: 0).orCancel;
  }

  /// 达到阈值后滑出，切换当前页后滑入；边界与短滑平滑回弹。
  Future<void> finishSwipe(int? delta) async {
    if (settling) return;
    settling = true;
    try {
      if (delta == null || widget.canMove?.call(delta) == false) {
        await animateTo(0, 180);
        return;
      }
      final width = MediaQuery.sizeOf(context).width;
      await animateTo(-delta * width, 120);
      if (!mounted) return;
      setState(() => waiting = true);
      final moved = await widget.onMove(delta);
      if (!mounted) return;
      setState(() {
        waiting = false;
        if (moved) offset = delta * width;
      });
      await animateTo(0, 180);
    } on TickerCanceled {
      // 页面退出时取消过渡，不再刷新已释放的画面。
    } finally {
      if (mounted) {
        setState(() {
          settling = false;
          waiting = false;
        });
      }
    }
  }

  @override
  Widget build(BuildContext context) => Listener(
    behavior: HitTestBehavior.opaque,
    onPointerDown: (event) {
      pointers.add(event.pointer);
      swipePointer = pointers.length == 1 && canSwipe ? event.pointer : null;
      travel = Offset.zero;
      if (pointers.length > 1 && offset != 0) {
        swipePointer = null;
        unawaited(finishSwipe(null));
      }
    },
    onPointerMove: (event) {
      if (swipePointer != event.pointer || !canSwipe) return;
      travel += event.delta;
      if (travel.dx.abs() > travel.dy.abs() * 1.5) {
        final delta = travel.dx < 0 ? 1 : -1;
        final distance = widget.canMove?.call(delta) == false
            ? travel.dx * 0.2
            : travel.dx;
        final width = MediaQuery.sizeOf(context).width;
        setState(() => offset = distance.clamp(-width, width));
      }
    },
    onPointerCancel: (event) {
      pointers.remove(event.pointer);
      swipePointer = null;
      if (offset != 0) unawaited(finishSwipe(null));
    },
    onPointerUp: (event) {
      final shouldMove =
          swipePointer == event.pointer &&
          canSwipe &&
          travel.dx.abs() > 45 &&
          travel.dx.abs() > travel.dy.abs() * 1.5;
      pointers.remove(event.pointer);
      swipePointer = null;
      if (!settling && (shouldMove || offset != 0)) {
        unawaited(finishSwipe(shouldMove ? (travel.dx < 0 ? 1 : -1) : null));
      }
    },
    child: ClipRect(
      child: Stack(
        fit: StackFit.expand,
        children: [
          Transform.translate(
            key: const ValueKey('preview-swipe-offset'),
            offset: Offset(offset, 0),
            child: widget.child,
          ),
          if (waiting) const Center(child: CircularProgressIndicator()),
        ],
      ),
    ),
  );
}
