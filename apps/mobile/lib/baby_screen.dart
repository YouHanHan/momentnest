import 'dart:io';
import 'dart:math' as math;
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';
import 'family_controller.dart';
import 'family_models.dart';
import 'media_preview.dart';
import 'models.dart';
import 'gallery_style.dart';
import 'growth_timeline.dart';
import 'growth_watermark_overlay.dart';
import 'baby_profile_dialog.dart';
import 'media_query_bar.dart';

/// 宝宝集合只改变浏览归类；保存到电脑由独立传输流程完成。
class BabyScreen extends StatefulWidget {
  const BabyScreen({
    super.key,
    required this.controller,
    required this.onTransfer,
    this.onChooseMedia,
    this.onChooseReference,
  });
  final FamilyController controller;
  final void Function(FamilyAsset asset) onTransfer;
  final VoidCallback? onChooseMedia;
  final ValueChanged<BabyProfile>? onChooseReference;
  @override
  State<BabyScreen> createState() => _BabyScreenState();
}

/// 可见照片优先复用缓存，首次整理的媒体按需读取系统缩略图。
class _BabyThumbnail extends StatefulWidget {
  const _BabyThumbnail({
    super.key,
    required this.asset,
    required this.resolve,
    required this.frameBuilder,
  });
  final FamilyAsset asset;
  final Future<AssetEntity?> Function(String) resolve;
  final ImageFrameBuilder frameBuilder;

  @override
  State<_BabyThumbnail> createState() => _BabyThumbnailState();
}

class _BabyThumbnailState extends State<_BabyThumbnail> {
  late final thumbnail = widget.asset.thumbnailPath == null ? load() : null;

  Future<Uint8List?> load() async {
    final id = widget.asset.localId;
    if (id == null) return null;
    try {
      final media = await widget.resolve(id);
      return await media?.thumbnailDataWithSize(const ThumbnailSize(360, 360));
    } catch (_) {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    const placeholder = ColoredBox(
      color: gallerySelected,
      child: Icon(Icons.image_outlined, color: galleryMuted),
    );
    final path = widget.asset.thumbnailPath;
    if (path != null) {
      return Image.file(
        File(path),
        fit: BoxFit.cover,
        frameBuilder: widget.frameBuilder,
        errorBuilder: (_, _, _) => placeholder,
      );
    }
    return FutureBuilder<Uint8List?>(
      future: thumbnail,
      builder: (context, snapshot) => snapshot.hasData
          ? Image.memory(
              snapshot.data!,
              fit: BoxFit.cover,
              frameBuilder: widget.frameBuilder,
              errorBuilder: (_, _, _) => placeholder,
            )
          : placeholder,
    );
  }
}

class _BabyScreenState extends State<BabyScreen> {
  String scope = 'related', kind = 'all';
  String search = '';
  bool oldestFirst = false, favoritesOnly = false;
  int? selectedAgeMonth;
  String? timelineBaby;
  bool allMonths = true;
  final Set<String> collapsedMonths = {};
  final Set<String> watermarkSelection = {};
  bool selecting = false;
  String? selectionBaby;
  List<FamilyAsset> displayedItems = [];
  FamilyController get model => widget.controller;

  Future<void> editBaby([BabyProfile? previous]) => showDialog<void>(
    context: context,
    builder: (_) => BabyProfileDialog(controller: model, previous: previous),
  );

  /// 从系统相册选图；旧调用方仍可浏览已整理媒体。
  void chooseMedia() {
    if (widget.onChooseMedia != null) {
      widget.onChooseMedia!();
    } else {
      setState(() => scope = 'library');
    }
  }

  /// 低频操作按需展开，成长相册始终优先展示照片。
  Future<void> showTools() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => ListenableBuilder(
      listenable: model,
      builder: (context, _) {
        final baby = model.babies[model.activeBaby];
        void closeAnd(VoidCallback action) {
          Navigator.pop(sheetContext);
          action();
        }

        return SafeArea(
          child: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.only(bottom: 16),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const ListTile(
                    title: Text(
                      '相册工具',
                      style: TextStyle(fontWeight: FontWeight.w700),
                    ),
                  ),
                  if (baby != null)
                    ListTile(
                      leading: const Icon(Icons.cake_outlined),
                      title: const Text('编辑出生档案'),
                      subtitle: Text(
                        '${baby.birthday} · 自动整理${baby.autoMatch ? '已开启' : '已关闭'}',
                      ),
                      onTap: () => closeAnd(() => editBaby(baby)),
                    ),
                  ListTile(
                    key: const ValueKey('baby-new-profile'),
                    leading: const Icon(Icons.person_add_alt_1_outlined),
                    title: const Text('建立宝宝档案'),
                    onTap: () => closeAnd(() => editBaby()),
                  ),
                  if (baby != null)
                    ListTile(
                      leading: const Icon(Icons.face_outlined),
                      title: const Text('管理人脸参考'),
                      subtitle: Text(
                        baby.references.isNotEmpty &&
                                model.validReferenceCount(baby) == 0
                            ? '参考暂不可用，请重新选清晰人脸'
                            : '已选 ${baby.references.length} 个 · 可用 ${model.validReferenceCount(baby)} 个本机参考',
                      ),
                      onTap: () => closeAnd(() => showReferences(baby)),
                    ),
                  if (baby != null)
                    ListTile(
                      key: const ValueKey('baby-growth-watermark'),
                      leading: const Icon(Icons.water_drop_outlined),
                      title: const Text('成长水印'),
                      subtitle: const Text('选择照片，确认拍摄日期后另存副本'),
                      onTap: () => closeAnd(() => showWatermarkPicker(baby)),
                    ),
                  if (baby != null)
                    SwitchListTile(
                      key: const ValueKey('baby-watermark-display'),
                      secondary: Icon(
                        model.growthWatermarkVisible(baby.id)
                            ? Icons.visibility_outlined
                            : Icons.visibility_off_outlined,
                      ),
                      title: Text(
                        model.growthWatermarkVisible(baby.id)
                            ? '水印显示已开'
                            : '水印显示已关',
                      ),
                      value: model.growthWatermarkVisible(baby.id),
                      onChanged: (value) async {
                        await model.action(
                          () => model.setGrowthWatermarkDisplay(baby.id, value),
                        );
                        if (mounted) setState(() {});
                      },
                    ),
                  if (baby != null)
                    ListTile(
                      leading: const Icon(Icons.calendar_month_outlined),
                      title: const Text('全部成长月份'),
                      onTap: () => closeAnd(
                        () => setState(() {
                          allMonths = true;
                          selectedAgeMonth = null;
                          scope = 'related';
                        }),
                      ),
                    ),
                  ListTile(
                    leading: const Icon(Icons.filter_list),
                    title: const Text('媒体类型'),
                    trailing: Text(
                      kind == 'all'
                          ? '照片和视频'
                          : kind == 'photo'
                          ? '照片'
                          : '视频',
                    ),
                    onTap: () => closeAnd(showKindFilter),
                  ),
                  ListTile(
                    leading: const Icon(Icons.photo_library_outlined),
                    title: const Text('全部已整理媒体'),
                    onTap: () =>
                        closeAnd(() => setState(() => scope = 'library')),
                  ),
                  ListTile(
                    leading: const Icon(Icons.checklist_outlined),
                    title: const Text('本机识别覆盖'),
                    subtitle: Text(
                      '已完成 ${model.localAssets.where((asset) => asset.data['_faceModel'] == 'sface-mobile-v1' && asset.data['faceState'] == 'done').length} · 尚未分析 ${model.localAssets.where((asset) => asset.data['faceState'] == 'pending').length} · 分析失败 ${model.localAssets.where((asset) => asset.data['faceState'] == 'error').length}',
                    ),
                  ),
                  const Divider(height: 16),
                  ListTile(
                    leading: Icon(
                      model.scanning
                          ? Icons.pause
                          : Icons.auto_awesome_outlined,
                    ),
                    title: Text(
                      model.scanning
                          ? '暂停整理'
                          : model.scanPaused
                          ? '继续整理'
                          : '整理手机照片和视频',
                    ),
                    subtitle: model.scanning || model.scanPaused
                        ? Text(
                            model.scanStage.isEmpty
                                ? model.progress
                                : '${model.scanStage} · ${model.progress}',
                          )
                        : model.matching
                        ? Text(model.matchProgress)
                        : const Text('按参考人脸查找宝宝，系统相册可直接浏览'),
                    onTap:
                        model.ready &&
                            !model.matching &&
                            !model.transfer.running
                        ? () => closeAnd(
                            model.scanning
                                ? model.pauseScan
                                : () => model.action(model.scan),
                          )
                        : null,
                  ),
                  if (model.scanFailures.isNotEmpty)
                    ListTile(
                      leading: const Icon(Icons.error_outline),
                      title: Text('失败原因 ${model.scanFailures.length}'),
                      onTap: () => closeAnd(showScanFailures),
                    ),
                  if (model.limited)
                    const Padding(
                      padding: EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: Text('仅整理已授权媒体。重新整理可调整照片与视频范围。'),
                    ),
                  if (model.modelError.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: Text(
                        '人物模型：${model.modelError}',
                        style: const TextStyle(color: galleryError),
                      ),
                    ),
                  if (model.notice.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: Text(model.notice),
                    ),
                ],
              ),
            ),
          ),
        );
      },
    ),
  );

  Future<void> showBabyPicker() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: ListView(
        shrinkWrap: true,
        children: [
          for (final baby in model.babies.values)
            ListTile(
              title: Text(baby.name),
              subtitle: Text(ageAt(baby.birthday, dateLabel(DateTime.now()))),
              trailing: baby.id == model.activeBaby
                  ? const Icon(Icons.check)
                  : null,
              onTap: () {
                setState(() {
                  model.activeBaby = baby.id;
                  scope = 'related';
                  allMonths = true;
                  collapsedMonths.clear();
                });
                Navigator.pop(sheetContext);
              },
            ),
        ],
      ),
    ),
  );

  Future<void> showKindFilter() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (sheetContext) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const ListTile(title: Text('媒体类型')),
          for (final entry in {
            'all': '照片和视频',
            'photo': '照片',
            'video': '视频',
          }.entries)
            ListTile(
              title: Text(entry.value),
              trailing: kind == entry.key ? const Icon(Icons.check) : null,
              onTap: () {
                setState(() => kind = entry.key);
                Navigator.pop(sheetContext);
              },
            ),
        ],
      ),
    ),
  );

  /// 失败原因按项查看，重试只处理此列表，不重新识别成功项。
  Future<void> showScanFailures() => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: SizedBox(
        height: MediaQuery.sizeOf(sheetContext).height * 0.65,
        child: ListenableBuilder(
          listenable: model,
          builder: (_, _) => Column(
            children: [
              Padding(
                padding: const EdgeInsets.symmetric(horizontal: 16),
                child: Row(
                  children: [
                    const Expanded(child: Text('整理失败原因')),
                    TextButton(
                      onPressed: model.scanning || model.transfer.running
                          ? null
                          : () => model.action(model.retryScanFailures),
                      child: const Text('仅重试失败'),
                    ),
                  ],
                ),
              ),
              Expanded(
                child: ListView(
                  children: [
                    for (final failure in model.scanFailures.values)
                      ListTile(
                        title: Text(failure['filename'] as String? ?? '媒体'),
                        subtitle: Text(failure['reason'] as String? ?? '读取失败'),
                      ),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    ),
  );

  /// 参考管理仅更改人物关联，原照片和手工相册归属保持不变。
  Future<void> showReferences(BabyProfile baby) => showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (sheetContext) => SafeArea(
      child: SingleChildScrollView(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(
              '${baby.name}的人脸参考',
              style: Theme.of(context).textTheme.titleLarge,
            ),
            const SizedBox(height: 12),
            Text('已选 ${baby.references.length} 个本机参考。'),
            const SizedBox(height: 8),
            Text(
              widget.onChooseReference != null
                  ? '选择一张清晰的宝宝照片，检测后点选宝宝对应的人脸，再保存参考。'
                  : '到相册打开一张宝宝照片，点宝宝整理，选择宝宝的人脸作为参考。',
            ),
            const SizedBox(height: 16),
            FilledButton.icon(
              onPressed: () {
                Navigator.pop(sheetContext);
                if (widget.onChooseReference != null) {
                  widget.onChooseReference!(baby);
                } else {
                  chooseMedia();
                }
              },
              icon: const Icon(Icons.photo_outlined),
              label: const Text('选择宝宝照片'),
            ),
            if (baby.references.isNotEmpty) ...[
              for (final reference in baby.references)
                ListTile(
                  contentPadding: EdgeInsets.zero,
                  title: Text(
                    model.assets[reference['assetId']]?.filename ?? '参考照片暂不可用',
                  ),
                  subtitle: Text('参考人脸 ${reference['faceId']}'),
                  trailing: TextButton(
                    onPressed: model.matching
                        ? null
                        : () {
                            Navigator.pop(sheetContext);
                            model.action(
                              () => model.removeReference(baby, reference),
                            );
                          },
                    child: const Text('移除这条'),
                  ),
                  onTap:
                      model.assets[reference['assetId']] == null ||
                          !model.isLocalAsset(
                            model.assets[reference['assetId']]!,
                          )
                      ? null
                      : () {
                          // 预览覆盖参考弹层，返回后保留列表与滚动位置。
                          openMedia(model.assets[reference['assetId']]!, baby);
                        },
                ),
              const SizedBox(height: 8),
              TextButton(
                onPressed: () {
                  Navigator.pop(sheetContext);
                  model.action(() => model.clearReferences(baby));
                },
                child: const Text('移除参考关联'),
              ),
              const Text('只移除本机参考与自动匹配记录，照片及手工加入的相册记录保留。'),
            ],
          ],
        ),
      ),
    ),
  );

  /// 水印选图后进入真实详情，确认日期再制作副本。
  Future<void> showWatermarkPicker(BabyProfile baby) =>
      showModalBottomSheet<void>(
        context: context,
        showDragHandle: true,
        builder: (sheetContext) {
          final photos = model
              .collection(baby.id)
              .where((asset) => asset.kind == 'photo')
              .toList();
          return SafeArea(
            child: photos.isEmpty
                ? Padding(
                    padding: const EdgeInsets.all(24),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('先添加一张宝宝照片'),
                        TextButton(
                          onPressed: () {
                            Navigator.pop(sheetContext);
                            chooseMedia();
                          },
                          child: const Text('选择宝宝照片'),
                        ),
                      ],
                    ),
                  )
                : ListView.builder(
                    shrinkWrap: true,
                    itemCount: photos.length,
                    itemBuilder: (_, index) => ListTile(
                      title: Text(photos[index].filename),
                      subtitle: Text(
                        watermarkUnavailableReason(photos[index], baby) ??
                            '${photos[index].date} · 可制作水印',
                      ),
                      onTap: () {
                        Navigator.pop(sheetContext);
                        openWatermark([photos[index]], baby);
                      },
                    ),
                  ),
          );
        },
      );

  /// 水印使用独立的照片序列，返回后保留相册的筛选、多选和滚动位置。
  void openWatermark(List<FamilyAsset> photos, BabyProfile baby) {
    if (photos.isEmpty) return;
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => WatermarkScreen(
          asset: photos.first,
          baby: baby,
          controller: model,
          sequence: photos,
        ),
      ),
    );
  }

  void toggleWatermarkSelection(FamilyAsset asset) => setState(() {
    selecting = true;
    if (!watermarkSelection.add(asset.id)) watermarkSelection.remove(asset.id);
  });

  void openMedia(FamilyAsset asset, BabyProfile? baby) => Navigator.push<void>(
    context,
    MaterialPageRoute(
      builder: (_) => MediaPreview(
        controller: model,
        asset: asset,
        sequence: List.of(displayedItems),
        baby: baby,
        onTransferAsset: widget.onTransfer,
      ),
    ),
  );

  /// 使用选定人脸的原图坐标展示头像，界面裁切不生成或改写照片。
  Widget referenceAvatar(FamilyAsset? asset, Json? face) {
    final thumbnail = asset?.thumbnailPath;
    final fallback = CircleAvatar(
      radius: 24,
      backgroundColor: gallerySelected,
      foregroundImage: thumbnail == null ? null : FileImage(File(thumbnail)),
      child: const GalleryModuleIcon(1),
    );
    final path = asset?.localPath;
    final width = asset?.data['width'], height = asset?.data['height'];
    if (asset?.kind != 'photo' ||
        path == null ||
        face == null ||
        width is! num ||
        height is! num ||
        !width.isFinite ||
        !height.isFinite ||
        width <= 0 ||
        height <= 0) {
      return fallback;
    }
    final values = [face['x'], face['y'], face['width'], face['height']];
    if (values.any(
          (value) => value is! num || !value.isFinite || value < 0 || value > 1,
        ) ||
        (face['width'] as num) <= 0 ||
        (face['height'] as num) <= 0) {
      return fallback;
    }
    final faceWidth = (face['width'] as num).toDouble() * width;
    final faceHeight = (face['height'] as num).toDouble() * height;
    final side = math.min(
      math.max(faceWidth, faceHeight) * 1.6,
      math.min(width.toDouble(), height.toDouble()),
    );
    final left = ((face['x'] as num) * width + faceWidth / 2 - side / 2).clamp(
      0.0,
      width - side,
    );
    final top = ((face['y'] as num) * height + faceHeight / 2 - side / 2).clamp(
      0.0,
      height - side,
    );
    final scale = 48 / side;
    return ClipOval(
      child: SizedBox.square(
        dimension: 48,
        child: Stack(
          children: [
            fallback,
            Positioned(
              left: -left * scale,
              top: -top * scale,
              width: width * scale,
              height: height * scale,
              child: Image.file(
                File(path),
                fit: BoxFit.fill,
                cacheWidth: (width * scale).ceil().clamp(1, 1024),
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            ),
          ],
        ),
      ),
    );
  }

  /// 筛选始终保持一行；窄屏或大字体时横向滚动，保留文字和点击尺寸。
  Widget scopeFilters(int candidates, int reviewCount) {
    final labels = {
      'related': '全部',
      'included': '已加入',
      'candidate': candidates > 0 ? '疑似 $candidates' : '疑似',
      'review': '待核对 $reviewCount',
    };
    return LayoutBuilder(
      builder: (context, constraints) {
        final style = Theme.of(
          context,
        ).textTheme.labelLarge!.copyWith(fontSize: 14);
        var buttonWidth = 48.0;
        for (final label in labels.values) {
          final text = TextPainter(
            text: TextSpan(text: label, style: style),
            textDirection: Directionality.of(context),
            textScaler: MediaQuery.textScalerOf(context),
          )..layout();
          buttonWidth = math.max(buttonWidth, text.width + 16);
          text.dispose();
        }
        final scroll = buttonWidth * labels.length + 12 > constraints.maxWidth;
        final buttons = <Widget>[];
        for (final entry in labels.entries) {
          if (buttons.isNotEmpty) buttons.add(const SizedBox(width: 4));
          final selected = scope == entry.key;
          final button = Semantics(
            selected: selected,
            child: TextButton(
              key: ValueKey(
                entry.key == 'candidate'
                    ? 'baby-candidates'
                    : 'baby-filter-${entry.key}',
              ),
              style: TextButton.styleFrom(
                minimumSize: const Size(48, 48),
                padding: const EdgeInsets.symmetric(horizontal: 8),
                backgroundColor: selected ? gallerySelected : null,
                foregroundColor: selected ? galleryInk : galleryMuted,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(8),
                ),
                textStyle: style,
              ),
              onPressed: () => setState(() => scope = entry.key),
              child: Text(entry.value, maxLines: 1),
            ),
          );
          buttons.add(
            scroll
                ? SizedBox(width: buttonWidth, child: button)
                : Expanded(child: button),
          );
        }
        final row = Row(children: buttons);
        return Padding(
          padding: const EdgeInsets.only(top: 8),
          child: scroll
              ? SingleChildScrollView(
                  scrollDirection: Axis.horizontal,
                  child: row,
                )
              : row,
        );
      },
    );
  }

  /// 完整整理信息按需展开，照片列表仅展示计数与常用操作。
  Widget scanSummary() => Column(
    children: [
      if (model.scanning || model.matching)
        LinearProgressIndicator(
          minHeight: 2,
          value: model.scanning && !model.matching && model.scanTotal > 0
              ? (model.scanProcessed / model.scanTotal).clamp(0.0, 1.0)
              : null,
        ),
      Row(
        children: [
          Expanded(
            child: Text(
              model.matching
                  ? '正在匹配宝宝'
                  : model.scanning
                  ? model.scanTotal > 0
                        ? '整理 ${model.scanProcessed} / ${model.scanTotal}'
                        : '正在整理媒体'
                  : model.scanPaused
                  ? '整理已暂停${model.scanTotal > 0 ? ' ${model.scanProcessed} / ${model.scanTotal}' : ''}'
                  : '${model.scanFailures.length} 项整理失败',
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: const TextStyle(fontSize: 12, color: galleryMuted),
            ),
          ),
          if (model.scanning || model.scanPaused)
            IconButton(
              key: const ValueKey('baby-scan-control'),
              tooltip: model.scanning ? '暂停整理' : '继续整理',
              onPressed:
                  !model.ready || model.matching || model.transfer.running
                  ? null
                  : model.scanning
                  ? model.pauseScan
                  : () => model.action(model.scan),
              icon: Icon(model.scanning ? Icons.pause : Icons.play_arrow),
            ),
          IconButton(
            key: const ValueKey('baby-scan-details'),
            tooltip: model.scanFailures.isNotEmpty ? '整理失败原因' : '整理详情',
            onPressed: model.scanFailures.isNotEmpty
                ? showScanFailures
                : showTools,
            icon: Icon(
              model.scanFailures.isNotEmpty
                  ? Icons.error_outline
                  : Icons.info_outline,
              size: 20,
            ),
          ),
        ],
      ),
    ],
  );

  Future<void> showReviewHelp() => showDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: const Text('待核对照片与视频'),
      content: const Text('检查已整理媒体中的遗漏项。未分析、无脸或相似度不足均可打开原文件，确认是宝宝或不是宝宝。'),
      actions: [
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('知道了'),
        ),
      ],
    ),
  );

  Widget mediaTile(FamilyAsset asset, BabyProfile? baby) {
    final displayText = baby != null && model.growthWatermarkVisible(baby.id)
        ? growthWatermarkDisplayText(
            asset,
            baby,
            model.decision(baby.id, asset.id),
          )
        : null;
    return InkWell(
      key: ValueKey('baby-media-${asset.id}'),
      borderRadius: BorderRadius.circular(8),
      onTap: selecting && asset.kind != 'photo'
          ? null
          : () => selecting
                ? toggleWatermarkSelection(asset)
                : openMedia(asset, baby),
      onLongPress: baby == null || asset.kind != 'photo'
          ? null
          : () => toggleWatermarkSelection(asset),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(8),
        child: Stack(
          fit: StackFit.expand,
          children: [
            _BabyThumbnail(
              key: ValueKey(
                '${asset.id}:${asset.thumbnailPath}:${asset.localId}',
              ),
              asset: asset,
              resolve: model.mediaResolver,
              frameBuilder: (_, child, frame, synchronous) => Stack(
                fit: StackFit.expand,
                children: [
                  child,
                  if (displayText != null && (frame != null || synchronous))
                    Positioned.fill(
                      child: GrowthWatermarkOverlay(
                        key: ValueKey('baby-growth-overlay-${asset.id}'),
                        text: displayText,
                      ),
                    ),
                ],
              ),
            ),
            if (selecting && asset.kind == 'photo')
              Positioned(
                left: 4,
                top: 4,
                child: Icon(
                  watermarkSelection.contains(asset.id)
                      ? Icons.check_circle
                      : Icons.radio_button_unchecked,
                  color: watermarkSelection.contains(asset.id)
                      ? galleryAccent
                      : Colors.white,
                  size: 24,
                ),
              ),
            if (model.isFavorite(asset))
              const Positioned(
                bottom: 6,
                right: 6,
                child: Icon(Icons.favorite, color: Colors.white, size: 18),
              ),
            if (baby != null &&
                (scope == 'review' ||
                    model.decision(baby.id, asset.id) != null))
              Positioned(
                right: 4,
                top: 4,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: galleryPhotoBadge,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 2,
                    ),
                    child: Text(
                      scope == 'review'
                          ? model.reviewReason(baby.id, asset)!
                          : babyStatusLabel(
                              model.decisions['${baby.id}:${asset.id}'],
                            ),
                      style: const TextStyle(color: galleryInk, fontSize: 10),
                    ),
                  ),
                ),
              ),
            if (baby != null && model.isReference(baby.id, asset.id))
              Positioned(
                right: 4,
                top: displayText == null ? null : 28,
                bottom: displayText == null ? 4 : null,
                child: const DecoratedBox(
                  decoration: BoxDecoration(color: galleryPhotoBadge),
                  child: Padding(
                    padding: EdgeInsets.all(3),
                    child: Text(
                      '已作参考',
                      style: TextStyle(color: galleryInk, fontSize: 10),
                    ),
                  ),
                ),
              ),
            if (asset.kind == 'video')
              Positioned(
                left: 6,
                bottom: 6,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: galleryPhotoBadge,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 2,
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(
                          Icons.videocam,
                          color: galleryInk,
                          size: 14,
                        ),
                        if (asset.data['duration'] is num &&
                            (asset.data['duration'] as num).isFinite &&
                            (asset.data['duration'] as num) > 0) ...[
                          const SizedBox(width: 4),
                          Text(
                            '${((asset.data['duration'] as num).toInt() ~/ 60).toString().padLeft(2, '0')}:${((asset.data['duration'] as num).toInt() % 60).toString().padLeft(2, '0')}',
                            style: const TextStyle(
                              color: galleryInk,
                              fontSize: 11,
                            ),
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ),
            if (asset.localId == null)
              Align(
                alignment: Alignment.topLeft,
                child: Padding(
                  padding: const EdgeInsets.all(6),
                  child: Icon(
                    asset.data['_changedLocalVersion'] == true
                        ? Icons.history
                        : Icons.computer,
                    color: Colors.white,
                    size: 18,
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    if (!model.ready) {
      return ListView(
        padding: const EdgeInsets.all(20),
        children: [
          const Text('宝宝相册', style: TextStyle(fontSize: 20)),
          const SizedBox(height: 16),
          if (model.initializing || model.notice.isEmpty)
            const Row(
              children: [
                SizedBox(
                  width: 16,
                  height: 16,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
                SizedBox(width: 10),
                Text('正在读取本地相册…'),
              ],
            )
          else ...[
            Text(model.notice, style: const TextStyle(fontSize: 13)),
            const SizedBox(height: 12),
            Align(
              alignment: Alignment.centerLeft,
              child: TextButton.icon(
                key: const ValueKey('baby-retry-read'),
                onPressed: model.initialize,
                icon: const Icon(Icons.refresh),
                label: const Text('重新读取'),
              ),
            ),
          ],
        ],
      );
    }
    final baby = model.babies[model.activeBaby];
    if (selectionBaby != baby?.id) {
      selectionBaby = baby?.id;
      selecting = false;
      watermarkSelection.clear();
    }
    // 同一宝宝修改出生日期后，重新按新月龄选择有效月份。
    final timelineIdentity = baby == null
        ? null
        : '${baby.id}:${baby.birthday}';
    if (timelineBaby != timelineIdentity) {
      timelineBaby = timelineIdentity;
      selectedAgeMonth = null;
      allMonths = true;
    }
    final collection =
        (scope == 'library'
                ? model.localAssets.toList()
                : baby == null
                ? <FamilyAsset>[]
                : scope == 'review'
                ? model.reviewCollection(baby.id)
                : model.collection(
                    baby.id,
                    candidates: scope == 'candidate',
                    includeCandidates: scope == 'related',
                  ))
            .where((asset) => kind == 'all' || asset.kind == kind)
            .where(
              (asset) =>
                  asset.filename.toLowerCase().contains(search.toLowerCase()),
            )
            .where((asset) => !favoritesOnly || model.isFavorite(asset))
            .toList()
          ..sort((a, b) {
            if (a.date == null || a.date!.isEmpty) {
              return b.date == null || b.date!.isEmpty
                  ? a.id.compareTo(b.id)
                  : 1;
            }
            if (b.date == null || b.date!.isEmpty) return -1;
            final compared = oldestFirst
                ? a.date!.compareTo(b.date!)
                : b.date!.compareTo(a.date!);
            return compared == 0 ? a.id.compareTo(b.id) : compared;
          });
    final actualMonths = <int>[];
    if (baby != null) {
      for (final asset in model.collection(baby.id, includeCandidates: true)) {
        final month =
            asset.data['dateConfirmed'] == true &&
                asset.data['dateSource'] != 'creation'
            ? growthMonth(baby.birthday, asset.date)
            : null;
        if (month != null) actualMonths.add(month);
      }
    }
    actualMonths.sort();
    final months = actualMonths.toSet();
    if (baby != null) {
      final current =
          actualMonths.lastOrNull ??
          growthMonth(baby.birthday, dateLabel(DateTime.now())) ??
          0;
      for (
        var month = (current - 3).clamp(0, current);
        month <= current;
        month++
      ) {
        months.add(month);
      }
    }
    final monthAxis = months.toList()..sort();
    if (selectedAgeMonth != null && !months.contains(selectedAgeMonth)) {
      selectedAgeMonth = null;
    }
    final chosenMonth =
        selectedAgeMonth ??
        (actualMonths.isEmpty ? monthAxis.lastOrNull : actualMonths.last);
    final items = collection.where((asset) {
      if (scope == 'library' ||
          baby == null ||
          allMonths ||
          chosenMonth == null) {
        return true;
      }
      if (asset.data['dateConfirmed'] != true ||
          asset.data['dateSource'] == 'creation') {
        return true;
      }
      return growthMonth(baby.birthday, asset.date) == chosenMonth;
    }).toList();
    displayedItems = items;
    final groups = <String, List<FamilyAsset>>{};
    for (final asset in items) {
      final date =
          asset.data['dateConfirmed'] == true &&
              asset.data['dateSource'] != 'creation' &&
              DateTime.tryParse(asset.date ?? '') != null
          ? asset.date!.substring(0, 7)
          : '';
      groups.putIfAbsent(date, () => []).add(asset);
    }
    final reference = baby?.references.where((value) {
      final asset = model.assets[value['assetId']];
      return asset != null && model.isLocalAsset(asset);
    }).firstOrNull;
    final referenceAsset = reference == null
        ? null
        : model.assets[reference['assetId']];
    final referenceFace = referenceAsset?.faces
        .where((face) => face['id'] == reference?['faceId'])
        .firstOrNull;
    final candidates = baby == null
        ? 0
        : model.collection(baby.id, candidates: true).length;
    final reviewCount = baby == null
        ? 0
        : model.reviewCollection(baby.id).length;
    final albumLabel = allMonths || chosenMonth == null
        ? (scope == 'review' ? '待核对照片与视频' : '成长相册')
        : scope == 'candidate'
        ? '疑似照片与视频'
        : baby == null
        ? '成长相册'
        : growthRange(baby.birthday, chosenMonth);
    return CustomScrollView(
      key: const PageStorageKey('baby-timeline'),
      slivers: [
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 8, 0),
            child: Row(
              children: [
                const Expanded(
                  child: Text(
                    '宝宝',
                    style: TextStyle(fontSize: 22, fontWeight: FontWeight.w600),
                  ),
                ),
                if (baby != null)
                  TextButton(
                    key: const ValueKey('baby-select'),
                    onPressed: () => setState(() {
                      selecting = !selecting;
                      if (!selecting) watermarkSelection.clear();
                    }),
                    child: Text(selecting ? '取消' : '选择'),
                  ),
                IconButton(
                  key: const ValueKey('baby-tools'),
                  tooltip: '相册工具',
                  onPressed: showTools,
                  icon: const Icon(Icons.more_horiz),
                ),
              ],
            ),
          ),
        ),
        if (baby != null && selecting)
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16),
              child: Wrap(
                spacing: 8,
                crossAxisAlignment: WrapCrossAlignment.center,
                children: [
                  Text('已选 ${watermarkSelection.length} 张'),
                  TextButton(
                    onPressed: () => setState(
                      () => watermarkSelection.addAll(
                        items
                            .where((item) => item.kind == 'photo')
                            .map((item) => item.id),
                      ),
                    ),
                    child: const Text('全选当前照片'),
                  ),
                  FilledButton.icon(
                    key: const ValueKey('baby-batch-watermark'),
                    onPressed: watermarkSelection.isEmpty
                        ? null
                        : () => openWatermark([
                            for (final id in watermarkSelection)
                              if (model.assets[id] != null) model.assets[id]!,
                          ], baby),
                    icon: const Icon(Icons.auto_awesome_outlined, size: 16),
                    label: const Text('成长水印'),
                  ),
                ],
              ),
            ),
          ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 16, 0),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (baby != null)
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                    decoration: BoxDecoration(color: gallerySelected, borderRadius: BorderRadius.circular(14)),
                    child: Row(
                      children: [
                      Tooltip(
                        message: '更换头像',
                        child: InkWell(
                          key: const ValueKey('baby-avatar'),
                          customBorder: const CircleBorder(),
                          onTap: () =>
                              model.action(() => model.chooseAvatar(baby)),
                          child: baby.avatarPath == null
                              ? referenceAvatar(referenceAsset, referenceFace)
                              : CircleAvatar(
                                  radius: 24,
                                  backgroundImage: FileImage(
                                    File(baby.avatarPath!),
                                  ),
                                  onBackgroundImageError: (_, _) {},
                                  child: const SizedBox.shrink(),
                                ),
                        ),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: InkWell(
                          onTap: model.babies.length > 1
                              ? showBabyPicker
                              : null,
                          borderRadius: BorderRadius.circular(8),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Row(
                                children: [
                                  Flexible(
                                    child: Text(
                                      baby.name,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 18,
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                  ),
                                  if (model.babies.length > 1)
                                    const Icon(Icons.expand_more, size: 18),
                                ],
                              ),
                              Text(
                                ageAt(baby.birthday, dateLabel(DateTime.now())),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: const TextStyle(
                                  fontSize: 14,
                                  color: galleryMuted,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                      IconButton(
                        key: const ValueKey('baby-edit-profile'),
                        tooltip: '编辑档案',
                        onPressed: () => editBaby(baby),
                        icon: const Icon(Icons.edit_outlined, size: 20),
                      ),
                      ],
                    ),
                  ),
                if (scope == 'library')
                  Row(
                    children: [
                      IconButton(
                        tooltip: '返回成长相册',
                        onPressed: () => setState(() {
                          scope = 'related';
                          allMonths = true;
                        }),
                        icon: const Icon(Icons.arrow_back),
                      ),
                      const Expanded(child: Text('全部已整理媒体')),
                    ],
                  ),
                if (baby != null && scope != 'library') ...[
                  scopeFilters(candidates, reviewCount),
                  Row(
                    children: [
                      TextButton(
                        key: const ValueKey('baby-all-months'),
                        style: TextButton.styleFrom(
                          minimumSize: const Size(48, 48),
                          padding: const EdgeInsets.symmetric(horizontal: 8),
                          foregroundColor: allMonths
                              ? galleryAccent
                              : galleryMuted,
                        ),
                        onPressed: () => setState(() {
                          allMonths = true;
                          selectedAgeMonth = null;
                        }),
                        child: const Text(
                          '全部月份',
                          style: TextStyle(fontSize: 12),
                        ),
                      ),
                      Expanded(
                        child: SizedBox(
                          height: math.max(
                            48,
                            MediaQuery.textScalerOf(context).scale(14) + 24,
                          ),
                          child: ListView.builder(
                            scrollDirection: Axis.horizontal,
                            itemCount: monthAxis.length,
                            reverse: true,
                            itemBuilder: (_, index) {
                              final month =
                                  monthAxis[monthAxis.length - 1 - index];
                              final selected =
                                  !allMonths &&
                                  scope != 'library' &&
                                  month == chosenMonth;
                              return InkWell(
                                key: ValueKey('growth-month-$month'),
                                onTap: () => setState(() {
                                  selectedAgeMonth = month;
                                  allMonths = false;
                                }),
                                child: Container(
                                  padding: const EdgeInsets.symmetric(
                                    horizontal: 14,
                                    vertical: 12,
                                  ),
                                  decoration: BoxDecoration(
                                    border: Border(
                                      bottom: BorderSide(
                                        color: selected
                                            ? galleryAccent
                                            : Colors.transparent,
                                        width: 2,
                                      ),
                                    ),
                                  ),
                                  child: Center(
                                    child: Text(
                                      '$month个月',
                                      maxLines: 1,
                                      style: TextStyle(
                                        fontSize: 14,
                                        color: selected
                                            ? galleryInk
                                            : galleryMuted,
                                        fontWeight: selected
                                            ? FontWeight.w600
                                            : FontWeight.w400,
                                      ),
                                    ),
                                  ),
                                ),
                              );
                            },
                          ),
                        ),
                      ),
                    ],
                  ),
                ],
                MediaQueryBar(
                  prefix: 'baby',
                  leading: baby != null && scope != 'library'
                      ? Tooltip(
                          message: albumLabel,
                          child: InkWell(
                            onTap: scope == 'review' ? showReviewHelp : null,
                            child: SizedBox(
                              height: 48,
                              child: Row(
                                children: [
                                  Expanded(
                                    child: Text(
                                      albumLabel,
                                      maxLines: 1,
                                      overflow: TextOverflow.ellipsis,
                                      style: const TextStyle(
                                        fontSize: 12,
                                        color: galleryMuted,
                                      ),
                                    ),
                                  ),
                                  if (scope == 'review')
                                    const Icon(
                                      Icons.help_outline,
                                      size: 16,
                                      color: galleryMuted,
                                    ),
                                ],
                              ),
                            ),
                          ),
                        )
                      : null,
                  search: search,
                  oldestFirst: oldestFirst,
                  favoritesOnly: favoritesOnly,
                  onSearch: (value) => setState(() => search = value.trim()),
                  onOrder: (value) => setState(() => oldestFirst = value),
                  onFavorites: model.favorites.ready && !model.favorites.saving
                      ? (value) => setState(() => favoritesOnly = value)
                      : null,
                ),
                if (baby != null &&
                    (model.scanning ||
                        model.scanPaused ||
                        model.matching ||
                        model.scanFailures.isNotEmpty))
                  scanSummary(),
                if (kind != 'all')
                  InputChip(
                    label: Text(kind == 'photo' ? '仅照片' : '仅视频'),
                    onDeleted: () => setState(() => kind = 'all'),
                    deleteButtonTooltipMessage: '显示照片和视频',
                  ),
                if (model.notice.isNotEmpty)
                  InkWell(
                    onTap: showTools,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(vertical: 8),
                      child: Text(
                        model.notice,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(fontSize: 12),
                      ),
                    ),
                  ),
                if (baby == null && scope != 'library')
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        const Text('记录宝宝每一天的成长', textAlign: TextAlign.center),
                        const SizedBox(height: 8),
                        const Text(
                          '建立出生档案后，照片就能显示当时的月龄。',
                          textAlign: TextAlign.center,
                        ),
                        const SizedBox(height: 16),
                        FilledButton(
                          onPressed: () => editBaby(),
                          child: const Text('建立宝宝档案'),
                        ),
                        TextButton(
                          onPressed: chooseMedia,
                          child: const Text('选择宝宝照片'),
                        ),
                      ],
                    ),
                  )
                else if (items.isEmpty)
                  Padding(
                    padding: const EdgeInsets.symmetric(vertical: 24),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Text(
                          search.isNotEmpty || favoritesOnly
                              ? '没有符合筛选条件的媒体'
                              : scope == 'review'
                              ? '当前已整理范围没有待核对媒体'
                              : scope == 'candidate'
                              ? '没有疑似照片'
                              : scope == 'library'
                              ? '尚未整理媒体'
                              : '还没有宝宝相关照片',
                          textAlign: TextAlign.center,
                        ),
                        if (baby != null &&
                            baby.references.isEmpty &&
                            scope != 'candidate')
                          const Padding(
                            padding: EdgeInsets.only(top: 8),
                            child: Text(
                              '到相册打开一张宝宝照片，点宝宝整理，选择宝宝的人脸作为参考。',
                              textAlign: TextAlign.center,
                            ),
                          ),
                        TextButton.icon(
                          onPressed: chooseMedia,
                          icon: const Icon(Icons.photo_outlined),
                          label: const Text('选择宝宝照片'),
                        ),
                      ],
                    ),
                  ),
              ],
            ),
          ),
        ),
        for (final group in groups.entries) ...[
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(6, 4, 6, 4),
              child: Row(
                children: [
                  IconButton(
                    tooltip: collapsedMonths.contains(group.key)
                        ? '展开月份'
                        : '折叠月份',
                    onPressed: () => setState(() {
                      if (!collapsedMonths.add(group.key)) {
                        collapsedMonths.remove(group.key);
                      }
                    }),
                    icon: Icon(
                      collapsedMonths.contains(group.key)
                          ? Icons.chevron_right
                          : Icons.expand_more,
                      size: 20,
                    ),
                  ),
                  Text(
                    group.key.isEmpty
                        ? '日期待确认'
                        : '${DateTime.parse('${group.key}-01').year}年${DateTime.parse('${group.key}-01').month}月',
                    style: const TextStyle(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(width: 8),
                  Text(
                    '${group.value.length}项',
                    style: const TextStyle(fontSize: 12, color: galleryMuted),
                  ),
                ],
              ),
            ),
          ),
          if (!collapsedMonths.contains(group.key))
            SliverPadding(
              padding: const EdgeInsets.symmetric(horizontal: 3),
              sliver: SliverGrid(
                delegate: SliverChildBuilderDelegate(
                  (_, index) => mediaTile(group.value[index], baby),
                  childCount: group.value.length,
                ),
                gridDelegate: const SliverGridDelegateWithFixedCrossAxisCount(
                  crossAxisCount: 3,
                  mainAxisSpacing: 3,
                  crossAxisSpacing: 3,
                ),
              ),
            ),
        ],
        const SliverToBoxAdapter(child: SizedBox(height: 24)),
      ],
    );
  }
}
