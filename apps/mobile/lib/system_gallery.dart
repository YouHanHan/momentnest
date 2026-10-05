import 'dart:collection';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'month_scan.dart';
import 'media_favorites.dart';

/// 系统相册只提供读取与授权入口，不开放编辑或删除媒体的方法。
abstract class SystemGalleryGateway {
  Future<PermissionState> permission({required bool request});
  Future<SystemGallerySource?> open({required RequestType type});
  Future<void> manageAccess({required bool limited});

  /// 月份查询独立于已加载页面，不扫描其他月份。
  Future<SystemGallerySource?> openMonth({
    required RequestType type,
    required DateTime month,
  }) => throw UnsupportedError('该相册来源未提供月份查询。');

  /// 搜索、日期顺序和收藏范围在系统查询中统一分页。
  Future<SystemGallerySource?> openQuery({
    required RequestType type,
    DateTime? month,
    String search = '',
    bool oldestFirst = false,
    Set<String>? favoriteIds,
  }) {
    if (search.isNotEmpty || oldestFirst || favoriteIds != null) {
      throw UnsupportedError('该相册来源未提供搜索与收藏查询。');
    }
    return month == null
        ? open(type: type)
        : openMonth(type: type, month: month);
  }

  /// 从日期两端获取连续年份，不枚举整库媒体。
  Future<List<int>> years({required RequestType type}) =>
      throw UnsupportedError('该相册来源未提供年份查询。');
}

/// 已授权系统媒体的有界分页查询，不读取原文件或计算内容指纹。
abstract class SystemGallerySource {
  Future<int> count();
  Future<List<AssetEntity>> page({required int number, required int size});
}

class PhotoManagerGalleryGateway extends SystemGalleryGateway {
  RequestType _readableType = RequestType.common;
  bool _nativeLimited = false;
  static const permissionOption = PermissionRequestOption(
    androidPermission: AndroidPermission(
      type: RequestType.common,
      mediaLocation: false,
    ),
  );

  @override
  Future<PermissionState> permission({required bool request}) async {
    final state = request
        ? await PhotoManager.requestPermissionExtend(
            requestOption: permissionOption,
          )
        : await PhotoManager.getPermissionState(
            requestOption: permissionOption,
          );
    _readableType = RequestType.common;
    _nativeLimited = state == PermissionState.limited;
    if (state == PermissionState.authorized) return state;
    // Android 13 可能仅允许照片或视频，分别读取授权后查询可访问的类别。
    Future<PermissionState> category(RequestType type) =>
        PhotoManager.getPermissionState(
          requestOption: PermissionRequestOption(
            androidPermission: AndroidPermission(
              type: type,
              mediaLocation: false,
            ),
          ),
        );
    final image = await category(RequestType.image);
    final video = await category(RequestType.video);
    if (image.hasAccess && video.hasAccess) return PermissionState.limited;
    if (image.hasAccess || video.hasAccess) {
      _readableType = image.hasAccess ? RequestType.image : RequestType.video;
      return PermissionState.limited;
    }
    return state;
  }

  @override
  Future<SystemGallerySource?> open({required RequestType type}) =>
      _open(type: type);

  @override
  Future<SystemGallerySource?> openMonth({
    required RequestType type,
    required DateTime month,
  }) => _open(type: type, month: month);

  @override
  Future<SystemGallerySource?> openQuery({
    required RequestType type,
    DateTime? month,
    String search = '',
    bool oldestFirst = false,
    Set<String>? favoriteIds,
  }) => _open(
    type: type,
    month: month,
    search: search,
    oldestFirst: oldestFirst,
    favoriteIds: favoriteIds,
  );

  RequestType? _requestedType(RequestType type) {
    if (_readableType != RequestType.common &&
        type != RequestType.common &&
        type != _readableType) {
      return null;
    }
    return type == RequestType.common ? _readableType : type;
  }

  String _mediaTypes(RequestType type) => type == RequestType.image
      ? '1'
      : type == RequestType.video
      ? '3'
      : '1,3';

  String _dateColumn(bool usesDateTaken) => usesDateTaken
      ? 'CASE WHEN datetaken / 1000 != 0 THEN datetaken / 1000 ELSE date_added END'
      : 'date_added';

  /// 只返回日期两端各一项，日期未知的媒体不参与年份范围。
  @override
  Future<List<int>> years({required RequestType type}) async {
    final requestedType = _requestedType(type);
    if (requestedType == null) return [];
    final sdk = await const MethodChannel(
      'dev.jinchuan/media',
    ).invokeMethod<int>('sdkInt');
    if (sdk == null) throw StateError('无法读取 Android 相册版本。');
    final dateColumn = _dateColumn(sdk >= 29);
    final where =
        'media_type IN (${_mediaTypes(requestedType)}) AND ($dateColumn) > 0';
    final endpoints = await Future.wait([
      for (final ascending in [false, true])
        PhotoManager.getAssetListRange(
          start: 0,
          end: 1,
          type: requestedType,
          filterOption: CustomFilter.sql(
            where: where,
            orderBy: [
              ascending
                  ? OrderByItem.asc(dateColumn)
                  : OrderByItem.desc(dateColumn),
              ascending
                  ? const OrderByItem.asc('_id')
                  : const OrderByItem.desc('_id'),
            ],
          ),
        ),
    ]);
    if (endpoints.any((items) => items.isEmpty)) return [];
    final bounds =
        endpoints.map((items) => items.single.createDateTime.year).toList()
          ..sort();
    return List.generate(
      bounds.last - bounds.first + 1,
      (index) => bounds.last - index,
    );
  }

  Future<SystemGallerySource?> _open({
    required RequestType type,
    DateTime? month,
    String search = '',
    bool oldestFirst = false,
    Set<String>? favoriteIds,
  }) async {
    final requestedType = _requestedType(type);
    if (requestedType == null) return null;
    final media = _mediaTypes(requestedType);
    final sdk = await const MethodChannel(
      'dev.jinchuan/media',
    ).invokeMethod<int>('sdkInt');
    if (sdk == null) throw StateError('无法读取 Android 相册版本。');
    final usesDateTaken = sdk >= 29;
    var where = month == null
        ? 'media_type IN ($media)'
        : monthWhere(
            calendarMonth(month),
            usesDateTaken: usesDateTaken,
          ).replaceFirst('media_type IN (1,3)', 'media_type IN ($media)');
    if (search.isNotEmpty) {
      final literal = search.replaceAll("'", "''");
      where += " AND instr(lower(_display_name), lower('$literal')) > 0";
    }
    if (favoriteIds != null) {
      final ids = favoriteIds
          .where((id) => RegExp(r'^\d+$').hasMatch(id))
          .toList();
      where += ids.isEmpty ? ' AND 0' : ' AND _id IN (${ids.join(',')})';
    }
    // 入库日期相同时用系统 ID 排序，分页不会因相同时间随机重复。
    // Android Q 起与展示日期一致：优先拍摄日，缺失时回退入库日，再以 ID 稳定分页。
    final dateColumn = _dateColumn(usesDateTaken);
    final filter = CustomFilter.sql(
      where: where,
      orderBy: [
        if (oldestFirst)
          OrderByItem.asc('CASE WHEN ($dateColumn) > 0 THEN 0 ELSE 1 END'),
        oldestFirst
            ? OrderByItem.asc(dateColumn)
            : OrderByItem.desc(dateColumn),
        oldestFirst
            ? const OrderByItem.asc('_id')
            : const OrderByItem.desc('_id'),
      ],
    )..needTitle = true;
    final albums = await PhotoManager.getAssetPathList(
      type: requestedType,
      onlyAll: true,
      filterOption: filter,
    );
    final album = albums.firstOrNull;
    return album == null ? null : _PhotoManagerGallerySource(album);
  }

  @override
  Future<void> manageAccess({required bool limited}) =>
      limited && _nativeLimited
      ? PhotoManager.presentLimited(type: RequestType.common)
      : PhotoManager.openSetting();
}

class _PhotoManagerGallerySource extends SystemGallerySource {
  _PhotoManagerGallerySource(this.album);
  final AssetPathEntity album;
  @override
  Future<int> count() => album.assetCountAsync;
  @override
  Future<List<AssetEntity>> page({required int number, required int size}) =>
      album.getAssetListPaged(page: number, size: size);
}

/// 首页直接浏览系统照片和视频，独立于传输核对和宝宝人物识别。
class SystemGalleryController extends ChangeNotifier {
  SystemGalleryController({SystemGalleryGateway? gateway, this.pageSize = 60})
    : gateway = gateway ?? PhotoManagerGalleryGateway() {
    if (pageSize < 1 || pageSize > 200) {
      throw ArgumentError.value(pageSize, 'pageSize', '分页大小须为 1 到 200。');
    }
  }

  final SystemGalleryGateway gateway;
  final int pageSize;
  final List<AssetEntity> _assets = [];
  final Set<String> _ids = {};
  List<AssetEntity> get assets => UnmodifiableListView(_assets);
  PermissionState permission = PermissionState.notDetermined;
  RequestType type = RequestType.common;
  DateTime? month;
  bool get authorized => permission.hasAccess;
  bool get limited => permission == PermissionState.limited;
  bool ready = false, loading = false, loadingMore = false, hasMore = false;
  int total = 0;
  int get generation => _epoch;
  String notice = '';
  String search = '';
  bool oldestFirst = false, favoritesOnly = false;
  MediaFavorites? _favorites;

  bool _disposed = false;
  int _epoch = 0, _nextPage = 0, _consumed = 0;
  SystemGallerySource? _source;
  Future<void>? _refreshFuture, _pageFuture, _manageFuture;

  /// 两个相册共用收藏记录，收藏筛选中的变化重新读取当前查询。
  void attachFavorites(MediaFavorites favorites) {
    if (identical(_favorites, favorites)) return;
    _favorites?.removeListener(_favoritesChanged);
    _favorites = favorites;
    favorites.addListener(_favoritesChanged);
  }

  void _favoritesChanged() {
    if (favoritesOnly && !_favorites!.saving) {
      _startRefresh(requestPermission: false);
    }
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  bool _current(int epoch, RequestType requestedType) =>
      !_disposed && epoch == _epoch && requestedType == type;

  /// 启动只读取现有授权；需要授权时由用户明确点击入口。
  Future<void> initialize() => refresh();

  /// 打开年份选择时读取当前授权，查询范围不受已选月份限制。
  Future<List<int>> loadYears({RequestType? mediaType}) async {
    if (_disposed) return [];
    final pending = _refreshFuture;
    if (loading && pending != null) await pending;
    if (_disposed) return [];
    final state = await gateway.permission(request: false);
    if (_disposed || !state.hasAccess) return [];
    return gateway.years(type: mediaType ?? type);
  }

  /// 刷新失效旧分页结果，重新读取授权范围和最新的系统媒体。
  Future<void> refresh() {
    if (_disposed) return Future<void>.value();
    if (loading) return _refreshFuture ?? Future<void>.value();
    return _startRefresh(requestPermission: false);
  }

  Future<void> _startRefresh({required bool requestPermission}) {
    final operation = _reload(requestPermission: requestPermission);
    _refreshFuture = operation;
    return operation;
  }

  Future<void> _reload({required bool requestPermission}) async {
    final epoch = ++_epoch;
    final requestedType = type;
    loading = true;
    loadingMore = false;
    hasMore = false;
    notice = '';
    total = 0;
    _source = null;
    _pageFuture = null;
    _nextPage = 0;
    _consumed = 0;
    _assets.clear();
    _ids.clear();
    _changed();
    try {
      final state = await gateway.permission(request: requestPermission);
      if (!_current(epoch, requestedType)) return;
      permission = state;
      if (!authorized) {
        notice = '允许访问系统相册后，照片和视频会显示在这里。';
        return;
      }
      notice = '';
      final source = await gateway.openQuery(
        type: requestedType,
        month: month,
        search: search,
        oldestFirst: oldestFirst,
        favoriteIds: favoritesOnly ? (_favorites?.ids ?? <String>{}) : null,
      );
      if (!_current(epoch, requestedType)) return;
      if (source == null) return;
      final count = await source.count();
      if (!_current(epoch, requestedType)) return;
      if (count < 0) throw StateError('系统相册数量无效。');
      final batch = count == 0
          ? <AssetEntity>[]
          : await source.page(number: 0, size: pageSize);
      if (!_current(epoch, requestedType)) return;
      _source = source;
      total = count;
      _append(batch);
      _nextPage = 1;
      _consumed = batch.length;
      hasMore = batch.length == pageSize && _consumed < total;
    } catch (_) {
      if (_current(epoch, requestedType)) {
        notice = '暂时无法读取系统相册，请刷新重试。';
      }
    } finally {
      if (!_disposed && epoch == _epoch) {
        loading = false;
        ready = true;
        _changed();
      }
    }
  }

  void _append(List<AssetEntity> batch) {
    for (final asset in batch) {
      if (favoritesOnly && _favorites?.isFavorite(asset) != true) continue;
      if (_ids.add(asset.id)) _assets.add(asset);
    }
  }

  /// 显式核对读取当前查询范围的媒体属性，不提前生成缩略图或改变浏览分页。
  Stream<List<AssetEntity>> verificationPages() async* {
    final epoch = _epoch, requestedType = type, source = _source;
    if (source == null || loading || !authorized) return;
    final count = total;
    for (var page = 0; page * pageSize < count; page++) {
      final batch = await source.page(number: page, size: pageSize);
      if (!_current(epoch, requestedType)) return;
      if (batch.isEmpty) throw StateError('相册内容已变化，请刷新后重新核对。');
      yield favoritesOnly
          ? batch
                .where((asset) => _favorites?.isFavorite(asset) == true)
                .toList()
          : batch;
    }
  }

  /// 连续滚动只发出一个分页请求，失败后重试同一页。
  Future<void> loadMore() {
    if (_disposed || loading || !authorized || !hasMore || _source == null) {
      return Future<void>.value();
    }
    if (loadingMore) return _pageFuture ?? Future<void>.value();
    final operation = _loadPage(_epoch, type, _source!);
    _pageFuture = operation;
    return operation;
  }

  Future<void> _loadPage(
    int epoch,
    RequestType requestedType,
    SystemGallerySource source,
  ) async {
    loadingMore = true;
    notice = '';
    _changed();
    try {
      final batch = await source.page(number: _nextPage, size: pageSize);
      if (!_current(epoch, requestedType)) return;
      _append(batch);
      _nextPage++;
      _consumed += batch.length;
      hasMore = batch.length == pageSize && _consumed < total;
    } catch (_) {
      if (_current(epoch, requestedType)) {
        notice = '下一页暂时无法读取，请重试。';
      }
    } finally {
      if (_current(epoch, requestedType)) {
        loadingMore = false;
        _changed();
      }
    }
  }

  /// 只有显式操作才申请访问权限，不附带定位、文件写入或媒体管理权限。
  Future<void> requestAccess() async {
    if (_disposed) return;
    final pending = _refreshFuture;
    if (loading && pending != null) await pending;
    if (_disposed) return;
    if (loading) return;
    await _startRefresh(requestPermission: true);
  }

  /// 部分授权打开系统选择器，其余状态打开系统应用授权设置。
  Future<void> manageAccess() {
    if (_disposed) return Future<void>.value();
    if (_manageFuture != null) return _manageFuture!;
    final operation = _manageAccess();
    _manageFuture = operation;
    return operation.whenComplete(() => _manageFuture = null);
  }

  Future<void> _manageAccess() async {
    try {
      await gateway.manageAccess(limited: limited);
      final pending = _refreshFuture;
      if (loading && pending != null) await pending;
      if (!_disposed) await refresh();
    } catch (_) {
      if (!_disposed) {
        notice = '暂时无法打开相册授权，请在系统设置中调整。';
        _changed();
      }
    }
  }

  /// 类型筛选交给系统查询，避免只过滤当前已加载的少量媒体。
  Future<void> setType(RequestType value) async {
    if (_disposed || value == type) return;
    if (value != RequestType.common &&
        value != RequestType.image &&
        value != RequestType.video) {
      throw ArgumentError.value(value, 'type', '仅支持照片和视频。');
    }
    type = value;
    hasMore = false;
    _source = null;
    _assets.clear();
    _ids.clear();
    _changed();
    final pending = _refreshFuture;
    if (loading && pending != null) await pending;
    if (!_disposed) await refresh();
  }

  /// 直接按年月查询系统媒体，分页大小及授权范围保持不变。
  Future<void> setMonth(DateTime? value) async {
    if (_disposed) return;
    final pending = _refreshFuture;
    if (loading && pending != null) await pending;
    if (_disposed) return;
    final next = value == null ? null : DateTime(value.year, value.month);
    if (month == next) return;
    month = next;
    await refresh();
  }

  /// 查询变化立即失效旧响应，搜索空结果也能继续修改或清空条件。
  Future<void> setQuery({
    String? search,
    bool? oldestFirst,
    bool? favoritesOnly,
  }) {
    if (_disposed) return Future.value();
    final nextSearch = search?.trim() ?? this.search;
    final nextOrder = oldestFirst ?? this.oldestFirst;
    final nextFavorites = favoritesOnly ?? this.favoritesOnly;
    if (nextSearch == this.search &&
        nextOrder == this.oldestFirst &&
        nextFavorites == this.favoritesOnly) {
      return Future.value();
    }
    this.search = nextSearch;
    this.oldestFirst = nextOrder;
    this.favoritesOnly = nextFavorites;
    return _startRefresh(requestPermission: false);
  }

  @override
  void dispose() {
    _disposed = true;
    _epoch++;
    _favorites?.removeListener(_favoritesChanged);
    super.dispose();
  }
}
