import 'dart:async';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'models.dart';
import 'pairing_screen.dart';
import 'transfer_controller.dart';
import 'transfer_task_screen.dart';
import 'backup_catalog.dart';
import 'month_scan.dart';
import 'family_controller.dart';
import 'family_models.dart';
import 'baby_screen.dart';
import 'media_preview.dart';
import 'system_gallery.dart';
import 'gallery_year_field.dart';
import 'system_gallery_screen.dart';
import 'transfer_batch_screen.dart';
import 'gallery_style.dart';
import 'gallery_backup_controller.dart';

/// 承载开发初期的空状态和归档偏好；不产生模拟上传记录。
class HomeScreen extends StatefulWidget {
  const HomeScreen({
    super.key,
    this.controller,
    this.familyController,
    this.galleryController,
  });
  final TransferController? controller;
  final FamilyController? familyController;
  final SystemGalleryController? galleryController;
  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late final model = widget.controller ?? TransferController();
  late final family = widget.familyController ?? FamilyController(model);
  late final gallery = widget.galleryController ?? SystemGalleryController();
  late final backup = GalleryBackupController(gallery, model);
  late final previewChanges = Listenable.merge([model, family, backup]);
  int page = 0;
  bool _babyScanStarted = false, _backupOpen = false, _referenceOpen = false;
  bool _selectingGallery = false, _galleryRefreshPending = false;
  bool _exitConfirmationOpen = false;
  static const labels = {
    'unknown': '待核对',
    'pending': '未备份',
    'uploaded': '已备份 · 当前目录',
    'exists': '已备份 · 其他目录',
    'missing': '需补传 · 当前目录文件缺失或损坏',
    ...transferTaskStateLabels,
  };
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    model.addListener(refresh);
    family.addListener(refresh);
    gallery.addListener(refresh);
    model.setMonthActive(false);
    gallery.attachFavorites(family.favorites);
    backup;
    unawaited(gallery.initialize());
    unawaited(initialize());
  }

  /// 先恢复可信电脑和传输队列，再读取独立的本地宝宝相册。
  Future<void> initialize() async {
    // 本地宝宝记录独立恢复，离线电脑的重连不阻塞相册和档案编辑。
    await Future.wait([model.initialize(), family.initialize()]);
    if (mounted && page == 1) startBabyScan();
  }

  void refresh() {
    if (mounted) {
      setState(() {});
      if (page == 1) startBabyScan();
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    model.removeListener(refresh);
    family.removeListener(refresh);
    gallery.removeListener(refresh);
    backup.dispose();
    gallery.dispose();
    family.dispose();
    model.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    model.foreground(state == AppLifecycleState.resumed);
    if (state != AppLifecycleState.inactive) {
      family.foreground(state == AppLifecycleState.resumed);
    }
    if (state == AppLifecycleState.resumed) {
      if (_selectingGallery) {
        _galleryRefreshPending = true;
      } else {
        unawaited(gallery.refresh());
      }
    }
  }

  /// 多选期间延后相册刷新，结束选择后再读取系统中的新变化。
  void gallerySelectionChanged(bool value) {
    _selectingGallery = value;
    if (!value && _galleryRefreshPending) {
      _galleryRefreshPending = false;
      unawaited(gallery.refresh());
    }
  }

  /// 有参考人脸时首次进入宝宝页再整理，首页不执行整库识别。
  void startBabyScan() {
    if (_babyScanStarted ||
        _referenceOpen ||
        !model.ready ||
        model.running ||
        !family.ready ||
        !family.modelReady ||
        !gallery.authorized ||
        !family.babies.values.any(
          (baby) => baby.autoMatch && family.validReferenceCount(baby) > 0,
        )) {
      return;
    }
    _babyScanStarted = true;
    unawaited(family.scan(requestPermission: false));
  }

  void selectPage(int value) {
    setState(() => page = value);
    if (value == 1) startBabyScan();
  }

  /// 首页返回先确认，取消、点击遮罩或再次返回均保留当前相册。
  Future<void> confirmExit() async {
    if (_exitConfirmationOpen) return;
    _exitConfirmationOpen = true;
    try {
      final confirmed = await showDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: const Text('退出拾光匣？'),
          content: Text(
            model.running ? '退出后传输会暂停，重新打开后可继续。确定要退出吗？' : '确定要退出拾光匣吗？',
          ),
          actions: [
            TextButton(
              autofocus: true,
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('退出'),
            ),
          ],
        ),
      );
      if (confirmed == true && mounted) await SystemNavigator.pop();
    } finally {
      _exitConfirmationOpen = false;
    }
  }

  /// 首页选中的系统媒体直接进入原有保存回执流程。
  Future<bool> uploadGallery(
    Set<String> ids, {
    bool restoreMissing = false,
  }) async {
    if (!model.ready || model.busy || model.running) return false;
    if (model.connection == null) {
      selectPage(2);
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(const SnackBar(content: Text('先连接电脑，上传目标由电脑当前照片库决定。')));
      return false;
    }
    model.selected
      ..clear()
      ..addAll(ids);
    await confirmUpload(restoreMissing: restoreMissing);
    if (mounted && model.notice.isNotEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(model.notice)));
    }
    return model.selected.isEmpty;
  }

  /// 月份统计和原图核对放在独立备份页，返回后停止自动扫描。
  Future<void> openMonthBackup() async {
    if (!model.ready || model.busy || model.running) return;
    _backupOpen = true;
    model.setMonthActive(true);
    unawaited(model.action(() => model.loadPhotos()));
    await Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => AnimatedBuilder(
          animation: model,
          builder: (context, _) => Scaffold(
            appBar: AppBar(title: const Text('按月备份')),
            body: SafeArea(
              top: false,
              child: Column(
                children: [
                  if (model.loadingPhotos || model.busy)
                    const LinearProgressIndicator(),
                  if (model.notice.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.all(12),
                      child: Text(model.notice),
                    ),
                  Expanded(child: backupPhotosPage()),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    _backupOpen = false;
    model.setMonthActive(false);
  }

  Future<void> pair() async {
    final value = await Navigator.push<String>(
      context,
      MaterialPageRoute(builder: (_) => const PairingScreen()),
    );
    if (value != null && mounted) await model.action(() => model.pair(value));
  }

  // 日期选择只影响本次界面预览，正式批次的归档日期由接收端确认。
  Future<void> pickDate() async {
    final date = await showDatePicker(
      context: context,
      initialDate: DateTime.parse(model.manualDate),
      firstDate: DateTime(1900),
      lastDate: DateTime(2100, 12, 31),
    );
    if (date != null && mounted) {
      await model.action(() => model.setManualDate(dateLabel(date)));
    }
  }

  Future<void> confirmUpload({
    bool onlyUnbacked = false,
    bool restoreMissing = false,
  }) async {
    await model.action(() async {
      if (onlyUnbacked) model.selectUnbackedMonth();
      await model.prepareSelection(onlyUnbacked: onlyUnbacked);
    });
    if (!mounted || model.notice.isNotEmpty || model.prepared.isEmpty) return;
    bool skip = !restoreMissing;
    final saved = model.prepared
        .where((item) => item['receipt'] != null)
        .length;
    final old = model.prepared
        .where((item) => (item['matches'] as List).isNotEmpty)
        .length;
    final unknownDates = model.prepared
        .where(
          (item) => item['captureDate'] == null && item['creationDate'] == null,
        )
        .length;
    final creationDates = model.prepared
        .where(
          (item) => item['captureDate'] == null && item['creationDate'] != null,
        )
        .length;
    final incomplete = model.roots.any((item) => item['state'] != 'ready');
    final library = model.libraries
        .where((item) => item['id'] == model.libraryId)
        .firstOrNull;
    final accepted = await showDialog<bool>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, setDialog) => AlertDialog(
          title: Text(
            restoreMissing
                ? '补传到当前照片库'
                : onlyUnbacked
                ? '只上传本月未备份'
                : '确认上传与归档',
          ),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text('${model.connection!.name}\n${library?['path'] ?? ''}'),
                const SizedBox(height: 16),
                Text(
                  '已选 ${model.prepared.length} 项\n当前目录已保存 $saved 项\n其他已登记目录已有 $old 项',
                ),
                if (restoreMissing) const Text('补传会在当前照片库保存完整原文件，旧记录和已有文件保留。'),
                const SizedBox(height: 12),
                Text(
                  '日期规则：${{'capture': '拍摄日期', 'upload': '本批次上传日期', 'manual': model.manualDate}[model.mode]}',
                ),
                if (model.mode == 'capture' && unknownDates > 0)
                  Text('$unknownDates 项没有可靠拍摄日，将使用电脑确认的批次上传日。'),
                if (model.mode == 'capture' && creationDates > 0)
                  Text('$creationDates 项没有拍摄日，将使用手机创建日期归档。'),
                const SizedBox(height: 10),
                Text(
                  '路径预览：${library?['name'] ?? '所选目录'} / ${model.mode == 'manual'
                      ? model.manualDate
                      : model.mode == 'capture'
                      ? '拍摄日期或手机创建日期'
                      : '电脑确认的上传日期'} / 原图文件名',
                ),
                if (incomplete)
                  const Padding(
                    padding: EdgeInsets.only(top: 12),
                    child: Text('历史目录尚未全部核对完；未确认的照片会正常上传。'),
                  ),
                if (onlyUnbacked) const Text('已排除电脑已有和待核对的照片。发送前会再次确认，避免重复传输。'),
                if (old > 0 && !onlyUnbacked)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: skip,
                    onChanged: (value) => setDialog(() => skip = value ?? true),
                    title: const Text('跳过其他目录已有的原文件'),
                    subtitle: const Text('取消勾选可在本次目录再保存一份。'),
                  ),
                const SizedBox(height: 12),
                const Text('传输时请保持 App 在前台。切到后台后暂停，回来可继续。'),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: const Text('开始上传'),
            ),
          ],
        ),
      ),
    );
    if (accepted == true && mounted) {
      await model.action(
        () => model.enqueue(skipHistory: skip, onlyUnbacked: onlyUnbacked),
      );
      if (mounted) setState(() => page = 2);
      if (mounted && _backupOpen) Navigator.pop(context);
    }
  }

  Future<void> previewMedia(AssetEntity asset) async {
    await family.action(() async {
      final item = await family.registerMedia(asset);
      if (!mounted) return;
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (_) => MediaPreview(
            controller: family,
            asset: item,
            baby: family.babies[family.activeBaby],
            onTransfer: () => uploadFamily(item),
          ),
        ),
      );
    });
    if (mounted && family.notice.isNotEmpty) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text(family.notice)));
    }
  }

  /// 参考选择独立读取照片列表，保存后回到宝宝页再继续整库匹配。
  Future<void> chooseReference(BabyProfile baby) async {
    if (_referenceOpen || !family.ready) return;
    _referenceOpen = true;
    if (family.scanning) {
      family.pauseScan();
      _babyScanStarted = false;
    }
    await family.waitForScan();
    if (!mounted) {
      _referenceOpen = false;
      return;
    }
    final picker = SystemGalleryController(gateway: gallery.gateway);
    unawaited(picker.setType(RequestType.image));
    try {
      await Navigator.push<void>(
        context,
        MaterialPageRoute(
          builder: (pickerContext) => Scaffold(
            appBar: AppBar(title: Text('${baby.name}的人脸参考')),
            body: SafeArea(
              top: false,
              child: SystemGalleryScreen(
                controller: picker,
                title: '点选一张宝宝照片',
                onUpload: (_) async => false,
                onOrganize: (_) async {},
                onPick: (media) async {
                  final item = await family.registerMedia(media);
                  if (!pickerContext.mounted) return;
                  final saved = await Navigator.push<bool>(
                    pickerContext,
                    MaterialPageRoute(
                      builder: (_) => MediaPreview(
                        controller: family,
                        asset: item,
                        baby: baby,
                        selectReference: true,
                      ),
                    ),
                  );
                  if (saved == true && pickerContext.mounted) {
                    Navigator.pop(pickerContext);
                  }
                },
              ),
            ),
          ),
        ),
      );
    } finally {
      picker.dispose();
      _referenceOpen = false;
      if (mounted && page == 1) startBabyScan();
    }
  }

  /// 宝宝集合中的手机原文件仍进入原有核对、确认和回执流程。
  Future<void> uploadFamily(FamilyAsset asset) async {
    if (model.running || model.busy || asset.localId == null) return;
    model.selected
      ..clear()
      ..add(asset.localId!);
    await confirmUpload();
  }

  void openSettings() {
    Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) => AnimatedBuilder(
          animation: model,
          builder: (context, _) => Scaffold(
            appBar: AppBar(title: const Text('设置')),
            body: settingsPage(),
          ),
        ),
      ),
    );
  }

  /// 直接选择年月，无需先扫描其他月份来生成下拉列表。
  Future<void> pickScanMonth() async {
    final date = model.selectedMonth == 'unknown'
        ? DateTime.now()
        : DateTime.parse('${model.selectedMonth}-01');
    var year = date.year, month = date.month;
    var yearsReady = false;
    final value = await showDialog<String>(
      context: context,
      builder: (context) => StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: const Text('选择扫描月份'),
          content: SingleChildScrollView(
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                GalleryYearField(
                  initialYear: year,
                  loadYears: () =>
                      gallery.loadYears(mediaType: RequestType.common),
                  onChanged: (value) {
                    update(() {
                      year = value;
                      yearsReady = true;
                    });
                  },
                ),
                const SizedBox(height: 12),
                Wrap(
                  spacing: 8,
                  children: [
                    for (var value = 1; value <= 12; value++)
                      ChoiceChip(
                        label: Text('$value 月'),
                        selected: month == value,
                        onSelected: (_) => update(() => month = value),
                      ),
                  ],
                ),
                TextButton(
                  onPressed: () => Navigator.pop(context, 'unknown'),
                  child: const Text('查看日期未知的照片'),
                ),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('取消'),
            ),
            FilledButton(
              onPressed: yearsReady
                  ? () => Navigator.pop(
                      context,
                      calendarMonth(DateTime(year, month)),
                    )
                  : null,
              child: const Text('查看这个月'),
            ),
          ],
        ),
      ),
    );
    if (value != null && mounted) {
      await model.action(() => model.selectMonth(value));
    }
  }

  Future<void> updateAddress() async {
    final text = TextEditingController(text: model.connection!.address);
    final value = await showDialog<String>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('更新电脑地址'),
        content: TextField(
          controller: text,
          decoration: const InputDecoration(
            hintText: 'https://192.168.1.8:45831',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('取消'),
          ),
          FilledButton(
            onPressed: () => Navigator.pop(context, text.text.trim()),
            child: const Text('连接'),
          ),
        ],
      ),
    );
    text.dispose();
    if (value != null && mounted) {
      await model.action(() => model.changeAddress(value));
    }
  }

  @override
  Widget build(BuildContext context) => PopScope<void>(
    canPop: false,
    onPopInvokedWithResult: (didPop, _) {
      if (!didPop) unawaited(confirmExit());
    },
    child: Scaffold(
      appBar: page == 2
          ? AppBar(
              title: Text(
                const ['相册', '宝宝', '传输'][page],
                style: const TextStyle(fontWeight: FontWeight.w600),
              ),
              actions: [
                PopupMenuButton<String>(
                  tooltip: '传输操作',
                  onSelected: (value) {
                    if (value == 'backup') openMonthBackup();
                    if (value == 'connection') openConnection();
                    if (value == 'refresh') model.action(model.reconnect);
                    if (value == 'settings') openSettings();
                  },
                  itemBuilder: (_) => [
                    PopupMenuItem(
                      value: 'backup',
                      enabled: !model.busy && !model.running,
                      child: const Text('按月备份'),
                    ),
                    const PopupMenuItem(
                      value: 'connection',
                      child: Text('连接与接收目录'),
                    ),
                    PopupMenuItem(
                      value: 'refresh',
                      enabled:
                          !model.busy &&
                          !model.running &&
                          model.connection != null,
                      child: const Text('刷新电脑当前库'),
                    ),
                    const PopupMenuItem(value: 'settings', child: Text('设置')),
                  ],
                ),
                if (model.running && page != 2)
                  IconButton(
                    tooltip: '查看正在传输的任务',
                    onPressed: () => selectPage(2),
                    icon: const Icon(Icons.upload_rounded),
                  ),
              ],
            )
          : null,
      body: SafeArea(
        top: page != 2,
        child: Column(
          children: [
            if (page == 2 &&
                model.notice.isNotEmpty &&
                !model.tasks.any(
                  (task) => task.error.isNotEmpty && task.error == model.notice,
                ))
              MaterialBanner(
                content: Text(
                  model.notice,
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
                actions: [
                  TextButton(
                    onPressed: () => setState(() => model.notice = ''),
                    child: const Text('知道了'),
                  ),
                ],
              ),
            if (model.busy) const LinearProgressIndicator(),
            if (model.progress.isNotEmpty)
              Padding(
                padding: const EdgeInsets.all(8),
                child: Text(model.progress),
              ),
            Expanded(
              child: IndexedStack(
                index: page,
                children: [
                  SystemGalleryScreen(
                    key: const PageStorageKey('system-gallery'),
                    controller: gallery,
                    backup: backup,
                    favorites: family.favorites,
                    onBackupUpload: (ids, restore) =>
                        uploadGallery(ids, restoreMissing: restore),
                    canOrganize: family.ready,
                    canUpload: model.ready && !model.busy && !model.running,
                    actionsChanged: previewChanges,
                    uploadAvailable: () =>
                        model.ready && !model.busy && !model.running,
                    organizeAvailable: () => family.ready,
                    onOrganize: previewMedia,
                    onUpload: uploadGallery,
                    onSelectionChanged: gallerySelectionChanged,
                    onSettings: openSettings,
                  ),
                  family.ready
                      ? BabyScreen(
                          controller: family,
                          onTransfer: uploadFamily,
                          onChooseMedia: () => selectPage(0),
                          onChooseReference: chooseReference,
                        )
                      : Center(
                          child: Padding(
                            padding: const EdgeInsets.all(24),
                            child: Text(
                              family.notice.isEmpty
                                  ? '正在读取宝宝记录…'
                                  : family.notice,
                              textAlign: TextAlign.center,
                            ),
                          ),
                        ),
                  model.ready
                      ? tasksPage()
                      : Center(
                          child: Text(
                            model.notice.isEmpty
                                ? '正在读取本地记录…'
                                : '本地记录不可用，请重新打开应用。',
                          ),
                        ),
                ],
              ),
            ),
          ],
        ),
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: page,
        onDestinationSelected: selectPage,
        destinations: const [
          NavigationDestination(
            icon: GalleryModuleIcon(0),
            selectedIcon: GalleryModuleIcon(0, selected: true),
            label: '相册',
          ),
          NavigationDestination(
            icon: GalleryModuleIcon(1),
            selectedIcon: GalleryModuleIcon(1, selected: true),
            label: '宝宝',
          ),
          NavigationDestination(
            icon: GalleryModuleIcon(2),
            selectedIcon: GalleryModuleIcon(2, selected: true),
            label: '传输',
          ),
        ],
      ),
    ),
  );
  Widget connectionCard() => Card(
    child: Padding(
      padding: const EdgeInsets.all(16),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(
                Icons.computer,
                color: model.online ? Colors.green : Colors.grey,
              ),
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  model.connection?.name ?? '尚未连接电脑',
                  style: const TextStyle(
                    fontSize: 17,
                    fontWeight: FontWeight.w700,
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: 10),
          Text(
            model.connection == null
                ? '先在电脑端添加保存目录，再扫码连接。'
                : model.online
                ? '已连接 · 核对电脑全部已登记且启用的目录'
                : '离线 · 显示最近一次核对记录',
          ),
          const SizedBox(height: 8),
          Wrap(
            spacing: 8,
            children: [
              FilledButton.icon(
                onPressed: model.busy || model.running ? null : pair,
                icon: const Icon(Icons.qr_code_scanner),
                label: Text(model.connection == null ? '连接电脑' : '配对新电脑'),
              ),
              if (model.connection != null)
                TextButton(
                  onPressed: model.busy || model.running
                      ? null
                      : () => model.action(model.reconnect),
                  child: const Text('重新连接'),
                ),
            ],
          ),
          const SizedBox(height: 12),
          const Text('电脑当前照片库', style: TextStyle(color: galleryMuted)),
          const SizedBox(height: 4),
          SelectableText(
            model.libraries
                    .where((item) => item['id'] == model.libraryId)
                    .firstOrNull?['path']
                    ?.toString() ??
                '电脑尚未选择照片库',
          ),
          const SizedBox(height: 8),
          Text(
            model.currentLibraryAvailable
                ? '在电脑端切换，刷新后用于新批次。已有批次保留原目标。'
                : '请在电脑端确认当前目录可用，再刷新。',
            style: const TextStyle(fontSize: 12, color: galleryMuted),
          ),
        ],
      ),
    ),
  );
  Widget backupPhotosPage() {
    final photos = model.visiblePhotos;
    return CustomScrollView(
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 4, 16, 16),
          sliver: SliverToBoxAdapter(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Wrap(
                  spacing: 8,
                  runSpacing: 8,
                  children: [
                    OutlinedButton.icon(
                      onPressed:
                          model.busy || model.loadingPhotos || model.running
                          ? null
                          : () => model.action(() => model.loadPhotos()),
                      icon: const Icon(Icons.photo_library_outlined),
                      label: Text(
                        model.photos.isEmpty ? '授权照片和视频' : '刷新相册 / 授权',
                      ),
                    ),
                    if (model.photos.isNotEmpty)
                      TextButton(
                        onPressed: model.busy || model.running
                            ? null
                            : model.selectVisible,
                        child: const Text('全选本月筛选结果'),
                      ),
                  ],
                ),
                if (model.limited) const Text('当前仅显示已授权照片和视频，可重新授权以增加范围。'),
                if (model.albums.isNotEmpty)
                  DropdownButtonFormField<String>(
                    key: ValueKey(model.album?.id),
                    initialValue: model.album?.id,
                    isExpanded: true,
                    items: model.albums
                        .map(
                          (item) => DropdownMenuItem(
                            value: item.id,
                            child: Text(
                              item.name,
                              overflow: TextOverflow.ellipsis,
                            ),
                          ),
                        )
                        .toList(),
                    onChanged:
                        model.busy || model.running || model.loadingPhotos
                        ? null
                        : (value) {
                            if (value != null) {
                              model.action(() => model.selectAlbum(value));
                            }
                          },
                  ),
                const SizedBox(height: 12),
                monthOverview(),
                Wrap(
                  spacing: 7,
                  children: [
                    for (final entry in const {
                      'all': '全部',
                      'pending': '只看未备份',
                      'backed': '已备份',
                      'missing': '需补传',
                      'unknown': '待核对',
                    }.entries)
                      ChoiceChip(
                        label: Text(entry.value),
                        selected: model.filter == entry.key,
                        onSelected: (_) {
                          model.filter = entry.key;
                          model.changed();
                        },
                      ),
                  ],
                ),
                const SizedBox(height: 12),
                if (model.photos.isNotEmpty)
                  Text(
                    '本月显示 ${photos.length} 项 · 已选 ${model.selected.length} 项',
                  ),
                if (model.selected.isNotEmpty)
                  Padding(
                    padding: const EdgeInsets.only(top: 10),
                    child: Wrap(
                      spacing: 8,
                      children: [
                        FilledButton(
                          onPressed: model.busy || model.running
                              ? null
                              : confirmUpload,
                          child: Text('核对并上传 ${model.selected.length} 项'),
                        ),
                        TextButton(
                          onPressed: () {
                            model.selected.clear();
                            model.changed();
                          },
                          child: const Text('取消选择'),
                        ),
                      ],
                    ),
                  ),
                if (photos.isEmpty)
                  const Padding(
                    padding: EdgeInsets.symmetric(vertical: 34),
                    child: Center(
                      child: Text(
                        '本月没有符合条件的照片或视频。\n可以切换月份、相册或调整授权。',
                        textAlign: TextAlign.center,
                      ),
                    ),
                  ),
              ],
            ),
          ),
        ),
        SliverPadding(
          padding: const EdgeInsets.symmetric(horizontal: 16),
          sliver: SliverGrid(
            delegate: SliverChildBuilderDelegate((context, index) {
              final asset = photos[index];
              return PhotoTile(
                key: ValueKey('${asset.id}:${model.version(asset)}'),
                asset: asset,
                label: labels[model.status(asset)]!,
                selected: model.selected.contains(asset.id),
                onTap: model.busy || model.running
                    ? null
                    : () => model.toggle(asset.id),
                onInfo: () => showPhotoInfo(asset),
                onPreview: () => previewMedia(asset),
              );
            }, childCount: photos.length),
            gridDelegate: const SliverGridDelegateWithMaxCrossAxisExtent(
              maxCrossAxisExtent: 180,
              mainAxisSpacing: 8,
              crossAxisSpacing: 8,
              childAspectRatio: 0.83,
            ),
          ),
        ),
        SliverToBoxAdapter(
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Column(
              children: [
                if (model.hasMore && !model.loadingPhotos)
                  OutlinedButton(
                    onPressed: model.busy || model.running
                        ? null
                        : () => model.action(model.morePhotos),
                    child: const Text('继续加载本月'),
                  ),
                const Text(
                  '自动核对不上传媒体。上传需确认，不会删除手机原文件。',
                  textAlign: TextAlign.center,
                ),
              ],
            ),
          ),
        ),
      ],
    );
  }

  Widget monthOverview() {
    final total = model.monthProgress.total;
    final backed = model.monthProgress.backed;
    final pending = model.monthProgress.pending;
    final unknown = model.monthProgress.unknown;
    final disabled = model.busy || model.running || model.loadingPhotos;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text('按月份扫描'),
            OutlinedButton.icon(
              key: const ValueKey('choose-scan-month'),
              onPressed: disabled ? null : pickScanMonth,
              icon: const Icon(Icons.calendar_month_outlined),
              label: Text(monthLabel(model.selectedMonth!)),
            ),
            const SizedBox(height: 12),
            Text(
              '本月 $total 项照片和视频',
              style: const TextStyle(fontWeight: FontWeight.w700, fontSize: 18),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 12,
              runSpacing: 8,
              children: [
                Text(
                  '已备份 $backed',
                  style: const TextStyle(color: Color(0xFF236239)),
                ),
                Text('未备份 $pending'),
                if (model.monthProgress.missing > 0)
                  Text('需补传 ${model.monthProgress.missing}'),
                Text('待核对 $unknown'),
              ],
            ),
            const SizedBox(height: 10),
            if (model.loadingPhotos)
              Text('正在读取本月照片和视频：已加载 ${model.photos.length} / $total 项…')
            else
              const Text('直接展示所选月份的全部已授权照片和视频，可全选上传；连接电脑后逐批核对备份状态。'),
            if (model.checking) ...[
              const SizedBox(height: 10),
              const LinearProgressIndicator(),
              Text(model.checkProgress),
            ] else if (model.checkPaused)
              const Text('本月扫描已暂停。继续后跳过本轮已核对的照片。'),
            if (!model.online) const Text('离线时显示最近核对记录，连接电脑后刷新。'),
            if (model.checkNotice.isNotEmpty) Text(model.checkNotice),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: [
                TextButton(
                  onPressed: disabled || !model.online
                      ? null
                      : model.checking
                      ? () => model.stopChecking(pause: true)
                      : model.checkPaused
                      ? model.resumeChecking
                      : () => model.checkPhotos(restart: true),
                  child: Text(
                    model.checking
                        ? '暂停扫描'
                        : model.checkPaused
                        ? '继续扫描本月'
                        : '重新扫描本月',
                  ),
                ),
              ],
            ),
            FilledButton.icon(
              key: const ValueKey('upload-month-unbacked'),
              onPressed:
                  disabled ||
                      !model.online ||
                      !model.catalogComplete ||
                      pending == 0
                  ? null
                  : () => confirmUpload(onlyUnbacked: true),
              icon: const Icon(Icons.backup_outlined),
              label: Text('只上传本月未备份 · $pending 项'),
            ),
            if (unknown > 0) Text('$unknown 项待核对媒体不包含在本次上传中。'),
          ],
        ),
      ),
    );
  }

  Future<void> showPhotoInfo(AssetEntity asset) async {
    final info = model.observations[asset.id];
    await showDialog<void>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(asset.title ?? '照片记录'),
        content: SingleChildScrollView(
          child: Text(
            '${labels[model.status(asset)]}\n${model.checkErrors[asset.id] ?? ''}\n${info?['receipt']?['relativePath'] ?? ''}\n${(info?['matches'] as List? ?? []).map((item) => item['path']).join('\n')}\n${info?['checkedAt'] != null ? '最近核对：${info!['checkedAt']}' : '尚未核对当前内容'}',
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

  /// 已配对电脑的目录与连接操作收进详情，主列表只保留连接概况。
  void openConnection() {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (context) => AnimatedBuilder(
          animation: model,
          builder: (context, _) => Scaffold(
            appBar: AppBar(title: const Text('连接与接收目录')),
            body: SafeArea(
              top: false,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  connectionCard(),
                  if (model.busy) const LinearProgressIndicator(),
                  if (model.notice.isNotEmpty)
                    Padding(
                      padding: const EdgeInsets.all(16),
                      child: Text(model.notice),
                    ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }

  void openTask(UploadTask task) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        builder: (_) =>
            TransferTaskDetailScreen(controller: model, taskId: task.id),
      ),
    );
  }

  /// 按需构建任务摘要，点入后再查看目录、回执与操作。
  Widget tasksPage() {
    final batches = transferBatches(model.tasks);
    final active = batches.where((batch) => batch.active).toList();
    final history = batches.where((batch) => !batch.active).toList();
    final library = model.libraries
        .where((item) => item['id'] == model.libraryId)
        .firstOrNull;
    void openBatch(TransferBatch batch) => Navigator.push<void>(
      context,
      MaterialPageRoute(
        builder: (_) =>
            TransferBatchDetailScreen(controller: model, batchId: batch.id),
      ),
    );
    // 分组外框保留按需构建，长历史列表不会一次创建全部缩略图。
    Widget rows(List<TransferBatch> items, {bool progress = false}) {
      final list = SliverList.separated(
        itemCount: items.length,
        separatorBuilder: (_, _) => progress
            ? const SizedBox(height: 8)
            : const Divider(height: 1, indent: 12, endIndent: 12),
        itemBuilder: (_, index) {
          final tile = TransferBatchTile(
            batch: items[index],
            showProgress: progress,
            onTap: () => openBatch(items[index]),
          );
          if (!progress) return tile;
          return Container(
            key: ValueKey('active-batch-card-${items[index].id}'),
            decoration: BoxDecoration(
              border: Border.all(color: const Color(0xFFE6EBE7)),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                tile,
                if (model.running && index == 0)
                  Padding(
                    padding: const EdgeInsets.fromLTRB(12, 0, 12, 8),
                    child: Align(
                      alignment: Alignment.centerLeft,
                      child: TextButton.icon(
                        key: const ValueKey('transfer-pause-queue'),
                        onPressed: model.busy ? null : model.pause,
                        icon: const Icon(
                          Icons.pause,
                          size: 18,
                          color: galleryInk,
                        ),
                        label: const Text(
                          '暂停队列',
                          style: TextStyle(color: galleryInk),
                        ),
                      ),
                    ),
                  ),
              ],
            ),
          );
        },
      );
      return progress
          ? list
          : DecoratedSliver(
              decoration: BoxDecoration(
                border: Border.all(color: const Color(0xFFE6EBE7)),
                borderRadius: BorderRadius.circular(8),
              ),
              sliver: list,
            );
    }

    return CustomScrollView(
      key: const PageStorageKey('transfer-tasks'),
      slivers: [
        SliverPadding(
          padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
          sliver: SliverToBoxAdapter(
            child: Card(
              child: InkWell(
                borderRadius: BorderRadius.circular(8),
                onTap: model.connection == null
                    ? model.busy || model.running
                          ? null
                          : pair
                    : openConnection,
                child: Padding(
                  padding: const EdgeInsets.all(14),
                  child: Row(
                    children: [
                      Icon(
                        Icons.desktop_windows_outlined,
                        size: 36,
                        color: model.online ? galleryGreen : galleryMuted,
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Text(
                              model.connection?.name ?? '连接家里的电脑',
                              style: const TextStyle(
                                fontWeight: FontWeight.w600,
                              ),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              model.connection == null
                                  ? '扫码配对'
                                  : model.online
                                  ? '已连接'
                                  : '离线',
                              style: TextStyle(
                                color: model.online
                                    ? galleryGreen
                                    : galleryMuted,
                                fontSize: 12,
                              ),
                            ),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                Expanded(
                                  child: Text(
                                    '目标：${library?['name'] ?? (model.libraryId == null ? '电脑未选择照片库' : '电脑当前照片库')}',
                                    maxLines: 2,
                                    overflow: TextOverflow.ellipsis,
                                    style: const TextStyle(
                                      fontSize: 12,
                                      color: galleryMuted,
                                    ),
                                  ),
                                ),
                                const SizedBox(width: 6),
                                const Text(
                                  '查看',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: galleryGreen,
                                  ),
                                ),
                                const Icon(
                                  Icons.chevron_right,
                                  size: 18,
                                  color: galleryGreen,
                                ),
                              ],
                            ),
                            if (model.supportsCurrentLibraryContext &&
                                model.libraryId != null &&
                                !model.currentLibraryAvailable)
                              const Padding(
                                padding: EdgeInsets.only(top: 4),
                                child: Text(
                                  '当前库暂不可用',
                                  style: TextStyle(
                                    fontSize: 12,
                                    color: galleryMuted,
                                  ),
                                ),
                              ),
                          ],
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ),
        ),
        if (active.isNotEmpty) ...[
          SliverToBoxAdapter(
            child: Padding(
              padding: const EdgeInsets.fromLTRB(16, 24, 16, 10),
              child: Text(
                model.running ? '正在传输' : '待继续',
                style: const TextStyle(
                  fontSize: 17,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            sliver: rows(active, progress: true),
          ),
        ],
        if (history.isNotEmpty) ...[
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.fromLTRB(16, 24, 16, 10),
              child: Text(
                '历史记录',
                style: TextStyle(fontSize: 17, fontWeight: FontWeight.w600),
              ),
            ),
          ),
          SliverPadding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            sliver: rows(history),
          ),
        ],
        if (batches.isEmpty)
          const SliverToBoxAdapter(
            child: Padding(
              padding: EdgeInsets.symmetric(vertical: 36),
              child: Text(
                '还没有传输任务',
                textAlign: TextAlign.center,
                style: TextStyle(color: galleryMuted),
              ),
            ),
          ),
        if (batches.isEmpty)
          SliverToBoxAdapter(
            child: TextButton(
              onPressed: () => selectPage(0),
              child: const Text('去相册选择照片和视频'),
            ),
          ),
        const SliverToBoxAdapter(child: SizedBox(height: 20)),
      ],
    );
  }

  Widget settingsPage() => ListView(
    padding: const EdgeInsets.all(20),
    children: [
      const Text(
        '归档与设备',
        style: TextStyle(fontSize: 27, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 18),
      if (model.connections.isNotEmpty)
        DropdownButtonFormField<String>(
          key: ValueKey(model.connection?.id),
          initialValue: model.connection?.id,
          isExpanded: true,
          decoration: const InputDecoration(labelText: '接收电脑'),
          items: model.connections
              .map(
                (item) =>
                    DropdownMenuItem(value: item.id, child: Text(item.name)),
              )
              .toList(),
          onChanged: model.running || model.busy
              ? null
              : (value) {
                  if (value != null) {
                    model.action(() => model.selectReceiver(value));
                  }
                },
        ),
      if (model.connection != null)
        TextButton(
          onPressed: model.running ? null : updateAddress,
          child: Text('电脑 IP 变化？更新地址\n${model.connection!.address}'),
        ),
      const SizedBox(height: 20),
      const Text(
        '按什么日期分目录？',
        style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 12),
      Wrap(
        spacing: 8,
        runSpacing: 8,
        children: [
          for (final entry in const {
            'capture': '拍摄日期',
            'upload': '上传日期',
            'manual': '指定日期',
          }.entries)
            ChoiceChip(
              label: Text(entry.value),
              selected: model.mode == entry.key,
              onSelected: model.busy
                  ? null
                  : (_) => model.action(() => model.setMode(entry.key)),
            ),
        ],
      ),
      if (model.mode == 'manual')
        OutlinedButton.icon(
          onPressed: pickDate,
          icon: const Icon(Icons.calendar_today_outlined),
          label: Text(model.manualDate),
        ),
      const SizedBox(height: 16),
      Card(
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Text(switch (model.mode) {
            'capture' => '按拍摄日期归档；没有拍摄日期时使用手机创建日期。两者都缺失时使用本批次上传日。',
            'upload' => '上传日期由电脑在创建批次时确认。跨午夜、暂停和重试保持原来的日期目录。',
            _ => '本批次使用指定日期 ${model.manualDate}，不会修改照片本身。',
          }),
        ),
      ),
      const SizedBox(height: 24),
      const Text(
        '以前保存的照片',
        style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 8),
      const Text(
        '先在电脑添加历史目录并扫描。手机自动核对当前月，区分已备份、未备份和待核对；已备份包含其他启用接收目录。长按照片查看具体位置。',
      ),
      const SizedBox(height: 20),
      const Text(
        '原图与权限',
        style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
      ),
      const SizedBox(height: 8),
      const Text('不压缩、不转码。位置等原始元数据是否可读取取决于系统授权。只显示已获授权的照片；无法读取时会提示，保留任务等待恢复。'),
      const SizedBox(height: 12),
      const Text('仅局域网传输：只连接同网段的 Wi-Fi 或有线网络。断开后停止连接，不转用移动数据；不支持 VPN、公网地址或域名。'),
      TextButton(
        onPressed: () => PhotoManager.openSetting(),
        child: const Text('打开系统权限设置'),
      ),
    ],
  );
}

class PhotoTile extends StatefulWidget {
  const PhotoTile({
    super.key,
    required this.asset,
    required this.label,
    required this.selected,
    required this.onTap,
    required this.onInfo,
    this.onPreview,
  });
  final AssetEntity asset;
  final String label;
  final bool selected;
  final VoidCallback? onTap;
  final VoidCallback onInfo;
  final VoidCallback? onPreview;
  @override
  State<PhotoTile> createState() => _PhotoTileState();
}

class _PhotoTileState extends State<PhotoTile> {
  late final Future<Uint8List?> thumbnail = widget.asset.thumbnailDataWithSize(
    const ThumbnailSize(300, 300),
  );
  @override
  Widget build(BuildContext context) => Semantics(
    label: '${widget.asset.title ?? '照片'} ${widget.label}',
    selected: widget.selected,
    child: Material(
      color: widget.selected ? const Color(0xFFF0D7C9) : Colors.white,
      borderRadius: BorderRadius.circular(12),
      clipBehavior: Clip.antiAlias,
      child: InkWell(
        onTap: widget.onTap,
        onLongPress: widget.onInfo,
        child: Column(
          children: [
            Expanded(
              child: Stack(
                fit: StackFit.expand,
                children: [
                  FutureBuilder<Uint8List?>(
                    future: thumbnail,
                    builder: (context, snapshot) => snapshot.hasData
                        ? Image.memory(snapshot.data!, fit: BoxFit.cover)
                        : const Icon(Icons.photo_outlined, size: 35),
                  ),
                  Positioned(
                    top: 6,
                    right: 6,
                    child: Icon(
                      widget.selected
                          ? Icons.check_circle
                          : Icons.radio_button_unchecked,
                      color: widget.selected ? Colors.deepOrange : Colors.white,
                      shadows: const [Shadow(blurRadius: 3)],
                    ),
                  ),
                  if (widget.asset.type == AssetType.video)
                    const Positioned(
                      left: 8,
                      bottom: 8,
                      child: Icon(Icons.play_circle_fill, color: Colors.white),
                    ),
                  if (widget.onPreview != null)
                    Positioned(
                      left: 2,
                      top: 2,
                      child: IconButton(
                        tooltip: '查看原文件',
                        onPressed: widget.onPreview,
                        icon: const Icon(
                          Icons.open_in_full,
                          color: Colors.white,
                          size: 20,
                        ),
                      ),
                    ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(7),
              child: Text(
                widget.label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 12),
              ),
            ),
          ],
        ),
      ),
    ),
  );
}
