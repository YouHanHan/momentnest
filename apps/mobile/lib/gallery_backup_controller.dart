import 'dart:async';
import 'package:flutter/foundation.dart';
import 'package:photo_manager/photo_manager.dart';
import 'backup_catalog.dart';
import 'models.dart';
import 'system_gallery.dart';
import 'transfer_controller.dart';

/// 将传输回执接到系统相册；普通浏览只读取当前分页的本地记录。
class GalleryBackupController extends ChangeNotifier {
  GalleryBackupController(this.gallery, this.transfer) {
    gallery.addListener(_galleryChanged);
    transfer.addListener(_transferChanged);
    _galleryChanged();
  }

  final SystemGalleryController gallery;
  final TransferController transfer;
  final Map<String, Json> _records = {};
  final Map<String, String> _loadedVersions = {};
  String filter = 'all', notice = '';
  String? _target;
  int _generation = -1, _epoch = 0;
  bool _disposed = false, readingFilter = false;
  bool _syncAgain = false;
  Future<void>? _syncJob;
  String _completedTasks = '';
  String? _galleryScope;
  bool _reloadFilter = false;

  bool get checking => transfer.checking;
  bool get canCheck =>
      transfer.ready &&
      transfer.online &&
      transfer.currentLibraryAvailable &&
      !transfer.busy &&
      !transfer.running &&
      gallery.ready &&
      gallery.authorized &&
      !gallery.loading;
  String get targetLabel {
    final library = transfer.libraries
        .where((item) => item['id'] == transfer.libraryId)
        .firstOrNull;
    return '${transfer.connection?.name ?? '尚未连接电脑'}${library == null ? '' : ' · ${library['name'] ?? '当前照片库'}'}';
  }

  String state(AssetEntity asset) {
    final saved = _records[asset.id];
    return saved?['version'] == photoVersion(asset)
        ? (saved?['status'] as String? ?? 'unknown')
        : 'unknown';
  }

  Json? record(AssetEntity asset) =>
      _records[asset.id]?['version'] == photoVersion(asset)
      ? _records[asset.id]
      : null;

  List<AssetEntity> get visible => gallery.assets
      .where((asset) => filter == 'all' || state(asset) == filter)
      .toList();

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  void _galleryChanged() {
    if (_disposed) return;
    if (_generation != gallery.generation) {
      final scope = '${gallery.type}:${gallery.month}';
      _reloadFilter = _galleryScope == scope && filter != 'all';
      if (_galleryScope != scope) filter = 'all';
      _galleryScope = scope;
      _generation = gallery.generation;
      _epoch++;
      transfer.stopChecking();
      _records.clear();
      _loadedVersions.clear();
      readingFilter = false;
      notice = '';
    }
    if (!gallery.loading && _reloadFilter) {
      _reloadFilter = false;
      unawaited(setFilter(filter));
    }
    _sync();
    _changed();
  }

  void _transferChanged() {
    if (_disposed) return;
    final next = '${transfer.connection?.id}:${transfer.libraryId}';
    if (_target != next) {
      _target = next;
      _epoch++;
      _records.clear();
      _loadedVersions.clear();
      filter = 'all';
      _reloadFilter = false;
      readingFilter = false;
      notice = '';
    }
    final completed = transfer.tasks
        .where((task) => task.state == 'complete')
        .map((task) => '${task.id}:${task.data['receipt']?['savedAt']}')
        .join('|');
    if (_completedTasks != completed) {
      _completedTasks = completed;
      _loadedVersions.clear();
    }
    _sync();
    _changed();
  }

  Future<void> _sync() {
    _syncAgain = true;
    return _syncJob ??= _hydrate().whenComplete(() => _syncJob = null);
  }

  Future<void> _hydrate() async {
    while (_syncAgain && !_disposed) {
      _syncAgain = false;
      final receiver = transfer.connection?.id,
          library = transfer.libraryId,
          epoch = _epoch;
      if (!transfer.ready || receiver == null || library == null) continue;
      final pending = gallery.assets
          .where((asset) => _loadedVersions[asset.id] != photoVersion(asset))
          .toList();
      try {
        for (var start = 0; start < pending.length; start += gallery.pageSize) {
          final batch = pending.sublist(
            start,
            (start + gallery.pageSize).clamp(0, pending.length),
          );
          final saved = await transfer.store.observationsFor(
            receiver,
            library,
            batch.map((asset) => asset.id).toList(),
          );
          if (_disposed || epoch != _epoch) break;
          for (final asset in batch) {
            _loadedVersions[asset.id] = photoVersion(asset);
            final data = saved[asset.id];
            final current = _records[asset.id];
            if (data != null &&
                (current == null ||
                    (data['checkedAt'] as String? ?? '').compareTo(
                          current['checkedAt'] as String? ?? '',
                        ) >=
                        0)) {
              _records[asset.id] = data;
            }
          }
        }
      } catch (error) {
        if (!_disposed && epoch == _epoch) {
          notice = '备份记录读取失败：${transfer.explain(error)}';
        }
      }
      _changed();
    }
  }

  /// 状态筛选继续读取范围内的后续分页，避免首屏无匹配被误当作整月无结果。
  Future<void> setFilter(String value) async {
    if (!['all', 'uploaded', 'pending', 'missing'].contains(value)) return;
    filter = value;
    final epoch = _epoch;
    readingFilter = value != 'all';
    _changed();
    try {
      await _sync();
      while (!_disposed &&
          epoch == _epoch &&
          filter == value &&
          value != 'all' &&
          gallery.hasMore) {
        await gallery.loadMore();
        await _sync();
        if (gallery.notice.isNotEmpty) break;
      }
    } finally {
      if (!_disposed && epoch == _epoch && filter == value) {
        readingFilter = false;
        _changed();
      }
    }
  }

  /// 核对只查询原文件是否仍存在，上传仍由用户确认后发起。
  Future<void> check() async {
    if (!canCheck || checking) return;
    notice = '';
    final generation = gallery.generation;
    try {
      await transfer.reconnect();
      if (_disposed || generation != gallery.generation) return;
      final epoch = _epoch;
      await transfer.checkGallery(gallery.verificationPages(), gallery.total, (
        asset,
        data,
      ) {
        if (_disposed || epoch != _epoch) return;
        _records[asset.id] = data;
        _loadedVersions[asset.id] = photoVersion(asset);
      });
      if (!_disposed && epoch == _epoch) {
        for (final id in transfer.checkErrors.keys) {
          _records.remove(id);
        }
      }
    } catch (error) {
      if (!_disposed && generation == gallery.generation) {
        notice = transfer.explain(error);
      }
    }
    _changed();
  }

  /// 补传或上传未传入时只选本次可见且有明确证据的媒体。
  Set<String> idsFor(String value) => gallery.assets
      .where((asset) => state(asset) == value)
      .map((asset) => asset.id)
      .toSet();

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    gallery.removeListener(_galleryChanged);
    transfer.removeListener(_transferChanged);
    super.dispose();
  }
}
