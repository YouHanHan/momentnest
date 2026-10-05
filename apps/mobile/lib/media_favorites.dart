import 'package:flutter/foundation.dart';
import 'package:photo_manager/photo_manager.dart';
import 'backup_catalog.dart';
import 'local_store.dart';

/// 收藏只保存本机媒体 ID 与版本，不读取、改写或删除原文件。
class MediaFavorites extends ChangeNotifier {
  MediaFavorites(this.store);
  final LocalStore store;
  final Map<String, String> _versions = {};
  bool ready = false, saving = false, _disposed = false;
  bool _legacyImported = false;
  Future<void>? _initialization;
  String notice = '';

  Set<String> get ids => Set.unmodifiable(_versions.keys);

  bool contains(String? id, String? version) =>
      id != null && version != null && _versions[id] == version;

  bool isFavorite(AssetEntity asset) => contains(asset.id, photoVersion(asset));

  /// 启动复用少量收藏记录，不扫描整库媒体或计算内容指纹。
  Future<void> initialize({bool openStore = true}) {
    if (ready) return Future.value();
    return _initialization ??= _load(
      openStore,
    ).whenComplete(() => _initialization = null);
  }

  Future<void> _load(bool openStore) async {
    try {
      if (openStore) await store.open();
      final stored = await store.preference('media-favorites');
      if (_disposed) return;
      if (stored is Map) {
        for (final entry in stored.entries) {
          if (entry.key is String && entry.value is String) {
            _versions[entry.key as String] = entry.value as String;
          }
        }
        _legacyImported = true;
      }
      ready = true;
      notice = '';
    } catch (_) {
      notice = '收藏记录读取失败，请重试。';
    }
    _changed();
  }

  /// 首次升级承接旧手机索引中的收藏，后续取消收藏不会被旧字段恢复。
  Future<void> importLegacy(Map<String, String> versions) async {
    if (!ready || _legacyImported || versions.isEmpty) return;
    saving = true;
    _changed();
    try {
      await store.setPreference('media-favorites', {..._versions, ...versions});
      if (_disposed) return;
      _versions.addAll(versions);
      _legacyImported = true;
    } catch (_) {
      notice = '旧收藏记录读取失败，请重新选择收藏。';
    } finally {
      saving = false;
    }
    _changed();
  }

  /// 写入成功后才更新界面；同一系统 ID 的新内容不会继承旧版本收藏。
  Future<void> set(String id, String version, bool enabled) async {
    if (!ready) throw StateError('请先重新读取收藏记录。');
    if (saving) throw StateError('正在保存收藏，请稍后再试。');
    saving = true;
    _changed();
    try {
      final next = Map<String, String>.of(_versions);
      if (enabled) {
        next[id] = version;
      } else {
        next.remove(id);
      }
      await store.setPreference('media-favorites', next);
      if (_disposed) return;
      _versions
        ..clear()
        ..addAll(next);
      _legacyImported = true;
      notice = '';
    } finally {
      saving = false;
      _changed();
    }
  }

  Future<void> toggle(AssetEntity asset) =>
      set(asset.id, photoVersion(asset), !isFavorite(asset));

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    super.dispose();
  }
}
