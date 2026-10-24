import 'dart:async';
import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'family_controller.dart';
import 'family_models.dart';
import 'models.dart';
import 'gallery_style.dart';

/// 水印调整使用真实照片预览，导出路径与预览副本彼此独立。
class WatermarkScreen extends StatefulWidget {
  const WatermarkScreen({
    super.key,
    required this.asset,
    required this.baby,
    this.file,
    this.controller,
    this.sequence = const [],
  });
  final FamilyAsset asset;
  final BabyProfile baby;
  final File? file;
  final FamilyController? controller;
  final List<FamilyAsset> sequence;

  @override
  State<WatermarkScreen> createState() => _WatermarkScreenState();
}

class _WatermarkScreenState extends State<WatermarkScreen> {
  late final List<FamilyAsset> sequence;
  final files = <String, File>{};
  final failures = <({String filename, String reason})>[];
  Timer? debounce;
  int index = 0, version = 0, exported = 0, processed = 0;
  bool showName = false, showDate = true, shade = true;
  bool previewRunning = false, previewPending = false, exporting = false;
  bool previewFailed = false;
  String recordSignature = '';
  String mode = 'auto', position = 'bottom-left', color = '#FFFFFF';
  String notice = '';
  double fontSize = 48, opacity = 0.95;
  String? previewPath;
  FamilyAsset get asset =>
      widget.controller?.assets[sequence[index].id] ?? sequence[index];
  BabyProfile get baby =>
      widget.controller?.babies[widget.baby.id] ?? widget.baby;

  @override
  void initState() {
    super.initState();
    sequence = widget.sequence.isEmpty
        ? [widget.asset]
        : List.of(widget.sequence);
    index = sequence.indexWhere((item) => item.id == widget.asset.id);
    if (index < 0) {
      sequence.insert(0, widget.asset);
      index = 0;
    }
    if (widget.file != null) files[widget.asset.id] = widget.file!;
    recordSignature = signature();
    widget.controller?.addListener(recordsChanged);
    schedulePreview();
  }

  @override
  void dispose() {
    debounce?.cancel();
    widget.controller?.removeListener(recordsChanged);
    version++;
    super.dispose();
  }

  String signature() =>
      '${asset.id}:${asset.date}:${asset.data['dateConfirmed']}:${asset.data['dateSource']}:${asset.data['available']}:${baby.birthday}:${baby.name}:${widget.controller?.decision(baby.id, asset.id)}';

  /// 档案或日期在其他入口更新时丢弃旧水印，不因下载进度重复绘制。
  void recordsChanged() {
    if (!mounted || recordSignature == signature()) return;
    recordSignature = signature();
    setState(() => previewPath = null);
    schedulePreview();
  }

  /// 日期与归属校验只影响水印制作，不自动更改相册记录。
  String? unavailable(FamilyAsset item, BabyProfile profile) {
    final reason = watermarkUnavailableReason(item, profile);
    if (reason?.contains('早于出生日期') == true) {
      return '拍摄日期早于宝宝出生日期，请先修正日期。';
    }
    if (reason != null) return reason;
    if (widget.controller != null &&
        widget.controller!.decision(profile.id, item.id) != 'included') {
      return '先确认这张是宝宝照片，再制作成长水印';
    }
    return null;
  }

  Map<String, dynamic> options() => {
    'template': 'growth',
    'growthMode': mode,
    'position': position,
    'fontSize': fontSize,
    'color': color,
    'opacity': opacity,
    'shade': shade,
    'showName': showName,
    'showDate': showDate,
  };

  Future<File> original(FamilyAsset item) async {
    final cached = files[item.id];
    if (cached != null) return cached;
    final result = await widget.controller?.fileFor(item);
    if (result == null) throw StateError('本机原文件暂不可用，请检查相册权限或重新选择照片');
    files[item.id] = result;
    return result;
  }

  Future<Map<String, dynamic>> render(
    FamilyAsset item,
    BabyProfile profile,
    Map<String, dynamic> style, {
    bool export = false,
  }) async {
    final reason = unavailable(item, profile);
    if (reason != null) throw StateError(reason);
    final date = item.date!;
    final file = await original(item);
    final result = await FamilyController.channel
        .invokeMapMethod<String, dynamic>('watermark', {
          ...style,
          'path': file.path,
          'preview': !export,
          'captureDate': date,
          'text': watermarkText(
            profile,
            date,
            template: 'growth',
            growthMode: style['growthMode'] as String,
            showName: style['showName'] == true,
            showDate: style['showDate'] == true,
          ),
        });
    if (result?['path'] is! String || (result!['path'] as String).isEmpty) {
      throw StateError('未取得水印副本，请重试');
    }
    return result;
  }

  /// 调整选项先合并短时间内的操作，只让最新请求更新当前照片。
  void schedulePreview() {
    debounce?.cancel();
    final request = ++version;
    previewPending = true;
    debounce = Timer(const Duration(milliseconds: 220), () {
      if (mounted && request == version && !exporting) {
        unawaited(updatePreview());
      }
    });
  }

  Future<void> updatePreview() async {
    if (previewRunning || exporting || !mounted) return;
    previewPending = false;
    final request = version,
        current = FamilyAsset(Map.of(asset.data)),
        profile = BabyProfile(Map.of(baby.data)),
        style = options();
    final reason = unavailable(current, profile);
    if (reason != null) {
      setState(() => notice = '');
      return;
    }
    setState(() {
      previewRunning = true;
      previewFailed = false;
    });
    try {
      final result = await render(current, profile, style);
      if (mounted && request == version && current.id == asset.id) {
        setState(() {
          previewPath = result['path'] as String;
          notice = '';
        });
      }
    } catch (error) {
      if (mounted && request == version) {
        setState(() {
          notice = message(error);
          previewFailed = true;
        });
      }
    } finally {
      if (mounted) {
        setState(() => previewRunning = false);
        if (previewPending && !exporting) {
          debounce?.cancel();
          unawaited(updatePreview());
        }
      }
    }
  }

  String message(Object error) => error is PlatformException
      ? error.message ?? '水印处理失败'
      : error is StateError
      ? error.message.toString()
      : '$error';

  void change(VoidCallback action) {
    setState(() {
      action();
      notice = '';
    });
    schedulePreview();
  }

  void move(int next) {
    if (next < 0 || next >= sequence.length || exporting) return;
    change(() {
      index = next;
      previewPath = null;
      recordSignature = signature();
    });
  }

  Future<void> confirmDate() async {
    final current = asset;
    final parsed = DateTime.tryParse(current.date ?? '') ?? DateTime.now();
    final date = await showDatePicker(
      context: context,
      initialDate:
          parsed.isBefore(DateTime(1900)) || parsed.isAfter(DateTime(2100))
          ? DateTime.now()
          : parsed,
      firstDate: DateTime(1900),
      lastDate: DateTime(2100),
    );
    if (date == null || !mounted) return;
    try {
      await widget.controller!.setDate(current, dateLabel(date));
      if (mounted) change(() {});
    } catch (error) {
      if (mounted) setState(() => notice = message(error));
    }
  }

  Future<void> confirmBaby() async {
    try {
      await widget.controller!.decide(baby.id, asset.id, 'included');
      if (mounted) change(() {});
    } catch (error) {
      if (mounted) setState(() => notice = message(error));
    }
  }

  /// 每张照片单独校验并保存唯一副本，失败列出原因后继续，其间不删除任何媒体。
  Future<void> exportCopies() async {
    if (exporting || previewRunning || previewPending || previewFailed) return;
    debounce?.cancel();
    version++;
    previewPending = false;
    final style = options(), profile = BabyProfile(Map.of(baby.data));
    setState(() {
      exporting = true;
      processed = 0;
      exported = 0;
      notice = '';
      failures.clear();
    });
    for (final entry in sequence) {
      final current = widget.controller?.assets[entry.id] ?? entry;
      try {
        final result = await render(current, profile, style, export: true);
        exported++;
        if (sequence.length == 1) {
          notice = result['gallery'] == true
              ? '水印副本已保存到系统相册 Pictures/MomentNest：${result['filename']}'
              : '水印副本已保存到应用导出目录：${result['path']}';
        }
      } catch (error) {
        failures.add((filename: current.filename, reason: message(error)));
      }
      processed++;
      if (mounted) setState(() {});
    }
    if (mounted) {
      setState(() {
        exporting = false;
        if (sequence.length > 1) {
          notice = '已保存 $exported 张副本，${failures.length} 张未完成';
        }
        if (sequence.length == 1 && failures.isNotEmpty) {
          notice = failures.single.reason == unavailable(asset, baby)
              ? ''
              : failures.single.reason;
        }
      });
    }
  }

  Future<void> showFailures() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          ListTile(
            title: const Text('未完成的照片'),
            trailing: IconButton(
              tooltip: '关闭明细',
              icon: const Icon(Icons.close),
              onPressed: () => Navigator.pop(context),
            ),
          ),
          for (final entry in failures)
            ListTile(title: Text(entry.filename), subtitle: Text(entry.reason)),
        ],
      ),
    ),
  );

  Future<void> showSettings() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => StatefulBuilder(
      builder: (_, update) {
        void adjust(VoidCallback action) {
          change(action);
          if (sheetContext.mounted) update(() {});
        }

        return SafeArea(
          child: SizedBox(
            height: MediaQuery.sizeOf(sheetContext).height * 0.65,
            child: ListView(
              padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
              children: [
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('更多设置'),
                  trailing: IconButton(
                    tooltip: '关闭设置',
                    onPressed: () => Navigator.pop(sheetContext),
                    icon: const Icon(Icons.close),
                  ),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('显示宝宝昵称'),
                  value: showName,
                  onChanged: (value) => adjust(() => showName = value),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('显示拍摄日期'),
                  value: showDate,
                  onChanged: (value) => adjust(() => showDate = value),
                ),
                SwitchListTile(
                  contentPadding: EdgeInsets.zero,
                  title: const Text('淡暗底衬'),
                  value: shade,
                  onChanged: (value) => adjust(() => shade = value),
                ),
                Text('字号 ${fontSize.round()}'),
                Slider(
                  value: fontSize,
                  min: 12,
                  max: 80,
                  onChanged: (value) => adjust(() => fontSize = value),
                ),
                Text('透明度 ${(opacity * 100).round()}%'),
                Slider(
                  value: opacity,
                  min: 0.1,
                  max: 1,
                  onChanged: (value) => adjust(() => opacity = value),
                ),
                Wrap(
                  spacing: 8,
                  children: [
                    for (final entry in {
                      '#FFFFFF': '白色',
                      '#292B25': '深色',
                      '#C16C45': '暖棕',
                    }.entries)
                      ChoiceChip(
                        label: Text(entry.value),
                        selected: color == entry.key,
                        onSelected: (_) => adjust(() => color = entry.key),
                      ),
                  ],
                ),
                const SizedBox(height: 16),
                const Text('出生当天算第 1 天。日期来自已确认的拍摄日；月底和闰年按日历计算。'),
                const SizedBox(height: 8),
                const Text('导出保持照片比例，为最长边 4096 像素的 JPEG 副本，不覆盖原照片。'),
              ],
            ),
          ),
        );
      },
    ),
  );

  @override
  Widget build(BuildContext context) {
    final current = asset, reason = unavailable(current, baby);
    final imagePath =
        previewPath ??
        files[current.id]?.path ??
        current.localPath ??
        current.thumbnailPath;
    return Scaffold(
      appBar: AppBar(
        title: const Text('成长水印'),
        actions: [
          IconButton(
            key: const ValueKey('watermark-more'),
            tooltip: '更多设置',
            onPressed: exporting ? null : showSettings,
            icon: const Icon(Icons.tune),
          ),
        ],
      ),
      body: SafeArea(
        top: false,
        child: Column(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  const ColoredBox(color: galleryPreview),
                  if (imagePath != null)
                    Image.file(
                      File(imagePath),
                      key: const ValueKey('watermark-preview-image'),
                      fit: BoxFit.contain,
                      gaplessPlayback: true,
                      errorBuilder: (_, _, _) => const Center(
                        child: Icon(
                          Icons.broken_image_outlined,
                          color: galleryMuted,
                          size: 40,
                        ),
                      ),
                    ),
                  if (reason != null)
                    Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Card(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: Column(
                              mainAxisSize: MainAxisSize.min,
                              children: [
                                Text(reason, textAlign: TextAlign.center),
                                if (widget.controller != null &&
                                    current.kind == 'photo')
                                  TextButton(
                                    onPressed: exporting
                                        ? null
                                        : reason.contains('先确认这张')
                                        ? confirmBaby
                                        : reason.contains('日期')
                                        ? confirmDate
                                        : null,
                                    child: Text(
                                      reason.contains('先确认这张')
                                          ? '确认是宝宝'
                                          : '确认拍摄日期',
                                    ),
                                  ),
                              ],
                            ),
                          ),
                        ),
                      ),
                    ),
                  if (previewRunning || exporting)
                    Positioned(
                      top: 0,
                      left: 0,
                      right: 0,
                      child: LinearProgressIndicator(
                        minHeight: 3,
                        value: exporting ? processed / sequence.length : null,
                      ),
                    ),
                  if (previewRunning)
                    const Positioned(
                      top: 12,
                      right: 12,
                      child: Text(
                        '正在更新预览…',
                        style: TextStyle(color: galleryMuted, fontSize: 12),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 8),
              child: Row(
                children: [
                  IconButton(
                    tooltip: '上一张',
                    onPressed: index == 0 || exporting
                        ? null
                        : () => move(index - 1),
                    icon: const Icon(Icons.chevron_left),
                  ),
                  Expanded(
                    child: Text(
                      sequence.length == 1
                          ? current.filename
                          : '${index + 1}/${sequence.length} · ${current.filename}',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      textAlign: TextAlign.center,
                      style: const TextStyle(fontSize: 12),
                    ),
                  ),
                  IconButton(
                    tooltip: '下一张',
                    onPressed: index + 1 >= sequence.length || exporting
                        ? null
                        : () => move(index + 1),
                    icon: const Icon(Icons.chevron_right),
                  ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 0, 16, 12),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          isExpanded: true,
                          key: const ValueKey('watermark-mode'),
                          initialValue: mode,
                          decoration: const InputDecoration(
                            labelText: '文字模式',
                            isDense: true,
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'auto',
                              child: Text('自动成长'),
                            ),
                            DropdownMenuItem(
                              value: 'day-count',
                              child: Text('出生天数'),
                            ),
                          ],
                          onChanged: exporting
                              ? null
                              : (value) => change(() => mode = value!),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          isExpanded: true,
                          key: const ValueKey('watermark-position'),
                          initialValue: position,
                          decoration: const InputDecoration(
                            labelText: '位置',
                            isDense: true,
                          ),
                          items: const [
                            DropdownMenuItem(
                              value: 'top-left',
                              child: Text('左上'),
                            ),
                            DropdownMenuItem(
                              value: 'top-right',
                              child: Text('右上'),
                            ),
                            DropdownMenuItem(
                              value: 'bottom-left',
                              child: Text('左下'),
                            ),
                            DropdownMenuItem(
                              value: 'bottom-right',
                              child: Text('右下'),
                            ),
                          ],
                          onChanged: exporting
                              ? null
                              : (value) => change(() => position = value!),
                        ),
                      ),
                    ],
                  ),
                  if (notice.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.only(top: 8),
                      child: Text(
                        notice,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  if (previewFailed && !exporting)
                    TextButton(
                      onPressed: schedulePreview,
                      child: const Text('重试预览'),
                    ),
                  if (failures.isNotEmpty)
                    TextButton(
                      onPressed: showFailures,
                      child: Text('查看 ${failures.length} 张未完成的原因'),
                    ),
                  const SizedBox(height: 10),
                  SizedBox(
                    width: double.infinity,
                    child: FilledButton(
                      key: const ValueKey('watermark-export'),
                      onPressed:
                          exporting ||
                              previewRunning ||
                              previewPending ||
                              previewFailed
                          ? null
                          : exportCopies,
                      child: Text(
                        exporting
                            ? '正在保存 $processed/${sequence.length}'
                            : sequence.length == 1
                            ? '导出水印副本'
                            : '导出 ${sequence.length} 张水印副本',
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
