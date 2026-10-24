import 'dart:async';
import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'gallery_style.dart';
import 'package:video_player/video_player.dart';
import 'family_controller.dart';
import 'family_models.dart';
import 'models.dart';
import 'growth_watermark_screen.dart';
import 'growth_watermark_overlay.dart';
import 'preview_swipe_navigation.dart';
import 'preview_layout.dart';
export 'growth_watermark_screen.dart';

enum _PreviewTool {
  included,
  excluded,
  reference,
  watermark,
  information,
  transfer,
}

/// 原文件预览、宝宝归类和参考人脸选择共用同一份内容记录。
class MediaPreview extends StatefulWidget {
  const MediaPreview({
    super.key,
    required this.controller,
    required this.asset,
    this.baby,
    this.onTransfer,
    this.onTransferAsset,
    this.sequence = const [],
    this.selectReference = false,
  });
  final FamilyController controller;
  final FamilyAsset asset;
  final BabyProfile? baby;
  final VoidCallback? onTransfer;
  final ValueChanged<FamilyAsset>? onTransferAsset;
  final List<FamilyAsset> sequence;
  final bool selectReference;
  @override
  State<MediaPreview> createState() => _MediaPreviewState();
}

class _MediaPreviewState extends State<MediaPreview> {
  File? file;
  VideoPlayerController? player;
  String error = '', actionError = '', feedback = '', busyMessage = '';
  bool busy = false, loading = true, selectingFaces = false;
  bool referencePending = false;
  // 普通预览每次先显示原图，水印只在当前照片主动开启。
  // 现按全局水印开关统一显示，打开或切图不再重置单张状态。
  bool get previewWatermark =>
      baby != null && widget.controller.growthWatermarkVisible(baby!.id);
  Timer? busyTimer;
  int busySeconds = 0;
  int? faceIndex;
  int index = 0, epoch = 0;
  final transform = TransformationController();
  late final List<FamilyAsset> sequence;
  FamilyAsset get asset =>
      widget.controller.assets[sequence[index].id] ?? sequence[index];
  BabyProfile? get baby =>
      widget.controller.babies[widget.baby?.id] ?? widget.baby;
  StateSetter? sheetUpdate;

  @override
  void initState() {
    super.initState();
    referencePending = widget.selectReference;
    sequence = widget.sequence.isEmpty
        ? [widget.asset]
        : List.of(widget.sequence);
    index = sequence.indexWhere((item) => item.id == widget.asset.id);
    if (index < 0) {
      sequence.insert(0, widget.asset);
      index = 0;
    }
    widget.controller.addListener(recordsChanged);
    unawaited(load());
  }

  void recordsChanged() {
    if (!mounted) return;
    setState(() {});
    sheetUpdate?.call(() {});
  }

  /// 切换照片后隔离旧读取与视频初始化，迟到结果不会覆盖当前画面。
  Future<void> load() async {
    final request = ++epoch, current = asset;
    final previous = player;
    setState(() {
      loading = true;
      error = '';
      file = null;
      player = null;
      faceIndex = null;
      selectingFaces = false;
      transform.value = Matrix4.identity();
    });
    await previous?.dispose();
    VideoPlayerController? pending;
    try {
      final value = await widget.controller.fileFor(current);
      if (!mounted || request != epoch) return;
      if (value != null && current.kind == 'video') {
        pending = VideoPlayerController.file(value);
        await pending.initialize();
      }
      if (!mounted || request != epoch) {
        await pending?.dispose();
        return;
      }
      setState(() {
        file = value;
        player = pending;
      });
    } catch (failure) {
      await pending?.dispose();
      if (mounted && request == epoch) {
        setState(() => error = widget.controller.transfer.explain(failure));
      }
    } finally {
      if (mounted && request == epoch) {
        setState(() => loading = false);
        if (referencePending && file != null) {
          referencePending = false;
          unawaited(startReference());
        }
      }
    }
  }

  @override
  void dispose() {
    epoch++;
    busyTimer?.cancel();
    widget.controller.removeListener(recordsChanged);
    player?.dispose();
    transform.dispose();
    super.dispose();
  }

  Future<void> work(
    Future<void> Function() action, {
    String message = '',
  }) async {
    if (busy) return;
    final identity = asset.id;
    setState(() {
      busy = true;
      actionError = '';
      feedback = '';
      busyMessage = message;
      busySeconds = 0;
    });
    sheetUpdate?.call(() {});
    if (message.isNotEmpty) {
      busyTimer = Timer.periodic(const Duration(seconds: 1), (timer) {
        if (!mounted || asset.id != identity) {
          timer.cancel();
          return;
        }
        setState(() => busySeconds = timer.tick);
      });
    }
    try {
      await action();
    } catch (failure) {
      if (mounted && asset.id == identity) {
        setState(
          () => actionError = widget.controller.transfer.explain(failure),
        );
      }
    } finally {
      busyTimer?.cancel();
      busyTimer = null;
      if (mounted && asset.id == identity) {
        setState(() {
          busy = false;
          busyMessage = '';
        });
        sheetUpdate?.call(() {});
      }
    }
  }

  /// 在耗时步骤前先显示当前阶段，避免等待时只有无变化的画面。
  Future<void> showBusyMessage(String message) async {
    if (!mounted) return;
    setState(() => busyMessage = message);
    sheetUpdate?.call(() {});
    await WidgetsBinding.instance.endOfFrame;
  }

  Future<bool> move(int delta) async {
    final next = index + delta;
    if (busy || next < 0 || next >= sequence.length) return false;
    setState(() {
      index = next;
      actionError = '';
      feedback = '';
    });
    unawaited(load());
    return true;
  }

  Future<void> chooseFace(int selected) async {
    if (busy ||
        selected < 0 ||
        selected >= asset.faces.length ||
        !widget.controller.canReferenceFace(asset.faces[selected])) {
      return;
    }
    setState(() => faceIndex = selected);
    final frame = asset.faces[selected]['frameTime'];
    if (player != null && frame is num && frame.isFinite && frame >= 0) {
      await player!.pause();
      await player!.seekTo(Duration(milliseconds: (frame * 1000).round()));
    }
  }

  /// 参考入口自动检测；旧缓存缺少可用特征时重新读取原文件。
  Future<void> startReference({bool reanalyze = false}) async {
    if (baby == null || busy || loading) return;
    await work(() async {
      if (reanalyze ||
          asset.faces.isEmpty ||
          asset.faces.any(
            (face) => !widget.controller.canReferenceFace(face),
          )) {
        if (file == null) throw StateError('本机原文件暂不可读，请检查相册权限或重新选择照片。');
        faceIndex = null;
        await showBusyMessage(
          asset.kind == 'video'
              ? '正在读取视频并检测 4 个采样帧…'
              : '正在读取照片并检测人脸，首次处理可能需要等待…',
        );
        await widget.controller.analyze(asset);
        await showBusyMessage('正在保存检测结果，相册记录较多时需要等待…');
        await widget.controller.persist();
      }
      if (!mounted) return;
      setState(() {
        selectingFaces = true;
        faceIndex = null;
      });
      if (!asset.faces.any(widget.controller.canReferenceFace)) {
        feedback = '未检测到可用人脸，请换一张清晰正面照片，或重新检测。';
      }
    }, message: '正在准备人脸选择…');
  }

  Future<void> saveReference() async {
    final selected = faceIndex, current = asset, profile = baby;
    if (selected == null ||
        selected >= current.faces.length ||
        profile == null) {
      return;
    }
    await work(() async {
      await widget.controller.reference(
        profile,
        current,
        current.faces[selected],
      );
      if (!mounted || asset.id != current.id) return;
      if (widget.selectReference) {
        Navigator.pop(context, true);
        return;
      }
      setState(() {
        feedback = '已确认并设为参考。${widget.controller.notice}';
        selectingFaces = false;
        faceIndex = null;
      });
    }, message: '正在保存人脸参考…');
  }

  Widget content() {
    if (loading) return const Center(child: CircularProgressIndicator());
    if (error.isNotEmpty) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                error,
                textAlign: TextAlign.center,
                style: const TextStyle(color: galleryMuted),
              ),
              TextButton(onPressed: () => load(), child: const Text('重试预览')),
            ],
          ),
        ),
      );
    }
    if (file == null) {
      return Center(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (asset.thumbnailPath != null)
                Flexible(
                  child: Image.file(
                    File(asset.thumbnailPath!),
                    fit: BoxFit.contain,
                    errorBuilder: (_, _, _) =>
                        const Icon(Icons.image_outlined, color: galleryMuted),
                  ),
                ),
              const SizedBox(height: 12),
              Text(
                asset.data['_changedLocalVersion'] == true
                    ? '手机原文件已变更，请回到手机相册重新选择照片。'
                    : '本机原文件暂不可读，请检查相册权限，并确认照片仍在手机相册中。',
                textAlign: TextAlign.center,
                style: const TextStyle(color: galleryMuted),
              ),
              const SizedBox(height: 12),
              FilledButton.icon(
                onPressed: busy ? null : load,
                icon: const Icon(Icons.refresh),
                label: const Text('重新读取本机照片'),
              ),
            ],
          ),
        ),
      );
    }
    if (player != null) {
      return Center(
        child: AspectRatio(
          aspectRatio: player!.value.aspectRatio,
          child: Stack(
            fit: StackFit.expand,
            children: [
              VideoPlayer(player!),
              ValueListenableBuilder<VideoPlayerValue>(
                valueListenable: player!,
                builder: (_, value, _) {
                  final frame =
                      faceIndex == null || faceIndex! >= asset.faces.length
                      ? null
                      : asset.faces[faceIndex!]['frameTime'] as num?;
                  return selectingFaces &&
                          frame != null &&
                          !value.isPlaying &&
                          (value.position.inMilliseconds - frame * 1000).abs() <
                              350
                      ? faceLayer(video: true)
                      : const SizedBox.shrink();
                },
              ),
            ],
          ),
        ),
      );
    }
    return LayoutBuilder(
      builder: (_, constraints) {
        final profile = baby;
        final displayText =
            !selectingFaces && profile != null && previewWatermark
            ? growthWatermarkDisplayText(
                asset,
                profile,
                widget.controller.decision(profile.id, asset.id),
              )
            : null;
        final width = (asset.data['width'] as num?)?.toDouble() ?? 1;
        final height = (asset.data['height'] as num?)?.toDouble() ?? 1;
        final ratio = width > 0 && height > 0 ? width / height : 1.0;
        final fittedWidth = math.min(
          constraints.maxWidth,
          constraints.maxHeight * ratio,
        );
        return InteractiveViewer(
          transformationController: transform,
          minScale: 1,
          maxScale: 5,
          child: Center(
            child: SizedBox(
              width: fittedWidth,
              height: fittedWidth / ratio,
              child: Stack(
                fit: StackFit.expand,
                children: [
                  Image.file(
                    file!,
                    fit: BoxFit.contain,
                    frameBuilder: (_, child, frame, synchronous) => Stack(
                      fit: StackFit.expand,
                      children: [
                        child,
                        if (displayText != null &&
                            (frame != null || synchronous))
                          Positioned.fill(
                            child: GrowthWatermarkOverlay(
                              key: const ValueKey('preview-growth-overlay'),
                              text: displayText,
                            ),
                          ),
                      ],
                    ),
                    errorBuilder: (_, _, _) => const Center(
                      child: Text(
                        '系统暂无法预览此格式，原文件仍可完整传输。',
                        style: TextStyle(color: galleryMuted),
                      ),
                    ),
                  ),
                  if (selectingFaces) Positioned.fill(child: faceLayer()),
                ],
              ),
            ),
          ),
        );
      },
    );
  }

  /// 照片和暂停的视频帧使用相同的人脸框，多人画面可明确选择身份。
  Widget faceLayer({bool video = false}) => LayoutBuilder(
    builder: (_, constraints) => Stack(
      children: [
        for (var face = 0; face < asset.faces.length; face++)
          if (widget.controller.canReferenceFace(asset.faces[face]) &&
              (!video ||
                  (faceIndex != null &&
                      faceIndex! < asset.faces.length &&
                      asset.faces[face]['frameTime'] ==
                          asset.faces[faceIndex!]['frameTime'])))
            Positioned(
              left:
                  (asset.faces[face]['x'] as num).toDouble() *
                  constraints.maxWidth,
              top:
                  (asset.faces[face]['y'] as num).toDouble() *
                  constraints.maxHeight,
              width:
                  (asset.faces[face]['width'] as num).toDouble() *
                  constraints.maxWidth,
              height:
                  (asset.faces[face]['height'] as num).toDouble() *
                  constraints.maxHeight,
              child: GestureDetector(
                onTap: busy ? null : () => chooseFace(face),
                child: Container(
                  key: ValueKey('preview-face-$face'),
                  decoration: BoxDecoration(
                    border: Border.all(
                      color: faceIndex == face
                          ? gallerySoftPink
                          : Colors.white,
                      width: 2,
                    ),
                  ),
                  child: Align(
                    alignment: Alignment.topLeft,
                    child: ColoredBox(
                      color: Colors.black54,
                      child: Text(
                        '${face + 1}',
                        style: const TextStyle(color: Colors.white),
                      ),
                    ),
                  ),
                ),
              ),
            ),
      ],
    ),
  );

  /// 头像使用已有照片坐标裁切展示，不另存媒体文件。
  Widget faceAvatar(Json face) {
    final path = file?.path;
    final width = (asset.data['width'] as num?)?.toDouble() ?? 1;
    final height = (asset.data['height'] as num?)?.toDouble() ?? 1;
    final x = (face['x'] as num?)?.toDouble() ?? 0;
    final y = (face['y'] as num?)?.toDouble() ?? 0;
    final w = (face['width'] as num?)?.toDouble() ?? 0;
    final h = (face['height'] as num?)?.toDouble() ?? 0;
    if (asset.kind != 'photo' ||
        path == null ||
        width <= 0 ||
        height <= 0 ||
        w <= 0 ||
        h <= 0) {
      return const Icon(Icons.face_outlined);
    }
    final side = math.max(w * width, h * height) * 1.25;
    final scale = 42 / side;
    final left = ((x + w / 2) * width - side / 2) * scale;
    final top = ((y + h / 2) * height - side / 2) * scale;
    return ClipOval(
      child: SizedBox.square(
        dimension: 42,
        child: Stack(
          children: [
            Positioned(
              left: -left,
              top: -top,
              width: width * scale,
              height: height * scale,
              // 头像复用大图预览缓存，通过布局裁切照片。
              child: Image.file(
                File(path),
                fit: BoxFit.fill,
                errorBuilder: (_, _, _) => const Icon(Icons.face_outlined),
              ),
            ),
          ],
        ),
      ),
    );
  }

  Future<void> showInformation() async {
    await player?.pause();
    if (!mounted) return;
    await showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      isScrollControlled: true,
      builder: (sheetContext) => StatefulBuilder(
        builder: (_, update) {
          sheetUpdate = (action) {
            if (sheetContext.mounted) update(action);
          };
          final current = asset, profile = baby;
          final reason = profile == null
              ? null
              : watermarkUnavailableReason(current, profile);
          return SafeArea(
            child: SizedBox(
              height: MediaQuery.sizeOf(sheetContext).height * 0.68,
              child: ListView(
                padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
                children: [
                  Row(
                    children: [
                      const Expanded(
                        child: Text(
                          '照片信息',
                          style: TextStyle(
                            fontSize: 18,
                            fontWeight: FontWeight.w600,
                          ),
                        ),
                      ),
                      IconButton(
                        tooltip: '关闭信息',
                        onPressed: () => Navigator.pop(sheetContext),
                        icon: const Icon(Icons.close),
                      ),
                    ],
                  ),
                  Text(current.filename),
                  if (profile != null) ...[
                    Text(
                      '${profile.name} · ${babyStatusLabel(widget.controller.decisions['${profile.id}:${current.id}'])}${widget.controller.isReference(profile.id, current.id) ? ' · 已作参考' : ''}',
                    ),
                    if (widget.controller.reviewReason(profile.id, current) !=
                        null)
                      Text(
                        '待核对 · ${widget.controller.reviewReason(profile.id, current)}',
                      ),
                  ],
                  Text(
                    '${current.kind == 'video' ? '视频' : '照片'} · ${byteLabel(current.data['size'] as int? ?? 0)} · ${current.date ?? '日期未知'}',
                  ),
                  Text(
                    '日期来源：${{'manual': '人工确认', 'capture': '拍摄元数据', 'creation': '创建时间，待确认', 'unknown': '未知'}[current.data['dateSource']] ?? '未知'}',
                  ),
                  if (current.data['dateSource'] == 'creation')
                    const Text('此日期来自媒体创建时间，尚未确认拍摄日。月龄和水印请先确认日期。'),
                  if (profile != null &&
                      current.data['dateConfirmed'] == true &&
                      current.data['dateSource'] != 'creation' &&
                      current.date != null)
                    Text('拍摄月龄：${ageAt(profile.birthday, current.date!)}'),
                  TextButton.icon(
                    onPressed: busy
                        ? null
                        : () async {
                            final date = await showDatePicker(
                              context: context,
                              initialDate:
                                  DateTime.tryParse(current.date ?? '') ??
                                  DateTime.now(),
                              firstDate: DateTime(1900),
                              lastDate: DateTime(2100),
                            );
                            if (date != null) {
                              await work(
                                () => widget.controller.setDate(
                                  current,
                                  dateLabel(date),
                                ),
                              );
                            }
                          },
                    icon: const Icon(Icons.event_outlined),
                    label: const Text('确认或修改拍摄日期'),
                  ),
                  const Divider(),
                  Text(
                    '人脸分析：${{'pending': '尚未分析', 'error': '失败', 'done': current.faces.isEmpty ? '已分析，未检测到人脸' : '已分析，${current.faces.length} 张脸'}[current.data['faceState']] ?? '尚未分析'}',
                  ),
                  if (current.data['faceError'] != null)
                    Text(current.data['faceError'] as String),
                  if (current.kind == 'video')
                    const Text('视频仅分析 4 个采样帧，未命中不代表视频中没有宝宝。选头像可跳到检测帧。'),
                  OutlinedButton.icon(
                    onPressed: busy || file == null
                        ? null
                        : () => work(() async {
                            faceIndex = null;
                            await widget.controller.analyze(current);
                            await widget.controller.persist();
                          }),
                    icon: const Icon(Icons.face_outlined),
                    label: Text(
                      current.kind == 'video' ? '离线分析 4 帧人脸' : '离线分析人脸',
                    ),
                  ),
                  if (profile != null && current.kind == 'photo') ...[
                    const SizedBox(height: 12),
                    if (reason != null) Text(reason),
                    OutlinedButton.icon(
                      key: const ValueKey('preview-watermark'),
                      onPressed: busy || file == null || reason != null
                          ? null
                          : () {
                              Navigator.pop(sheetContext);
                              Navigator.push<void>(
                                context,
                                MaterialPageRoute(
                                  builder: (_) => WatermarkScreen(
                                    asset: current,
                                    baby: profile,
                                    file: file!,
                                    controller: widget.controller,
                                  ),
                                ),
                              );
                            },
                      icon: const Icon(Icons.auto_awesome_outlined),
                      label: const Text('制作成长水印副本'),
                    ),
                  ],
                  if (actionError.isNotEmpty)
                    Text(
                      actionError,
                      style: const TextStyle(color: galleryError),
                    ),
                  if (busy) const LinearProgressIndicator(),
                  const SizedBox(height: 12),
                  const Text('归类记录不会生成电脑保存回执。水印副本另存，原文件保留。'),
                  for (final location
                      in (current.data['locations'] as List? ?? []).where(
                        (value) => (value as Map)['source'] == 'phone',
                      ))
                    Text(
                      '${(location as Map)['label']} · ${location['available'] == true ? '可用' : '暂不可用'}',
                    ),
                ],
              ),
            ),
          );
        },
      ),
    );
    sheetUpdate = null;
  }

  /// 普通预览与选脸都保留播放控制，暂停视频后可查看对应检测帧。
  Widget playbackButton() => ValueListenableBuilder<VideoPlayerValue>(
    valueListenable: player!,
    builder: (_, value, _) => IconButton(
      color: galleryInk,
      tooltip: '播放或暂停',
      onPressed: () => value.isPlaying ? player!.pause() : player!.play(),
      icon: Icon(value.isPlaying ? Icons.pause_circle : Icons.play_circle),
    ),
  );

  /// 低频操作按需展开，沿用当前照片的归属、参考、水印与传输流程。
  Future<void> useTool(_PreviewTool tool) async {
    if (busy) return;
    final current = asset, profile = baby;
    switch (tool) {
      case _PreviewTool.included:
      case _PreviewTool.excluded:
        if (profile == null) return;
        await work(
          () => widget.controller.decide(
            profile.id,
            current.id,
            tool == _PreviewTool.included ? 'included' : 'excluded',
          ),
        );
      case _PreviewTool.reference:
        await startReference();
      case _PreviewTool.watermark:
        if (profile == null) return;
        await work(
          () => widget.controller.setGrowthWatermarkDisplay(
            profile.id,
            !previewWatermark,
          ),
        );
      case _PreviewTool.information:
        await showInformation();
      case _PreviewTool.transfer:
        if (current.localId == null) return;
        Navigator.pop(context);
        if (widget.onTransferAsset != null) {
          widget.onTransferAsset!(current);
        } else {
          widget.onTransfer?.call();
        }
    }
  }

  /// 菜单文字可随系统字号换行，操作保留至少 48 像素触控高度。
  PopupMenuItem<_PreviewTool> toolItem(
    _PreviewTool value,
    String key,
    IconData icon,
    String label, {
    bool enabled = true,
  }) => PopupMenuItem(
    key: ValueKey(key),
    value: value,
    enabled: enabled,
    child: Row(
      children: [
        Icon(
          icon,
          size: 22,
          color: enabled
              ? Theme.of(context).colorScheme.onSurface
              : Theme.of(context).disabledColor,
        ),
        const SizedBox(width: 12),
        Expanded(child: Text(label)),
      ],
    ),
  );

  @override
  Widget build(BuildContext context) {
    final profile = baby;
    final status = profile == null
        ? ''
        : babyStatusLabel(
            widget.controller.decisions['${profile.id}:${asset.id}'],
          );
    return PreviewLayout(
      canHideControls: !busy && !selectingFaces && !referencePending,
      topBar: AppBar(
        toolbarHeight: (MediaQuery.textScalerOf(context).scale(28) * 1.5 + 8)
            .clamp(kToolbarHeight, double.infinity),
        backgroundColor: Colors.transparent,
        surfaceTintColor: Colors.transparent,
        elevation: 0,
        foregroundColor: galleryInk,
        leading: IconButton(
          tooltip: '返回相册',
          onPressed: () => Navigator.pop(context),
          icon: const Icon(Icons.arrow_back),
        ),
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              asset.filename,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 15, color: galleryInk),
            ),
            if (sequence.length > 1 || profile != null)
              Text(
                '${sequence.length > 1 ? '${index + 1} / ${sequence.length}' : ''}${profile != null ? '${sequence.length > 1 ? ' · ' : ''}${profile.name} · $status' : ''}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(color: galleryMuted, fontSize: 12),
              ),
          ],
        ),
        actions: [
          if (!selectingFaces && !widget.selectReference)
            IconButton(
              key: const ValueKey('preview-favorite'),
              tooltip: widget.controller.isFavorite(asset) ? '取消收藏' : '收藏',
              onPressed:
                  busy ||
                      !widget.controller.favorites.ready ||
                      widget.controller.favorites.saving
                  ? null
                  : () => work(() => widget.controller.toggleFavorite(asset)),
              icon: Icon(
                widget.controller.isFavorite(asset)
                    ? Icons.favorite
                    : Icons.favorite_outline,
              ),
            ),
          PopupMenuButton<_PreviewTool>(
            key: const ValueKey('preview-tools'),
            tooltip: '更多操作',
            enabled: !busy,
            icon: const Icon(Icons.more_horiz),
            onSelected: (tool) => unawaited(useTool(tool)),
            itemBuilder: (_) => [
              if (!selectingFaces && profile != null) ...[
                toolItem(
                  _PreviewTool.included,
                  'preview-included',
                  Icons.check_circle_outline,
                  '是宝宝',
                ),
                toolItem(
                  _PreviewTool.excluded,
                  'preview-excluded',
                  Icons.not_interested,
                  '不是宝宝',
                ),
                toolItem(
                  _PreviewTool.reference,
                  'preview-reference',
                  Icons.face_outlined,
                  '确认并设为参考',
                  enabled: !loading,
                ),
              ],
              if (!selectingFaces && profile != null && asset.kind == 'photo')
                toolItem(
                  _PreviewTool.watermark,
                  'preview-watermark-display',
                  previewWatermark
                      ? Icons.visibility_outlined
                      : Icons.visibility_off_outlined,
                  previewWatermark ? '隐藏水印' : '显示水印',
                ),
              toolItem(
                _PreviewTool.information,
                'preview-information',
                Icons.info_outline,
                '照片信息',
              ),
              if (!selectingFaces &&
                  (widget.onTransfer != null ||
                      widget.onTransferAsset != null) &&
                  asset.localId != null)
                toolItem(
                  _PreviewTool.transfer,
                  'preview-transfer',
                  Icons.computer_outlined,
                  '上传原文件到电脑',
                ),
            ],
          ),
        ],
      ),
      canvas: PreviewSwipeNavigation(
        key: const ValueKey('preview-canvas'),
        transform: transform,
        enabled: !busy && !selectingFaces && sequence.length > 1,
        canMove: (delta) =>
            index + delta >= 0 && index + delta < sequence.length,
        onMove: move,
        child: SizedBox.expand(child: content()),
      ),
      bottomBar:
          !busy &&
              !selectingFaces &&
              player == null &&
              actionError.isEmpty &&
              feedback.isEmpty &&
              busyMessage.isEmpty
          ? null
          : Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (busy) const LinearProgressIndicator(minHeight: 2),
                if (player != null) ...[
                  VideoProgressIndicator(player!, allowScrubbing: true),
                ],
                if (actionError.isNotEmpty || feedback.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 16,
                      vertical: 4,
                    ),
                    child: Text(
                      actionError.isNotEmpty ? actionError : feedback,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: actionError.isNotEmpty
                            ? galleryError
                            : galleryMuted,
                        fontSize: 12,
                      ),
                    ),
                  ),
                if (busyMessage.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.all(8),
                    child: Text(
                      '$busyMessage\n已等待 $busySeconds 秒',
                      style: const TextStyle(
                        color: galleryMuted,
                        fontSize: 12,
                      ),
                    ),
                  ),
                if (selectingFaces)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Row(
                          children: [
                            const Expanded(
                              child: Text(
                                '请选择宝宝对应的脸',
                                style: TextStyle(
                                  color: galleryMuted,
                                  fontSize: 12,
                                ),
                              ),
                            ),
                            if (player != null) playbackButton(),
                            TextButton(
                              onPressed: busy
                                  ? null
                                  : widget.selectReference
                                  ? () => Navigator.pop(context, false)
                                  : () => setState(() {
                                      selectingFaces = false;
                                      faceIndex = null;
                                    }),
                              child: Text(
                                widget.selectReference ? '换张照片' : '退出选脸',
                              ),
                            ),
                          ],
                        ),
                        if (!asset.faces.any(
                          widget.controller.canReferenceFace,
                        ))
                          TextButton.icon(
                            onPressed: busy
                                ? null
                                : () => startReference(reanalyze: true),
                            icon: const Icon(Icons.refresh),
                            label: const Text('重新检测人脸'),
                          )
                        else
                          SizedBox(
                            height: 66,
                            child: ListView(
                              scrollDirection: Axis.horizontal,
                              children: [
                                for (
                                  var face = 0;
                                  face < asset.faces.length;
                                  face++
                                )
                                  Padding(
                                    padding: const EdgeInsets.only(right: 6),
                                    child: ChoiceChip(
                                      avatar: faceAvatar(asset.faces[face]),
                                      label: Text(
                                        '人脸 ${face + 1}${asset.faces[face]['frameTime'] != null ? ' · ${asset.faces[face]['frameTime']} 秒' : ''}',
                                      ),
                                      selected: faceIndex == face,
                                      onSelected:
                                          busy ||
                                              !widget.controller
                                                  .canReferenceFace(
                                                    asset.faces[face],
                                                  )
                                          ? null
                                          : (_) => chooseFace(face),
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        FilledButton(
                          onPressed:
                              busy ||
                                  widget.controller.matching ||
                                  faceIndex == null ||
                                  faceIndex! >= asset.faces.length ||
                                  !widget.controller.canReferenceFace(
                                    asset.faces[faceIndex!],
                                  )
                              ? null
                              : saveReference,
                          child: const Text('将选中人脸设为宝宝参考'),
                        ),
                      ],
                    ),
                  ),
                if (!selectingFaces && player != null)
                  Row(
                    key: const ValueKey('preview-actions'),
                    mainAxisAlignment: MainAxisAlignment.spaceEvenly,
                    children: [playbackButton()],
                  ),
              ],
            ),
    );
  }
}
