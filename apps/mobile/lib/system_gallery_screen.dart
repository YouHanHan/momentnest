import 'dart:async';
import 'dart:io';
import 'dart:typed_data';
import 'package:flutter/material.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:video_player/video_player.dart';
import 'system_gallery.dart';
import 'gallery_year_field.dart';
import 'models.dart';
import 'gallery_style.dart';
import 'preview_swipe_navigation.dart';
import 'preview_layout.dart';
import 'backup_catalog.dart';
import 'gallery_backup_controller.dart';
import 'media_favorites.dart';
import 'media_query_bar.dart';

/// 直接浏览系统相册；多选后才显示传输操作。
class SystemGalleryScreen extends StatefulWidget {
  const SystemGalleryScreen({
    super.key,
    required this.controller,
    required this.onUpload,
    required this.onOrganize,
    this.canUpload = true,
    this.canOrganize = true,
    this.actionsChanged,
    this.uploadAvailable,
    this.organizeAvailable,
    this.onSelectionChanged,
    this.onSettings,
    this.backup,
    this.favorites,
    this.onBackupUpload,
    this.onPick,
    this.title = '相册',
  });
  final SystemGalleryController controller;
  final Future<bool> Function(Set<String> ids) onUpload;
  final Future<void> Function(AssetEntity asset) onOrganize;
  final bool canUpload, canOrganize;
  final Listenable? actionsChanged;
  final bool Function()? uploadAvailable, organizeAvailable;
  final ValueChanged<bool>? onSelectionChanged;
  final VoidCallback? onSettings;
  final GalleryBackupController? backup;
  final MediaFavorites? favorites;
  final Future<bool> Function(Set<String> ids, bool restoreMissing)?
  onBackupUpload;
  final Future<void> Function(AssetEntity asset)? onPick;
  final String title;

  @override
  State<SystemGalleryScreen> createState() => _SystemGalleryScreenState();
}

class _SystemGalleryScreenState extends State<SystemGalleryScreen> {
  final selected = <String>{};
  late Listenable _viewChanges;
  bool selecting = false, sending = false, collectingMonth = false;
  int _selectionEpoch = 0;
  SystemGalleryController get model => widget.controller;
  List<AssetEntity> get visibleAssets => widget.backup?.visible ?? model.assets;
  bool get canUpload => widget.uploadAvailable?.call() ?? widget.canUpload;
  bool get canOrganize =>
      widget.organizeAvailable?.call() ?? widget.canOrganize;

  /// 参考选图直接交给调用方，避免再次进入普通预览和上传多选。
  Future<void> pick(AssetEntity asset) async {
    if (sending) return;
    setState(() => sending = true);
    try {
      await widget.onPick!(asset);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('读取照片失败，请重试。$error')));
      }
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  /// 选择状态同步给首页，连接电脑或回到应用时保留当前批次。
  void updateSelection(VoidCallback change) {
    setState(change);
    widget.onSelectionChanged?.call(selecting);
  }

  void cancelSelection() => updateSelection(() {
    _selectionEpoch++;
    collectingMonth = false;
    selected.clear();
    selecting = false;
  });

  /// 整月全选只分批收集当前查询的 ID，不改变浏览分页或读取原图。
  Future<void> selectAll() async {
    if (sending ||
        collectingMonth ||
        model.loading ||
        widget.backup?.readingFilter == true) {
      return;
    }
    if (model.month == null) {
      updateSelection(() {
        selecting = true;
        selected.addAll(visibleAssets.map((asset) => asset.id));
      });
      return;
    }
    final epoch = ++_selectionEpoch;
    final gallery = model;
    final generation = model.generation;
    final filter = widget.backup?.filter ?? 'all';
    final ids = <String>{};
    bool current() =>
        mounted &&
        epoch == _selectionEpoch &&
        identical(gallery, model) &&
        generation == model.generation &&
        filter == (widget.backup?.filter ?? 'all');
    updateSelection(() {
      selecting = true;
      collectingMonth = true;
    });
    try {
      await for (final batch in gallery.verificationPages()) {
        if (!current()) return;
        ids.addAll(
          batch
              .where(
                (asset) =>
                    filter == 'all' || widget.backup?.state(asset) == filter,
              )
              .map((asset) => asset.id),
        );
        // 每批让出事件循环，取消和界面操作无需等待整月读取完毕。
        await Future<void>.delayed(Duration.zero);
        if (!current()) return;
      }
      if (!current()) return;
      updateSelection(() {
        selected
          ..clear()
          ..addAll(ids);
      });
    } catch (_) {
      if (mounted && current()) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('本月未能完整全选，请重试；已有选择保留。')));
      }
    } finally {
      if (mounted && epoch == _selectionEpoch) {
        setState(() => collectingMonth = false);
      }
    }
  }

  @override
  void initState() {
    super.initState();
    if (widget.favorites != null) model.attachFavorites(widget.favorites!);
    _viewChanges = Listenable.merge([
      model,
      if (widget.backup != null) widget.backup!,
      if (widget.favorites != null) widget.favorites!,
    ]);
    model.addListener(resetSelectionOnRefresh);
  }

  @override
  void didUpdateWidget(covariant SystemGalleryScreen oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.favorites != null) model.attachFavorites(widget.favorites!);
    if (oldWidget.controller != widget.controller) {
      oldWidget.controller.removeListener(resetSelectionOnRefresh);
      model.addListener(resetSelectionOnRefresh);
    }
    if (oldWidget.controller != widget.controller ||
        oldWidget.backup != widget.backup ||
        oldWidget.favorites != widget.favorites) {
      _viewChanges = Listenable.merge([
        model,
        if (widget.backup != null) widget.backup!,
        if (widget.favorites != null) widget.favorites!,
      ]);
    }
  }

  /// 授权或筛选重新读取时清空旧选择，避免传输已经不可访问的媒体。
  void resetSelectionOnRefresh() {
    if (model.loading && (selecting || selected.isNotEmpty) && mounted) {
      cancelSelection();
    }
  }

  @override
  void dispose() {
    _selectionEpoch++;
    model.removeListener(resetSelectionOnRefresh);
    super.dispose();
  }

  void toggle(String id) => updateSelection(() {
    selecting = true;
    if (!selected.add(id)) selected.remove(id);
  });

  Future<void> send() async {
    setState(() => sending = true);
    try {
      if (await widget.onUpload(Set.of(selected)) && mounted) {
        cancelSelection();
      }
    } finally {
      if (mounted) setState(() => sending = false);
    }
  }

  Future<void> preview(AssetEntity asset) {
    final items = List<AssetEntity>.of(visibleAssets);
    final generation = model.generation;
    return Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => AnimatedBuilder(
          animation: widget.actionsChanged ?? _viewChanges,
          builder: (_, _) => SystemMediaPreview(
            asset: asset,
            favorites: widget.favorites,
            sequence: items,
            onLoadMore: () async {
              if (model.generation != generation) return [];
              await model.loadMore();
              if (model.generation != generation) return [];
              if (model.notice.isNotEmpty) throw StateError(model.notice);
              return visibleAssets;
            },
            onUpload: canUpload
                ? (current) => widget.onUpload({current.id})
                : null,
            onOrganize: canOrganize ? widget.onOrganize : null,
            onBackupInfo: widget.backup == null ? null : showBackupInfo,
          ),
        ),
      ),
    );
  }

  /// 月份直接交给系统查询，不为生成月份列表读取整库。
  Future<void> pickMonth() async {
    var date = model.month ?? DateTime.now();
    var yearsReady = false;
    final selectedMonth = await showDialog<DateTime>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: const Text('选择月份'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                GalleryYearField(
                  initialYear: date.year,
                  loadYears: () => model.loadYears(),
                  onChanged: (year) {
                    update(() {
                      date = DateTime(year, date.month);
                      yearsReady = true;
                    });
                  },
                ),
                const SizedBox(height: 12),
                DropdownButtonFormField<int>(
                  initialValue: date.month,
                  isExpanded: true,
                  decoration: const InputDecoration(labelText: '月份'),
                  items: [
                    for (var month = 1; month <= 12; month++)
                      DropdownMenuItem(value: month, child: Text('$month月')),
                  ],
                  onChanged: (month) {
                    if (month != null) {
                      update(() => date = DateTime(date.year, month));
                    }
                  },
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () {
                Navigator.pop(context);
                unawaited(model.setMonth(null));
              },
              child: const Text('全部月份'),
            ),
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: yearsReady ? () => Navigator.pop(context, date) : null,
              child: Text(widget.onPick == null ? '全选本月' : '查看'),
            ),
          ],
        ),
      ),
    );
    if (selectedMonth != null && mounted) {
      await model.setMonth(selectedMonth);
      if (mounted && widget.onPick == null && model.notice.isEmpty) {
        await selectAll();
      }
    }
  }

  Map<String, List<AssetEntity>> get dateGroups {
    final groups = <String, List<AssetEntity>>{};
    for (final asset in visibleAssets) {
      final date = (asset.createDateSecond ?? 0) > 0
          ? dateLabel(asset.createDateTime)
          : '';
      groups.putIfAbsent(date, () => []).add(asset);
    }
    return groups;
  }

  @override
  Widget build(BuildContext context) => AnimatedBuilder(
    animation: _viewChanges,
    builder: (context, _) => Column(
      children: [
        Padding(
          padding: const EdgeInsets.fromLTRB(16, 8, 8, 4),
          child: Row(
            children: [
              Expanded(
                child: Text(
                  collectingMonth
                      ? '正在全选本月…'
                      : selecting
                      ? '已选 ${selected.length} 项'
                      : widget.title,
                  style: const TextStyle(
                    fontSize: 22,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              if (selecting)
                TextButton(
                  key: const ValueKey('gallery-cancel-selection'),
                  onPressed: sending ? null : cancelSelection,
                  child: const Text('取消'),
                )
              else ...[
                if (model.assets.isNotEmpty && widget.onPick == null)
                  TextButton(
                    key: const ValueKey('gallery-select'),
                    onPressed: model.loading
                        ? null
                        : () => updateSelection(() => selecting = true),
                    child: const Text('选择'),
                  ),
                PopupMenuButton<String>(
                  tooltip: '相册操作',
                  onSelected: (value) {
                    switch (value) {
                      case 'select':
                        updateSelection(() => selecting = true);
                      case 'refresh':
                        unawaited(model.refresh());
                      case 'access':
                        unawaited(model.manageAccess());
                      case 'all':
                        unawaited(model.setType(RequestType.common));
                      case 'photo':
                        unawaited(model.setType(RequestType.image));
                      case 'video':
                        unawaited(model.setType(RequestType.video));
                      case 'settings':
                        widget.onSettings?.call();
                    }
                  },
                  itemBuilder: (_) => [
                    if (model.assets.isNotEmpty && widget.onPick == null)
                      const PopupMenuItem(value: 'select', child: Text('选择照片')),
                    const PopupMenuItem(value: 'refresh', child: Text('刷新相册')),
                    const PopupMenuItem(value: 'access', child: Text('管理相册权限')),
                    if (widget.onPick == null) ...[
                      const PopupMenuItem(value: 'all', child: Text('照片和视频')),
                      const PopupMenuItem(value: 'photo', child: Text('只看照片')),
                      const PopupMenuItem(value: 'video', child: Text('只看视频')),
                    ],
                    if (widget.onSettings != null)
                      const PopupMenuItem(value: 'settings', child: Text('设置')),
                  ],
                ),
              ],
            ],
          ),
        ),
        if (model.authorized)
          MediaQueryBar(
            prefix: 'gallery',
            search: model.search,
            oldestFirst: model.oldestFirst,
            favoritesOnly: model.favoritesOnly,
            showFavorites: widget.favorites != null && widget.onPick == null,
            leading: TextButton(
              key: const ValueKey('gallery-month'),
              onPressed: selecting || model.loading ? null : pickMonth,
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Flexible(
                    child: Text(
                      model.month != null
                          ? '${model.month!.year}年${model.month!.month}月'
                          : '全部月份',
                      overflow: TextOverflow.ellipsis,
                      style: const TextStyle(
                        color: galleryInk,
                        fontSize: 16,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                  ),
                  const Icon(Icons.chevron_right, size: 20, color: galleryInk),
                ],
              ),
            ),
            onSearch: (value) => unawaited(model.setQuery(search: value)),
            onOrder: (value) => unawaited(model.setQuery(oldestFirst: value)),
            onFavorites:
                widget.favorites?.ready == true &&
                    widget.favorites?.saving == false
                ? (value) => unawaited(model.setQuery(favoritesOnly: value))
                : null,
          ),
        if (widget.favorites?.notice.isNotEmpty == true)
          TextButton(
            onPressed: widget.favorites!.initialize,
            child: Text(widget.favorites!.notice),
          ),
        if (widget.backup?.transfer.connection != null && widget.onPick == null)
          backupPanel(),
        if (model.limited)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 0, 8, 4),
            child: Row(
              children: [
                const Expanded(
                  child: Text('仅显示已授权的照片和视频', style: TextStyle(fontSize: 12)),
                ),
                TextButton(
                  onPressed: model.loading ? null : model.manageAccess,
                  child: const Text('调整'),
                ),
              ],
            ),
          ),
        if (model.loading || sending || collectingMonth)
          const LinearProgressIndicator(minHeight: 2),
        Expanded(
          child: model.assets.isEmpty
              ? emptyState()
              : RefreshIndicator(
                  onRefresh: () async {
                    if (!selecting) await model.refresh();
                  },
                  child: NotificationListener<ScrollNotification>(
                    onNotification: (notification) {
                      if (notification.metrics.extentAfter < 600 &&
                          model.hasMore &&
                          !model.loadingMore &&
                          !model.loading &&
                          model.notice.isEmpty) {
                        unawaited(model.loadMore());
                      }
                      return false;
                    },
                    child: CustomScrollView(
                      key: const PageStorageKey('system-gallery-grid'),
                      physics: const AlwaysScrollableScrollPhysics(),
                      slivers: [
                        if (visibleAssets.isEmpty)
                          const SliverToBoxAdapter(
                            child: Padding(
                              padding: EdgeInsets.all(24),
                              child: Text(
                                '当前没有符合筛选条件的照片或视频。',
                                textAlign: TextAlign.center,
                              ),
                            ),
                          ),
                        for (final group in dateGroups.entries) ...[
                          SliverToBoxAdapter(
                            child: Padding(
                              padding: const EdgeInsets.fromLTRB(6, 12, 6, 8),
                              child: Row(
                                children: [
                                  Text(
                                    mediaDateHeading(group.key),
                                    style: const TextStyle(
                                      fontWeight: FontWeight.w600,
                                    ),
                                  ),
                                  const SizedBox(width: 8),
                                  Text(
                                    '${group.value.length}项',
                                    style: const TextStyle(
                                      color: galleryMuted,
                                      fontSize: 12,
                                    ),
                                  ),
                                ],
                              ),
                            ),
                          ),
                          SliverPadding(
                            padding: const EdgeInsets.symmetric(horizontal: 3),
                            sliver: SliverGrid(
                              gridDelegate:
                                  const SliverGridDelegateWithFixedCrossAxisCount(
                                    crossAxisCount: 3,
                                    mainAxisSpacing: 3,
                                    crossAxisSpacing: 3,
                                  ),
                              delegate: SliverChildBuilderDelegate((
                                context,
                                index,
                              ) {
                                final asset = group.value[index];
                                return SystemPhotoTile(
                                  key: ValueKey(
                                    'gallery:${asset.id}:${asset.modifiedDateSecond}',
                                  ),
                                  asset: asset,
                                  favorite:
                                      widget.favorites?.isFavorite(asset) ==
                                      true,
                                  backupLabel: widget.backup == null
                                      ? null
                                      : galleryBackupLabels[widget.backup!
                                            .state(asset)],
                                  onBackupInfo: widget.backup == null
                                      ? null
                                      : () => showBackupInfo(asset),
                                  selecting: selecting,
                                  selected: selected.contains(asset.id),
                                  onTap: sending || collectingMonth
                                      ? null
                                      : () => widget.onPick != null
                                            ? pick(asset)
                                            : selecting
                                            ? toggle(asset.id)
                                            : preview(asset),
                                  onLongPress:
                                      sending ||
                                          collectingMonth ||
                                          widget.onPick != null
                                      ? null
                                      : () => toggle(asset.id),
                                );
                              }, childCount: group.value.length),
                            ),
                          ),
                        ],
                        SliverToBoxAdapter(
                          child: Padding(
                            padding: const EdgeInsets.all(16),
                            child: model.loadingMore
                                ? const Center(
                                    child: SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    ),
                                  )
                                : model.hasMore
                                ? Center(
                                    child: TextButton(
                                      onPressed: model.loadMore,
                                      child: Text(
                                        model.notice.isEmpty
                                            ? '查看更多'
                                            : '加载失败，点此重试',
                                      ),
                                    ),
                                  )
                                : const SizedBox(height: 8),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
        ),
        if (selecting)
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 8, 16, 12),
            child: Wrap(
              alignment: WrapAlignment.spaceBetween,
              spacing: 12,
              children: [
                TextButton(
                  key: const ValueKey('gallery-select-all'),
                  onPressed:
                      sending ||
                          collectingMonth ||
                          widget.backup?.readingFilter == true
                      ? null
                      : selectAll,
                  child: Text(model.month == null ? '全选已加载媒体' : '全选本月筛选结果'),
                ),
                FilledButton.icon(
                  onPressed:
                      selected.isEmpty ||
                          sending ||
                          collectingMonth ||
                          !canUpload
                      ? null
                      : send,
                  icon: const Icon(Icons.upload_outlined, size: 18),
                  label: Text(sending ? '正在核对…' : '传到电脑'),
                ),
              ],
            ),
          ),
      ],
    ),
  );

  /// 相册直接提供核对和三种保存状态，未知状态只作为过程说明。
  Widget backupPanel() {
    final backup = widget.backup!;
    return Padding(
      padding: const EdgeInsets.fromLTRB(12, 0, 12, 6),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Expanded(
                child: Text(
                  '${backup.targetLabel}${backup.transfer.online ? '' : ' · 上次核对结果'}',
                  style: const TextStyle(fontSize: 12, color: galleryMuted),
                  maxLines: 2,
                ),
              ),
              TextButton.icon(
                key: const ValueKey('gallery-check-backup'),
                onPressed: backup.checking
                    ? () => backup.transfer.stopChecking(pause: true)
                    : backup.canCheck
                    ? backup.check
                    : null,
                icon: Icon(
                  backup.checking ? Icons.pause : Icons.fact_check_outlined,
                  size: 18,
                ),
                label: Text(backup.checking ? '暂停核对' : '核对电脑'),
              ),
            ],
          ),
          Wrap(
            spacing: 6,
            children: [
              for (final entry in const {
                'all': '全部',
                'uploaded': '已传入',
                'pending': '未传入',
                'missing': '需补传',
              }.entries)
                ChoiceChip(
                  key: ValueKey('gallery-backup-filter-${entry.key}'),
                  label: Text(entry.value),
                  selected: backup.filter == entry.key,
                  onSelected: selecting || sending
                      ? null
                      : (_) => backup.setFilter(entry.key),
                ),
            ],
          ),
          if (backup.checking) ...[
            const LinearProgressIndicator(minHeight: 2),
            Text(
              backup.transfer.checkProgress,
              style: const TextStyle(fontSize: 12),
            ),
          ],
          if (backup.readingFilter)
            const Text('正在读取范围内的后续照片…', style: TextStyle(fontSize: 12)),
          if (backup.notice.isNotEmpty)
            Text(backup.notice, style: const TextStyle(fontSize: 12)),
          if (backup.transfer.checkNotice.isNotEmpty)
            Text(
              backup.transfer.checkNotice,
              style: const TextStyle(fontSize: 12),
            ),
          if (['pending', 'missing'].contains(backup.filter))
            TextButton.icon(
              key: const ValueKey('gallery-upload-backup-filter'),
              onPressed:
                  !canUpload ||
                      backup.readingFilter ||
                      backup.checking ||
                      sending ||
                      backup.idsFor(backup.filter).isEmpty ||
                      widget.onBackupUpload == null
                  ? null
                  : () async {
                      setState(() => sending = true);
                      try {
                        await widget.onBackupUpload!(
                          backup.idsFor(backup.filter),
                          backup.filter == 'missing',
                        );
                      } finally {
                        if (mounted) setState(() => sending = false);
                      }
                    },
              icon: const Icon(Icons.upload_outlined, size: 18),
              label: Text(
                '${backup.filter == 'missing' ? '补传缺失' : '上传未传入'} · ${backup.idsFor(backup.filter).length} 项',
              ),
            ),
        ],
      ),
    );
  }

  /// 保存详情展示本次证据与历史回执，离线记录注明核对时间。
  Future<void> showBackupInfo(AssetEntity asset) async {
    final backup = widget.backup!;
    final info = backup.record(asset);
    final state = backup.state(asset);
    final receipt = info?['receipt'] ?? info?['previousReceipt'];
    final matches = (info?['matches'] as List? ?? [])
        .map((item) => item['path'])
        .join('\n');
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('备份信息'),
        content: SingleChildScrollView(
          child: Text(
            [
              backup.targetLabel,
              galleryBackupLabels[state]!,
              if (!backup.transfer.online) '电脑离线，以下为上次核对结果。',
              if (state == 'unknown')
                info?['receiptState'] == 'unavailable'
                    ? '电脑目录或文件暂时无法读取，不能判定丢失。'
                    : '尚未确认当前原文件，连接电脑后点击核对。',
              if (state == 'missing')
                info?['receiptState'] == 'corrupt'
                    ? '电脑保存的文件内容已变化，需要补传。'
                    : '此前已成功保存，电脑对应文件目前缺失。',
              if (receipt != null) '保存位置：${receipt['relativePath']}',
              if (receipt?['savedAt'] != null) '历史保存时间：${receipt['savedAt']}',
              if (matches.isNotEmpty) '其他目录已有：\n$matches',
              if (info?['checkedAt'] != null) '最近核对：${info!['checkedAt']}',
              if (backup.transfer.checkErrors[asset.id] != null)
                backup.transfer.checkErrors[asset.id]!,
              if (info?['checkError'] != null &&
                  backup.transfer.checkErrors[asset.id] == null)
                info!['checkError'] as String,
            ].join('\n\n'),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('关闭'),
          ),
        ],
      ),
    );
  }

  Widget emptyState() => Center(
    child: SingleChildScrollView(
      padding: const EdgeInsets.all(28),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(
            Icons.photo_library_outlined,
            size: 48,
            color: Color(0xFFA19488),
          ),
          const SizedBox(height: 20),
          Text(
            model.loading || !model.ready
                ? '正在读取手机相册…'
                : !model.authorized
                ? '查看手机里的照片和视频'
                : '相册里暂无符合条件的照片和视频',
            textAlign: TextAlign.center,
            style: const TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
          ),
          const SizedBox(height: 8),
          Text(
            model.notice.isNotEmpty ? model.notice : '直接读取系统相册，无需导入。',
            textAlign: TextAlign.center,
            style: TextStyle(
              color: Theme.of(context).colorScheme.onSurfaceVariant,
            ),
          ),
          if (model.ready && !model.loading) ...[
            const SizedBox(height: 20),
            FilledButton(
              onPressed: model.authorized ? model.refresh : model.requestAccess,
              child: Text(model.authorized ? '刷新相册' : '允许访问相册'),
            ),
            if (!model.authorized)
              TextButton(
                onPressed: model.manageAccess,
                child: const Text('管理相册权限'),
              ),
          ],
        ],
      ),
    ),
  );
}

/// 只有进入多选时显示选择标记，视频角标保留时长。
class SystemPhotoTile extends StatefulWidget {
  const SystemPhotoTile({
    super.key,
    required this.asset,
    required this.selecting,
    required this.selected,
    this.onTap,
    this.onLongPress,
    this.backupLabel,
    this.onBackupInfo,
    this.favorite = false,
  });
  final AssetEntity asset;
  final bool selecting, selected;
  final VoidCallback? onTap, onLongPress;
  final String? backupLabel;
  final VoidCallback? onBackupInfo;
  final bool favorite;
  @override
  State<SystemPhotoTile> createState() => _SystemPhotoTileState();
}

class _SystemPhotoTileState extends State<SystemPhotoTile> {
  late final thumbnail = widget.asset.thumbnailDataWithSize(
    const ThumbnailSize(300, 300),
  );
  @override
  Widget build(BuildContext context) => Semantics(
    label:
        '${widget.asset.type == AssetType.video ? '视频' : '照片'} ${widget.asset.title ?? ''}',
    selected: widget.selected,
    button: true,
    child: Material(
      color: gallerySelected,
      borderRadius: BorderRadius.circular(8),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: widget.onTap,
        onLongPress: widget.onLongPress,
        child: Stack(
          fit: StackFit.expand,
          children: [
            FutureBuilder<Uint8List?>(
              future: thumbnail,
              builder: (context, snapshot) => snapshot.hasData
                  ? Image.memory(
                      snapshot.data!,
                      fit: BoxFit.cover,
                      errorBuilder: (_, _, _) =>
                          const Icon(Icons.image_outlined),
                    )
                  : const Icon(Icons.image_outlined, color: galleryMuted),
            ),
            if (widget.selected) const ColoredBox(color: Color(0x44000000)),
            if (widget.favorite)
              const Positioned(
                bottom: 6,
                left: 6,
                child: Icon(Icons.favorite, color: Colors.white, size: 18),
              ),
            if (widget.backupLabel != null)
              Positioned(
                top: 4,
                left: 4,
                right: widget.selecting ? 32 : 4,
                child: GestureDetector(
                  onTap: widget.onBackupInfo,
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: widget.backupLabel == '需补传'
                          ? const Color(0xDDAD5A25)
                          : Colors.black54,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 4,
                        vertical: 3,
                      ),
                      child: Text(
                        widget.backupLabel!,
                        overflow: TextOverflow.ellipsis,
                        style: const TextStyle(
                          color: Colors.white,
                          fontSize: 10,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            if (widget.selecting)
              Positioned(
                top: 8,
                right: 8,
                child: Icon(
                  widget.selected
                      ? Icons.check_circle
                      : Icons.radio_button_unchecked,
                  color: widget.selected ? galleryGreen : Colors.white,
                  size: 23,
                  shadows: const [Shadow(color: Colors.black38, blurRadius: 4)],
                ),
              ),
            if (widget.asset.type == AssetType.video)
              Positioned(
                bottom: 6,
                right: 6,
                child: DecoratedBox(
                  decoration: BoxDecoration(
                    color: Colors.black54,
                    borderRadius: BorderRadius.circular(4),
                  ),
                  child: Padding(
                    padding: const EdgeInsets.symmetric(
                      horizontal: 5,
                      vertical: 2,
                    ),
                    child: Text(
                      '${widget.asset.duration ~/ 60}:${(widget.asset.duration % 60).toString().padLeft(2, '0')}',
                      style: const TextStyle(color: Colors.white, fontSize: 11),
                    ),
                  ),
                ),
              ),
          ],
        ),
      ),
    ),
  );
}

/// 预览直接打开系统原文件，只有选择宝宝整理或上传时才计算内容指纹。
class SystemMediaPreview extends StatefulWidget {
  const SystemMediaPreview({
    super.key,
    required this.asset,
    this.sequence = const [],
    this.onLoadMore,
    this.onOrganize,
    this.onUpload,
    this.onBackupInfo,
    this.favorites,
  });
  final AssetEntity asset;
  final List<AssetEntity> sequence;
  final Future<List<AssetEntity>> Function()? onLoadMore;
  final Future<void> Function(AssetEntity asset)? onOrganize;
  final Future<bool> Function(AssetEntity asset)? onUpload;
  final Future<void> Function(AssetEntity asset)? onBackupInfo;
  final MediaFavorites? favorites;
  @override
  State<SystemMediaPreview> createState() => _SystemMediaPreviewState();
}

class _SystemMediaPreviewState extends State<SystemMediaPreview> {
  File? file;
  VideoPlayerController? player;
  bool loading = true, working = false;
  bool loadingMore = false;
  bool hasMore = false;
  String error = '';
  int index = 0, epoch = 0;
  final transform = TransformationController();
  late final List<AssetEntity> sequence;
  AssetEntity get asset => sequence[index];

  @override
  void initState() {
    super.initState();
    widget.favorites?.addListener(favoritesChanged);
    hasMore = widget.onLoadMore != null;
    sequence = widget.sequence.isEmpty
        ? [widget.asset]
        : List.of(widget.sequence);
    index = sequence.indexWhere((item) => item.id == widget.asset.id);
    if (index < 0) {
      sequence.insert(0, widget.asset);
      index = 0;
    }
    unawaited(load());
  }

  void favoritesChanged() {
    if (mounted) setState(() {});
  }

  Future<void> toggleFavorite() async {
    try {
      await widget.favorites!.toggle(asset);
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('收藏保存失败：$error')));
      }
    }
  }

  /// 切图后只接纳当前原文件读取，旧视频初始化完成也不会覆盖画面。
  Future<void> load() async {
    final request = ++epoch, current = asset;
    final previous = player;
    setState(() {
      loading = true;
      error = '';
      file = null;
      player = null;
      transform.value = Matrix4.identity();
    });
    await previous?.dispose();
    VideoPlayerController? pending;
    try {
      final value = await current.originFile;
      if (!mounted || request != epoch) return;
      if (value == null) throw StateError('暂时无法读取原文件，请检查相册权限。');
      if (current.type == AssetType.video) {
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
    } catch (_) {
      await pending?.dispose();
      if (mounted && request == epoch) {
        setState(() => error = '暂时无法预览此文件，可检查权限或直接传到电脑。');
      }
    } finally {
      if (mounted && request == epoch) setState(() => loading = false);
    }
  }

  /// 沿当前相册顺序切换，滑到已加载末尾才请求下一页。
  Future<bool> move(int delta) async {
    if (working || loadingMore) return false;
    final next = index + delta;
    if (next < 0) return false;
    if (next >= sequence.length && hasMore) {
      setState(() => loadingMore = true);
      try {
        final more = await widget.onLoadMore!();
        if (!mounted) return false;
        final ids = sequence.map((item) => item.id).toSet();
        final previousLength = sequence.length;
        sequence.addAll(more.where((item) => ids.add(item.id)));
        hasMore = sequence.length > previousLength;
      } catch (_) {
        if (mounted) {
          ScaffoldMessenger.of(
            context,
          ).showSnackBar(const SnackBar(content: Text('下一页暂时无法读取，请重试。')));
        }
      } finally {
        if (mounted) setState(() => loadingMore = false);
      }
    }
    if (!mounted || next >= sequence.length) return false;
    setState(() => index = next);
    unawaited(load());
    return true;
  }

  Future<void> organize() async {
    setState(() => working = true);
    try {
      await player?.pause();
      await widget.onOrganize?.call(asset);
    } finally {
      if (mounted) setState(() => working = false);
    }
  }

  Future<void> upload() async {
    setState(() => working = true);
    try {
      await player?.pause();
      final accepted = await widget.onUpload?.call(asset) ?? false;
      if (accepted && mounted) Navigator.pop(context);
    } finally {
      if (mounted) setState(() => working = false);
    }
  }

  @override
  void dispose() {
    epoch++;
    widget.favorites?.removeListener(favoritesChanged);
    player?.dispose();
    transform.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => PreviewLayout(
    canHideControls: !working && !loadingMore,
    topBar: AppBar(
      toolbarHeight: (MediaQuery.textScalerOf(context).scale(28) * 1.5 + 8)
          .clamp(kToolbarHeight, double.infinity),
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      foregroundColor: Colors.white,
      title: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            (asset.createDateSecond ?? 0) > 0
                ? '${asset.createDateTime.year}年${asset.createDateTime.month}月${asset.createDateTime.day}日'
                : '日期未知',
            style: const TextStyle(fontSize: 16, color: Colors.white),
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
          ),
          if (sequence.length > 1 || widget.onLoadMore != null)
            Text(
              '${index + 1} / ${sequence.length}',
              style: const TextStyle(color: Colors.white70, fontSize: 12),
            ),
        ],
      ),
      actions: [
        if (widget.favorites != null)
          IconButton(
            key: const ValueKey('system-preview-favorite'),
            tooltip: widget.favorites!.isFavorite(asset) ? '取消收藏' : '收藏',
            onPressed: !widget.favorites!.ready || widget.favorites!.saving
                ? null
                : toggleFavorite,
            icon: Icon(
              widget.favorites!.isFavorite(asset)
                  ? Icons.favorite
                  : Icons.favorite_outline,
            ),
          ),
      ],
    ),
    canvas: PreviewSwipeNavigation(
      key: const ValueKey('system-preview-canvas'),
      transform: transform,
      enabled: !working && !loadingMore,
      canMove: (delta) =>
          index + delta >= 0 && (index + delta < sequence.length || hasMore),
      onMove: move,
      child: SizedBox.expand(
        child: loading
            ? const Center(child: CircularProgressIndicator())
            : Center(
                child: error.isNotEmpty
                    ? Padding(
                        padding: const EdgeInsets.all(28),
                        child: Text(
                          error,
                          style: const TextStyle(color: Colors.white70),
                          textAlign: TextAlign.center,
                        ),
                      )
                    : player != null
                    ? AspectRatio(
                        aspectRatio: player!.value.aspectRatio,
                        child: VideoPlayer(player!),
                      )
                    : InteractiveViewer(
                        transformationController: transform,
                        minScale: 1,
                        maxScale: 5,
                        child: SizedBox.expand(
                          child: Image.file(
                            file!,
                            fit: BoxFit.contain,
                            errorBuilder: (_, _, _) => const Text(
                              '系统暂无法预览此格式',
                              style: TextStyle(color: Colors.white70),
                            ),
                          ),
                        ),
                      ),
              ),
      ),
    ),
    bottomBar: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        if (player != null) ...[
          VideoProgressIndicator(player!, allowScrubbing: true),
        ],
        if (working || loadingMore) const LinearProgressIndicator(minHeight: 2),
        Row(
          key: const ValueKey('system-preview-actions'),
          children: [
            if (player != null)
              ValueListenableBuilder<VideoPlayerValue>(
                valueListenable: player!,
                builder: (_, value, _) => IconButton(
                  tooltip: value.isPlaying ? '暂停' : '播放',
                  color: Colors.white,
                  icon: Icon(
                    value.isPlaying ? Icons.pause_circle : Icons.play_circle,
                  ),
                  onPressed: () =>
                      value.isPlaying ? player!.pause() : player!.play(),
                ),
              ),
            if (widget.onBackupInfo != null)
              IconButton(
                key: const ValueKey('system-preview-backup-info'),
                tooltip: '备份信息',
                onPressed: () => widget.onBackupInfo!(asset),
                color: Colors.white,
                icon: const Icon(Icons.fact_check_outlined, size: 18),
              ),
            Expanded(
              child: TextButton(
                onPressed:
                    working ||
                        loadingMore ||
                        loading ||
                        widget.onOrganize == null
                    ? null
                    : organize,
                style: TextButton.styleFrom(
                  foregroundColor: Colors.white,
                  minimumSize: const Size(48, 48),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                ),
                child: const Text(
                  '宝宝整理',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
            Expanded(
              child: FilledButton(
                onPressed:
                    working || loadingMore || loading || widget.onUpload == null
                    ? null
                    : upload,
                style: FilledButton.styleFrom(
                  minimumSize: const Size(48, 48),
                  padding: const EdgeInsets.symmetric(horizontal: 4),
                ),
                child: const Text(
                  '传到电脑',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}
