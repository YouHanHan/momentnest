import 'dart:async';
import 'dart:io';
import 'dart:convert';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:wakelock_plus/wakelock_plus.dart';
import 'local_store.dart';
import 'models.dart';
import 'receiver_api.dart';
import 'backup_catalog.dart';
import 'month_scan.dart';

/// 在后台 isolate 中计算完整内容指纹，避免原图读取阻塞界面。
Future<Json> fingerprintFile(String path) async {
  final file = File(path), before = await File(path).stat();
  final hash = await sha256.bind(file.openRead()).first;
  final after = await file.stat();
  if (before.size != after.size || before.modified != after.modified) {
    throw StateError('图片在读取期间被修改，请重试。');
  }
  return {
    'hash': hash.toString(),
    'size': after.size,
    'fileModified': after.modified.millisecondsSinceEpoch,
  };
}

/// Android 使用原生工作线程计算完整指纹，避免调试包逐字节执行 Dart 哈希。
Future<Json> fingerprintAndroidFile(String path) async {
  final identity = await TransferController._media
      .invokeMapMethod<String, dynamic>('fingerprint', {'path': path});
  if (identity == null ||
      identity['hash'] is! String ||
      !RegExp(r'^[0-9a-f]{64}$').hasMatch(identity['hash'] as String) ||
      identity['size'] is! int ||
      (identity['size'] as int) < 0 ||
      identity['fileModified'] is! int) {
    throw StateError('原文件指纹读取失败，请重试。');
  }
  return identity;
}

class TransferController extends ChangeNotifier {
  TransferController({LocalStore? store}) : store = store ?? LocalStore();
  final LocalStore store;
  bool ready = false,
      busy = false,
      running = false,
      loadingPhotos = false,
      hasMore = false,
      limited = false,
      online = false;
  String notice = '',
      progress = '',
      filter = 'all',
      mode = 'capture',
      manualDate = dateLabel(DateTime.now());
  List<ReceiverConnection> connections = [];
  ReceiverConnection? connection;
  String? libraryId;
  bool currentLibraryAvailable = false, supportsCurrentLibraryContext = false;
  String? _preparedReceiverId, _preparedLibraryId;
  List<Json> libraries = [], roots = [];
  List<AssetPathEntity> albums = [];
  AssetPathEntity? album;
  List<AssetEntity> photos = [];
  final Set<String> selected = {};
  Map<String, Json> observations = {};
  List<UploadTask> tasks = [];
  List<Json> prepared = [];
  String? selectedMonth = calendarMonth(DateTime.now());
  final monthProgress = MonthScanProgress();
  MonthPhotoSource? _monthSource;
  int photoPage = 0;
  bool _scanFinished = false;
  final _visibleIds = <String>{};
  bool checking = false, checkPaused = false, catalogComplete = false;
  String checkProgress = '', checkNotice = '';
  int _catalogEpoch = 0, _checkEpoch = 0;
  int _receiverEpoch = 0;
  Future<void>? _checkJob;
  ReceiverApi? _checkApi;
  final Set<String> _checked = {};
  final Map<String, String> checkErrors = {};
  Timer? _scanRefresh;
  bool _pause = false, _disposed = false;
  ReceiverApi? _activeApi;
  bool _foreground = true;
  bool _monthActive = true;
  static const _media = MethodChannel('dev.momentnest/media');

  void changed() {
    if (!_disposed) notifyListeners();
  }

  /// 月份核对只在备份页面运行，避免普通相册浏览触发原图哈希。
  void setMonthActive(bool value) {
    _monthActive = value;
    if (!value) stopChecking();
  }

  Future<void> initialize() async {
    try {
      await store.open();
      connections = ((await store.preference('connections')) as List? ?? [])
          .map(
            (item) =>
                ReceiverConnection.fromJson(Map<String, dynamic>.from(item)),
          )
          .toList();
      final active = await store.preference('activeReceiver');
      connection =
          connections.where((item) => item.id == active).firstOrNull ??
          connections.firstOrNull;
      mode = await store.preference('dateMode') ?? 'capture';
      final savedMonth = await store.preference('scanMonth');
      if (savedMonth is String &&
          (savedMonth == 'unknown' ||
              RegExp(r'^\d{4}-(0[1-9]|1[0-2])$').hasMatch(savedMonth))) {
        selectedMonth = savedMonth;
      }
      manualDate = await store.preference('manualDate') ?? manualDate;
      tasks = await store.tasks();
      for (final task in tasks.where(
        (task) => ![
          'complete',
          'skipped',
          'cancelled',
          'failed',
          'paused',
        ].contains(task.state),
      )) {
        task.state = 'paused';
        task.data['error'] = '上次任务中断，点击继续核对进度。';
        await store.saveTask(task);
      }
      if (connection != null) {
        await _loadTarget();
      }
      ready = true;
      changed();
      // 相册首页独立读取系统缩略图，月份核对在用户打开备份入口后启动。
      if (connection != null) {
        try {
          await reconnect();
        } catch (error) {
          notice = explain(error);
        }
      }
    } catch (error) {
      notice = '本地记录初始化失败：${explain(error)}';
    }
    changed();
  }

  String explain(Object error) {
    if (error is FormatException) return error.message;
    if (error is HandshakeException) return '无法校验电脑身份。请确认配对信息，必要时重新配对。';
    if (error is SocketException || error is TimeoutException) {
      return '无法连接电脑。请确认同一局域网、电脑已打开并允许防火墙连接。';
    }
    if (error is ApiException) return error.message;
    if (error is PlatformException) return error.message ?? '系统权限或存储不可用。';
    return error
        .toString()
        .replaceFirst('Bad state: ', '')
        .replaceFirst('FormatException: ', '');
  }

  Future<void> action(Future<void> Function() work) async {
    if (busy) return;
    stopChecking();
    busy = true;
    notice = '';
    changed();
    try {
      await work();
    } catch (error) {
      notice = explain(error);
    } finally {
      busy = false;
      progress = '';
      changed();
      unawaited(checkPhotos());
    }
  }

  Future<ReceiverApi> openApi(ReceiverConnection target) async {
    final token = await store.token(target.id);
    if (token == null) throw StateError('设备凭据不可用，请重新配对。');
    return ReceiverApi(
      address: target.address,
      fingerprint: target.fingerprint,
      token: token,
    );
  }

  Future<void> pair(String text) async {
    if (running) throw StateError('请先暂停传输。');
    final info = PairingPayload.parse(text);
    Object? lastError;
    for (final address in info.addresses) {
      final api = ReceiverApi(address: address, fingerprint: info.fingerprint);
      try {
        final result = await api.request(
          'POST',
          '/v1/pair',
          json: {'secret': info.secret, 'name': 'Android 手机'},
        );
        if (result['receiverId'] != info.receiverId) {
          throw StateError('电脑身份不匹配。');
        }
        final next = ReceiverConnection(
          id: result['receiverId'],
          name: result['name'],
          address: address,
          fingerprint: info.fingerprint,
          deviceId: result['deviceId'],
        );
        await store.saveToken(next.id, result['token']);
        connections = [
          ...connections.where((item) => item.id != next.id),
          next,
        ];
        await store.setPreference(
          'connections',
          connections.map((item) => item.toJson()).toList(),
        );
        await selectReceiver(next.id);
        notice = '已连接 ${next.name}。';
        return;
      } catch (error) {
        lastError = error;
        if (error is ApiException) rethrow;
      } finally {
        api.close();
      }
    }
    throw lastError ?? StateError('配对未完成，请重试。');
  }

  Future<void> selectReceiver(String id) async {
    if (running) throw StateError('请先暂停传输再切换电脑。');
    _receiverEpoch++;
    stopChecking();
    _checked.clear();
    checkErrors.clear();
    _scanFinished = false;
    monthProgress.reset(monthProgress.total);
    connection = connections.firstWhere((item) => item.id == id);
    online = false;
    selected.clear();
    prepared = [];
    await store.setPreference('activeReceiver', id);
    await _loadTarget();
    await reconnect();
  }

  Future<void> _loadTarget() async {
    final target = connection!;
    currentLibraryAvailable = false;
    supportsCurrentLibraryContext = false;
    libraryId = await store.preference('library:${target.id}');
    libraries =
        ((await store.preference('libraries:${target.id}')) as List? ?? [])
            .map((item) => Map<String, dynamic>.from(item))
            .toList();
    await _loadObservations();
  }

  Future<void> _loadObservations() async {
    final target = connection?.id, library = libraryId, visible = photos;
    final result = <String, Json>{};
    // 整月展示时分批读取记录，避免超过 SQLite 参数数量限制。
    if (target != null && library != null) {
      for (var start = 0; start < visible.length; start += monthPageSize) {
        final end = (start + monthPageSize).clamp(0, visible.length);
        result.addAll(
          await store.observationsFor(
            target,
            library,
            visible.sublist(start, end).map((item) => item.id).toList(),
          ),
        );
        if (_disposed ||
            connection?.id != target ||
            libraryId != library ||
            !identical(visible, photos)) {
          return;
        }
      }
    }
    if (connection?.id != target ||
        libraryId != library ||
        !identical(visible, photos)) {
      return;
    }
    observations = result;
    for (final asset in visible) {
      final saved = result[asset.id];
      if (_checked.contains('${asset.id}:${version(asset)}') &&
          monthProgress.state(asset) != null) {
        continue;
      }
      final state = saved != null && saved['version'] == version(asset)
          ? (saved['status'] as String? ?? 'unknown')
          : 'unknown';
      monthProgress.record(asset, state);
    }
  }

  Future<void> reconnect() async {
    stopChecking();
    _checked.clear();
    checkErrors.clear();
    _scanFinished = false;
    final target = connection;
    if (target == null) return;
    final epoch = ++_receiverEpoch;
    bool current() =>
        !_disposed &&
        epoch == _receiverEpoch &&
        connection?.id == target.id &&
        connection?.address == target.address;
    final api = await openApi(target);
    try {
      final info = await api.request('GET', '/v1/receiver');
      // 迟到的旧电脑响应不能改写已经切换的当前库或在线状态。
      if (!current()) return;
      if (info['receiverId'] != target.id) throw StateError('电脑身份发生变化，请重新配对。');
      applyReceiverSnapshot(info);
      await store.setPreference('libraries:${target.id}', libraries);
      if (!current()) return;
      await store.setPreference('library:${target.id}', libraryId);
      if (!current()) return;
      await _loadObservations();
      if (!current()) return;
      online = true;
      if (info['accepting'] != true) notice = '电脑已暂停接收，可在电脑端继续接收。';
    } catch (error) {
      if (current()) {
        online = false;
        rethrow;
      }
    } finally {
      api.close();
      if (current()) {
        changed();
        unawaited(checkPhotos());
      }
    }
  }

  /// 新接收端的当前库以电脑为准；显式不可用时不回退到其他目录。
  void applyReceiverSnapshot(Json info) {
    final previous = libraryId;
    libraries = (info['libraries'] as List)
        .map((item) => Map<String, dynamic>.from(item))
        .toList();
    supportsCurrentLibraryContext = info.containsKey('currentLibraryId');
    if (supportsCurrentLibraryContext) {
      final current = info['currentLibraryId'];
      libraryId = current is String ? current : null;
      currentLibraryAvailable =
          info['currentLibraryAvailable'] == true &&
          libraries.any((item) => item['id'] == libraryId);
    } else {
      if (!libraries.any((item) => item['id'] == libraryId)) {
        libraryId = libraries.firstOrNull?['id'];
      }
      currentLibraryAvailable = libraryId != null;
    }
    if (previous != libraryId) {
      stopChecking();
      checkNotice = '';
      _checked.clear();
      checkErrors.clear();
      _scanFinished = false;
      monthProgress.reset(monthProgress.total);
    }
  }

  /// 新批次只允许使用刚从电脑确认的可用目标，旧任务继续保留自己的库。
  void requireCurrentLibrary() {
    if (connection == null) throw StateError('请先连接电脑。');
    if (libraryId == null || !currentLibraryAvailable) {
      throw StateError(
        libraryId == null
            ? '电脑尚未选择当前照片库，请在电脑上选择后刷新。'
            : '电脑当前照片库暂时不可用，请在电脑上恢复目录后刷新。',
      );
    }
  }

  Future<void> changeAddress(String address) async {
    if (running) throw StateError('请先暂停传输。');
    validateAddress(address);
    final current = connection!;
    _receiverEpoch++;
    connection = current.at(address);
    connections = connections
        .map((item) => item.id == current.id ? connection! : item)
        .toList();
    await store.setPreference(
      'connections',
      connections.map((item) => item.toJson()).toList(),
    );
    await reconnect();
  }

  /// 手机仅查看接收目录，切库由电脑决定。
  Future<void> selectLibrary(String id) async {
    throw StateError('请在电脑上切换当前照片库，手机刷新后查看新目标。');
  }

  Future<void> setMode(String value) async {
    mode = value;
    await store.setPreference('dateMode', value);
    changed();
  }

  /// 保留指定日期偏好，重新打开应用后仍使用用户选择的日期。
  Future<void> setManualDate(String value) async {
    await store.setPreference('manualDate', value);
    manualDate = value;
    changed();
  }

  Future<void> loadPhotos({bool requestPermission = true}) async {
    if (loadingPhotos) return;
    stopChecking();
    final option = const PermissionRequestOption(
      androidPermission: AndroidPermission(
        type: RequestType.common,
        mediaLocation: true,
      ),
    );
    final permission = requestPermission
        ? await PhotoManager.requestPermissionExtend(requestOption: option)
        : await PhotoManager.getPermissionState(requestOption: option);
    if (!permission.hasAccess) {
      _catalogEpoch++;
      photos = [];
      observations = {};
      _visibleIds.clear();
      _monthSource = null;
      selected.clear();
      prepared = [];
      monthProgress.reset(0);
      catalogComplete = false;
      throw StateError('尚未获得相册访问权限，请授权后重试。');
    }
    limited = !permission.isAuth;
    albums = await PhotoManager.getAssetPathList(
      type: RequestType.common,
      hasAll: true,
    );
    album =
        albums.where((item) => item.id == album?.id).firstOrNull ??
        albums.firstOrNull;
    await loadMonth();
  }

  /// 月份筛选在系统媒体库执行，只有该月份的当前页进入照片列表。
  Future<MonthPhotoSource> openMonthSource(
    AssetPathEntity source,
    String month,
  ) => MonthPhotoSource.open(source, month);

  Future<void> loadMonth() async {
    stopChecking();
    _checked.clear();
    checkErrors.clear();
    _scanFinished = false;
    catalogComplete = false;
    checkNotice = '';
    final epoch = ++_catalogEpoch;
    loadingPhotos = true;
    photos = [];
    observations = {};
    _visibleIds.clear();
    selected.clear();
    prepared = [];
    _monthSource = null;
    photoPage = -1;
    hasMore = false;
    monthProgress.reset(0);
    changed();
    try {
      if (album == null) {
        catalogComplete = true;
        return;
      }
      final source = await openMonthSource(album!, selectedMonth!);
      final count = await source.count();
      if (_disposed || epoch != _catalogEpoch) return;
      _monthSource = source;
      monthProgress.reset(count);
      // 只分页读取日期和媒体属性，缩略图仍由可见网格按需加载。
      hasMore = count > 0;
      await _readRemainingMonth(source, epoch);
      if (_disposed || epoch != _catalogEpoch) return;
      catalogComplete = true;
    } finally {
      if (epoch == _catalogEpoch) {
        loadingPhotos = false;
        changed();
        unawaited(checkPhotos());
      }
    }
  }

  Future<void> selectAlbum(String id) async {
    album = albums.firstWhere((item) => item.id == id);
    await loadMonth();
  }

  /// 翻页替换上一批照片，不累积整个月的媒体对象和详情。
  /// 整月展示改为从下一批持续追加；保留入口供读取中断后继续。
  Future<void> loadPhotoPage(int number) async {
    final source = _monthSource;
    if (source == null ||
        loadingPhotos ||
        number != photoPage + 1 ||
        number * monthPageSize >= monthProgress.total) {
      return;
    }
    loadingPhotos = true;
    final epoch = _catalogEpoch;
    changed();
    try {
      await _readRemainingMonth(source, epoch);
      if (_disposed || epoch != _catalogEpoch) return;
      catalogComplete = true;
    } finally {
      if (epoch == _catalogEpoch) {
        loadingPhotos = false;
        changed();
      }
    }
  }

  Future<void> morePhotos() => loadPhotoPage(photoPage + 1);

  /// 自动读完所选月份，逐批呈现媒体列表，不读取原文件或其他月份。
  Future<void> _readRemainingMonth(MonthPhotoSource source, int epoch) async {
    while (hasMore) {
      final number = photoPage + 1;
      final items = await source.page(number);
      if (_disposed || epoch != _catalogEpoch) return;
      photos.addAll(items);
      _visibleIds.addAll(items.map((item) => item.id));
      photoPage = number;
      hasMore =
          items.isNotEmpty &&
          (number + 1) * monthPageSize < monthProgress.total;
      changed();
    }
    await _loadObservations();
  }

  String version(AssetEntity asset) => photoVersion(asset);
  String status(AssetEntity asset) {
    final tracked = monthProgress.state(asset);
    if (tracked != null) return tracked;
    final saved = observations[asset.id];
    if (saved == null || saved['version'] != version(asset)) return 'unknown';
    return saved['status'] ?? 'unknown';
  }

  List<AssetEntity> get monthPhotos =>
      photos.where((item) => photoMonth(item) == selectedMonth).toList();
  List<AssetEntity> get visiblePhotos => monthPhotos
      .where((item) => matchesBackupFilter(status(item), filter))
      .toList();

  /// 切月只改变浏览范围，自动核对优先处理刚打开的月份。
  /// 同时替换系统查询范围，释放上一个月份的媒体列表和轻量状态。
  Future<void> selectMonth(String value) async {
    monthWhere(value, usesDateTaken: true);
    stopChecking();
    selectedMonth = value;
    filter = 'all';
    await store.setPreference('scanMonth', value);
    await loadMonth();
  }

  void selectUnbackedMonth() {
    if (!catalogComplete) throw StateError('请等待本月目录读取完成。');
    selected
      ..clear()
      ..addAll(monthProgress.pendingIds);
    if (selected.isEmpty) throw StateError('本月没有已确认未备份的照片；待核对照片不会加入上传。');
    changed();
  }

  /// 中断后续核对及网络请求；正在计算的单张指纹完成后会丢弃结果。
  void stopChecking({bool pause = false}) {
    _scanRefresh?.cancel();
    _scanRefresh = null;
    _checkEpoch++;
    _checkApi?.close();
    _checkApi = null;
    checking = false;
    checkProgress = '';
    if (pause) checkPaused = true;
    changed();
  }

  /// 使用缓存指纹向电脑重新求证，不自动排队或上传原图。
  Future<void> resumeChecking() async {
    checkPaused = false;
    await checkPhotos();
  }

  Future<void> checkPhotos({bool restart = false}) async {
    if (restart) checkPaused = false;
    if (_disposed ||
        !_monthActive ||
        !_foreground ||
        busy ||
        running ||
        loadingPhotos ||
        !online ||
        connection == null ||
        libraryId == null ||
        checkPaused ||
        (_scanFinished && !restart)) {
      return;
    }
    stopChecking();
    final epoch = _checkEpoch;
    await _checkJob;
    if (epoch != _checkEpoch || _disposed) return;
    if (restart) {
      _checked.clear();
      checkErrors.clear();
      _scanFinished = false;
    }
    final source = _monthSource;
    final total = source == null ? monthPhotos.length : monthProgress.total;
    _checkJob = _checkScope(
      _scanPages(source, total, epoch),
      epoch,
      connection!,
      libraryId!,
      total,
    );
    await _checkJob;
  }

  /// 顺序读取当前月的小批次，切月或暂停后不再发起下一页查询。
  Stream<List<AssetEntity>> _scanPages(
    MonthPhotoSource? source,
    int total,
    int epoch,
  ) async* {
    if (source == null) {
      yield monthPhotos;
      return;
    }
    for (var page = 0; page * monthPageSize < total; page++) {
      if (_disposed || epoch != _checkEpoch) return;
      final items = await source.page(page);
      if (_disposed || epoch != _checkEpoch) return;
      yield items;
    }
  }

  Future<void> _checkScope(
    Stream<List<AssetEntity>> pages,
    int epoch,
    ReceiverConnection target,
    String library,
    int total,
    {String scopeLabel = '本月扫描', void Function(AssetEntity, Json)? onObserved}
  ) async {
    bool active() => !_disposed && epoch == _checkEpoch && _foreground;
    ReceiverApi? api;
    checking = true;
    checkNotice = '';
    var incomplete = false;
    changed();
    try {
      api = await openApi(target);
      if (!active()) return;
      _checkApi = api;
      var index = 0;
      await for (final batch in pages) {
        for (final asset in batch) {
          if (!active()) break;
          index++;
          if (_checked.contains('${asset.id}:${version(asset)}')) continue;
          checkProgress =
              '$scopeLabel $index/$total · ${monthLabel(photoMonth(asset))}';
          _scanChanged();
          Json identity;
          try {
            identity = await inspectPhoto(asset, useCache: true);
          } catch (error) {
            if (!active()) break;
            checkErrors[asset.id] = explain(error);
            final previous = (await store.observationsFor(target.id, library, [asset.id]))[asset.id];
            if (!active()) break;
            final unavailable = <String, dynamic>{
              if (previous?['version'] == version(asset)) ...previous!,
              'status': 'unknown',
              'previousReceipt': previous?['version'] == version(asset) ? (previous?['receipt'] ?? previous?['previousReceipt']) : null,
              'receipt': null,
              'receiptState': 'unavailable',
              'checkedAt': DateTime.now().toIso8601String(),
              'checkError': explain(error),
              'version': version(asset),
            };
            await store.observe(asset.id, target.id, library, version(asset), unavailable);
            if (!active()) break;
            onObserved?.call(asset, unavailable);
            observations.remove(asset.id);
            monthProgress.record(asset, 'unknown');
            _checked.add('${asset.id}:${version(asset)}');
            continue;
          }
          if (!active()) break;
          final response = await api.request(
            'POST',
            '/v1/assets/check',
            json: {
              'libraryId': library,
              'assets': [
                {'hash': identity['hash'], 'size': identity['size']},
              ],
            },
          );
          if (!active()) break;
          final result = Map<String, dynamic>.from(
            (response['results'] as List).single,
          );
          incomplete = incomplete || result['complete'] != true;
          if (result['hash'] != identity['hash'] ||
              result['size'] != identity['size']) {
            throw StateError('电脑核对结果与照片不符，请重新连接。');
          }
          roots = (response['roots'] as List)
              .map((item) => Map<String, dynamic>.from(item))
              .toList();
          final saved = await _observation(
            asset,
            identity,
            result,
            target.id,
            library,
            epoch: epoch,
          );
          if (!active()) break;
          onObserved?.call(asset, saved);
          _checked.add('${asset.id}:${version(asset)}');
          checkErrors.remove(asset.id);
          _scanChanged();
        }
        if (!active()) break;
      }
      if (active()) {
        _scanFinished = true;
        checkNotice = incomplete
            ? '核对范围尚未完整。请确认电脑已更新、已启用目录可访问且历史扫描完成，再重新核对。未找到匹配的照片仍为待核对。'
            : '$scopeLabel结束。未传入仅表示已登记范围内未找到相同原图；无法核实的项目不会自动上传。';
        if (checkErrors.isNotEmpty) {
          checkNotice += ' ${checkErrors.length} 张无法读取，仍为待核对，可长按查看原因。';
        }
      }
    } catch (error) {
      if (active()) {
        online = false;
        checkNotice = '核对已停止：${explain(error)} 未完成项保留最近记录，重新连接后继续。';
      }
    } finally {
      api?.close();
      if (epoch == _checkEpoch) {
        _scanRefresh?.cancel();
        _scanRefresh = null;
        _checkApi = null;
        checking = false;
        checkProgress = '';
        changed();
      }
    }
  }

  /// 用户发起的普通相册核对复用月份核对、取消与内容回执校验流程。
  Future<void> checkGallery(
    Stream<List<AssetEntity>> pages, int total,
    void Function(AssetEntity, Json) onObserved,
  ) async {
    if (!ready || busy || running || !online || !_foreground) return;
    requireCurrentLibrary();
    stopChecking();
    final epoch = _checkEpoch;
    await _checkJob;
    if (_disposed || epoch != _checkEpoch) return;
    _checked.clear();
    checkErrors.clear();
    _checkJob = _checkScope(pages, epoch, connection!, libraryId!, total,
        scopeLabel: '相册核对', onObserved: onObserved);
    await _checkJob;
  }

  /// 批量核对时合并界面刷新，避免每张小图触发整页重建。
  void _scanChanged() {
    _scanRefresh ??= Timer(const Duration(milliseconds: 250), () {
      _scanRefresh = null;
      changed();
    });
  }

  void toggle(String id) {
    if (selected.contains(id)) {
      selected.remove(id);
    } else {
      selected.add(id);
    }
    changed();
  }

  void selectVisible() {
    selected.addAll(visiblePhotos.map((item) => item.id));
    changed();
  }

  Future<Json> _observation(
    AssetEntity asset,
    Json identity,
    Json result,
    String target,
    String library, {
    int? epoch,
  }) async {
    final data = await recordBackupObservation(asset, identity, result, target, library);
    if (connection?.id == target &&
        libraryId == library &&
        (epoch == null || epoch == _checkEpoch)) {
      if (photoMonth(asset) == selectedMonth) {
        monthProgress.record(asset, data['status']);
      }
      if (_visibleIds.contains(asset.id)) {
        observations[asset.id] = data;
      }
    }
    return data;
  }

  /// 普通相册和按月备份共用记录规则，旧回执仅保留为同一内容的历史证据。
  Future<Json> recordBackupObservation(
    AssetEntity asset, Json identity, Json result, String target, String library,
  ) async {
    final previous = (await store.observationsFor(target, library, [asset.id]))[asset.id];
    final historical = previous?['hash'] == identity['hash'] && previous?['size'] == identity['size']
        ? (previous?['receipt'] ?? previous?['previousReceipt']) : null;
    final evidence = <String, dynamic>{
      ...result,
      'previousReceipt': result['previousReceipt'] ?? result['receipt'] ?? historical,
    };
    for (final item in [result['receipt'], result['previousReceipt']]) {
      if (item is! Map) continue;
      for (final field in {'receiverId': target, 'libraryId': library, 'hash': identity['hash'], 'size': identity['size']}.entries) {
        if (item.containsKey(field.key) && item[field.key] != field.value) {
          throw StateError('电脑回执与当前照片或目标不符，请重新核对。');
        }
      }
    }
    final data = <String, dynamic>{
      ...identity,
      'status': backupState(evidence),
      'receipt': result['receipt'],
      'previousReceipt': evidence['previousReceipt'],
      'receiptState': result['receiptState'],
      'matches': result['matches'] ?? [],
      'checkedAt': DateTime.now().toIso8601String(),
    };
    await store.observe(asset.id, target, library, version(asset), data);
    return {...data, 'version': version(asset)};
  }

  Future<Json> inspectPhoto(AssetEntity asset, {bool useCache = false}) async {
    final file = await asset.originFile;
    if (file == null) throw StateError('照片不可读取，可能未授权或文件已移除。');
    if (useCache) {
      final cached = await store.cachedIdentity(asset.id, version(asset));
      final stat = await file.stat();
      if (cached != null &&
          cached['size'] == stat.size &&
          cached['fileModified'] == stat.modified.millisecondsSinceEpoch &&
          cached['path'] == file.path) {
        return {
          ...cached,
          if (!cached.containsKey('creationDate'))
            'creationDate': await _creationDate(asset),
        };
      }
    }
    final identity = Platform.isAndroid
        ? await fingerprintAndroidFile(file.path)
        : await compute(fingerprintFile, file.path);
    if ((identity['size'] as int) > 2 * 1024 * 1024 * 1024) {
      throw StateError('单个照片或视频不能超过 2 GiB。');
    }
    final title = await asset.titleAsync;
    final capture = await _media.invokeMethod<String>('captureDate', {
      'path': file.path,
      'assetId': asset.id,
      'kind': asset.type == AssetType.video ? 'video' : 'photo',
    });
    return {
      ...identity,
      'filename': title,
      'assetId': asset.id,
      'version': version(asset),
      'kind': asset.type == AssetType.video ? 'video' : 'photo',
      'captureDate': capture,
      'creationDate': await _creationDate(asset),
      'path': file.path,
    };
  }

  /// 创建日读取手机媒体记录，避免使用导出缓存或电脑接收后的创建时间。
  Future<String?> _creationDate(AssetEntity asset) =>
      _media.invokeMethod<String>('creationDate', {
        'assetId': asset.id,
        'kind': asset.type == AssetType.video ? 'video' : 'photo',
      });

  /// 上传前读取当前原图并向电脑核对，不能仅依赖相册中的旧状态。
  Future<void> prepareSelection({bool onlyUnbacked = false}) async {
    stopChecking();
    if (running) throw StateError('请先暂停当前传输。');
    if (connection == null) throw StateError('请先连接电脑。');
    if (selected.isEmpty) throw StateError('请先选择照片。');
    await reconnect();
    requireCurrentLibrary();
    final target = connection!,
        library = libraryId!,
        api = await openApi(connection!);
    prepared = [];
    _preparedReceiverId = target.id;
    _preparedLibraryId = library;
    int index = 0;
    try {
      for (final id in selected.toList()) {
        progress = '读取并核对 ${++index}/${selected.length}';
        changed();
        final asset = await AssetEntity.fromId(id);
        if (asset == null) throw StateError('部分所选照片不可访问，请刷新相册后重试。');
        if (onlyUnbacked && photoMonth(asset) != selectedMonth) continue;
        final identity = await inspectPhoto(asset);
        final response = await api.request(
          'POST',
          '/v1/assets/check',
          json: {
            'libraryId': library,
            'assets': [
              {'hash': identity['hash'], 'size': identity['size']},
            ],
          },
        );
        final result = Map<String, dynamic>.from(
          (response['results'] as List).single,
        );
        roots = (response['roots'] as List)
            .map((item) => Map<String, dynamic>.from(item))
            .toList();
        await _observation(asset, identity, result, target.id, library);
        if (!onlyUnbacked || backupState(result) == 'pending') {
          prepared.add({...identity, ...result});
        }
      }
    } finally {
      api.close();
      changed();
    }
    if (onlyUnbacked && prepared.isEmpty) {
      notice = '重新核对后没有可上传的未备份照片；电脑已有和待核对项均已排除。';
    }
  }

  Future<void> enqueue({
    required bool skipHistory,
    bool onlyUnbacked = false,
  }) async {
    stopChecking();
    if (running) throw StateError('请先暂停当前传输。');
    if (prepared.isEmpty || connection == null) return;
    await reconnect();
    requireCurrentLibrary();
    if (_preparedReceiverId != connection!.id ||
        _preparedLibraryId != libraryId) {
      prepared = [];
      throw StateError('电脑当前照片库已变更，请重新核对并确认上传目标。');
    }
    final target = connection!,
        library = libraryId!,
        dateMode = mode,
        fixedDate = manualDate,
        libraryPath = libraries.firstWhere(
          (item) => item['id'] == libraryId,
        )['path'],
        libraryName = libraries.firstWhere(
          (item) => item['id'] == libraryId,
        )['name'];
    final api = await openApi(target), batchKey = newId();
    try {
      final batch = await api.request(
        'POST',
        '/v1/batches',
        json: {
          'clientKey': batchKey,
          'libraryId': library,
          'mode': dateMode,
          'manualDate': dateMode == 'manual' ? fixedDate : null,
        },
      );
      for (final original in prepared) {
        final asset = await AssetEntity.fromId(original['assetId']);
        if (asset == null) throw StateError('照片权限或内容发生变化，请重新核对后上传。');
        final identity = await inspectPhoto(asset);
        if (identity['hash'] != original['hash'] ||
            identity['size'] != original['size']) {
          throw StateError('确认期间原图被修改，请重新选择照片。');
        }
        final checked = await api.request(
          'POST',
          '/v1/assets/check',
          json: {
            'libraryId': library,
            'assets': [
              {'hash': identity['hash'], 'size': identity['size']},
            ],
          },
        );
        final result = Map<String, dynamic>.from(
          (checked['results'] as List).single,
        );
        await _observation(asset, identity, result, target.id, library);
        final photo = <String, dynamic>{...original, ...identity, ...result};
        if (onlyUnbacked && backupState(result) != 'pending') continue;
        if (photo['receipt'] != null) continue;
        if (tasks.any(
          (task) =>
              task.assetId == photo['assetId'] &&
              task.hash == photo['hash'] &&
              task.receiverId == target.id &&
              task.libraryId == library &&
              !['complete', 'cancelled', 'skipped'].contains(task.state),
        )) {
          continue;
        }
        final skip = skipHistory && (photo['matches'] as List).isNotEmpty;
        final task = UploadTask({
          'id': newId(),
          'assetId': photo['assetId'],
          'version': photo['version'],
          'filename': photo['filename'],
          'kind': photo['kind'] ?? 'photo',
          'hash': photo['hash'],
          'size': photo['size'],
          'receiverId': target.id,
          'receiverName': target.name,
          'libraryPath': libraryPath,
          'libraryName': libraryName,
          'deviceId': target.deviceId,
          'libraryId': library,
          'batchId': batch['id'],
          'originalBatchId': batch['id'],
          'batchKey': batchKey,
          'mode': dateMode,
          'manualDate': fixedDate,
          'captureDate': photo['captureDate'],
          'creationDate': photo['creationDate'],
          'uploadDate': batch['uploadDate'],
          'archiveDate': dateMode == 'manual'
              ? fixedDate
              : dateMode == 'capture'
              ? photo['captureDate'] ??
                    photo['creationDate'] ??
                    batch['uploadDate']
              : batch['uploadDate'],
          'offset': 0,
          'state': skip ? 'skipped' : 'queued',
          'error': '',
          'createdAt': DateTime.now().toIso8601String(),
          'onlyUnbacked': onlyUnbacked,
        });
        await store.saveTask(task);
        tasks.add(task);
      }
      prepared = [];
      selected.clear();
      changed();
    } finally {
      api.close();
    }
    unawaited(runQueue());
  }

  void foreground(bool value) {
    _foreground = value;
    if (!value && running) pause();
    if (!value) stopChecking();
    if (value &&
        _monthActive &&
        ready &&
        !busy &&
        !running &&
        !loadingPhotos &&
        photos.isNotEmpty) {
      unawaited(action(() => loadPhotos(requestPermission: false)));
    }
  }

  void pause() {
    _pause = true;
    notice = '将在当前分块确认后暂停；未确认数据会在继续时重新核对。';
    changed();
  }

  Future<void> retry(UploadTask task) async {
    if (running) throw StateError('请先暂停当前传输。');
    if (!['failed', 'paused'].contains(task.state)) return;
    if (task.receiverId != connection?.id) {
      await selectReceiver(task.receiverId);
    }
    task.state = 'queued';
    task.data['error'] = '';
    await store.saveTask(task);
    changed();
    unawaited(runQueue());
  }

  Future<void> cancel(UploadTask task) async {
    if (running) throw StateError('请先暂停再取消任务。');
    if (task.data['sessionId'] != null) {
      final target = connections.firstWhere(
        (item) => item.id == task.receiverId,
      );
      final api = await openApi(target);
      try {
        final result = await api.request(
          'POST',
          '/v1/uploads/${task.data['sessionId']}/cancel',
          json: {},
        );
        if (result['state'] == 'complete') {
          throw StateError('电脑已经完成保存，请继续任务以取回回执。');
        }
      } finally {
        api.close();
      }
    }
    task.state = 'cancelled';
    await store.saveTask(task);
    changed();
  }

  Future<void> continueQueue() async {
    if (running) return;
    for (final task in tasks.where(
      (task) => task.receiverId == connection?.id && task.state == 'paused',
    )) {
      task.state = 'queued';
      task.data['error'] = '';
      await store.saveTask(task);
    }
    unawaited(runQueue());
  }

  /// 只重试指定批次的失败项，成功和取消记录保持原样。
  Future<void> retryFailedBatch(String batchId) async {
    if (running) throw StateError('请先暂停传输队列。');
    final failures = tasks
        .where((task) => task.batchGroupId == batchId && task.state == 'failed')
        .toList();
    if (failures.isEmpty) return;
    if (failures.first.receiverId != connection?.id) {
      await selectReceiver(failures.first.receiverId);
    }
    for (final task in failures) {
      task.state = 'queued';
      task.data['error'] = '';
      await store.saveTask(task);
    }
    changed();
    unawaited(runQueue());
  }

  /// 继续批次内暂停项，不把失败或已保存媒体重新排队。
  Future<void> continueBatch(String batchId) async {
    if (running) throw StateError('请先暂停传输队列。');
    final pending = tasks
        .where(
          (task) =>
              task.batchGroupId == batchId &&
              ['paused', 'queued'].contains(task.state),
        )
        .toList();
    if (pending.isEmpty) return;
    if (pending.first.receiverId != connection?.id) {
      await selectReceiver(pending.first.receiverId);
    }
    for (final task in pending) {
      task.state = 'queued';
      task.data['error'] = '';
      await store.saveTask(task);
    }
    changed();
    unawaited(runQueue());
  }

  Future<void> runQueue() async {
    if (running || connection == null || !_foreground || _disposed) return;
    stopChecking();
    running = true;
    _pause = false;
    changed();
    try {
      await WakelockPlus.enable();
      for (final task
          in tasks
              .where(
                (item) =>
                    item.receiverId == connection!.id && item.state == 'queued',
              )
              .toList()) {
        if (_pause || !_foreground) break;
        try {
          await _transfer(task);
        } catch (error) {
          task.state = 'failed';
          task.data['error'] = explain(error);
          await store.saveTask(task);
          notice = task.error;
          changed();
          if (error is SocketException ||
              error is TimeoutException ||
              error is HandshakeException ||
              (error is PlatformException && error.code == 'LAN_ONLY') ||
              (error is ApiException && [401, 503].contains(error.status))) {
            online = false;
            break;
          }
        }
      }
    } catch (error) {
      notice = explain(error);
    } finally {
      _activeApi?.close();
      _activeApi = null;
      for (final task in tasks.where(
        (item) =>
            item.receiverId == connection?.id &&
            ['queued', 'uploading', 'checking'].contains(item.state),
      )) {
        task.state = 'paused';
        await store.saveTask(task);
      }
      running = false;
      await WakelockPlus.disable();
      changed();
      unawaited(checkPhotos());
    }
  }

  Future<void> _transfer(UploadTask task) async {
    final target = connections.firstWhere((item) => item.id == task.receiverId);
    final asset = await AssetEntity.fromId(task.assetId);
    if (asset == null) throw StateError('照片不可访问，请检查相册权限。');
    task.state = 'checking';
    await store.saveTask(task);
    changed();
    final identity = await inspectPhoto(asset);
    if (identity['hash'] != task.hash || identity['size'] != task.size) {
      throw StateError('原图已修改，请取消此任务并重新选择照片。');
    }
    final file = File(identity['path']), api = await openApi(target);
    _activeApi = api;
    try {
      // 排队期间另一台手机可能完成备份，发送原图前再核对一次。
      if (task.data['onlyUnbacked'] == true) {
        final response = await api.request(
          'POST',
          '/v1/assets/check',
          json: {
            'libraryId': task.libraryId,
            'assets': [
              {'hash': task.hash, 'size': task.size},
            ],
          },
        );
        final result = Map<String, dynamic>.from(
          (response['results'] as List).single,
        );
        await _observation(
          asset,
          identity,
          result,
          task.receiverId,
          task.libraryId,
        );
        final state = backupState(result);
        if (state == 'unknown') throw StateError('电脑核对范围尚未完整，先在电脑完成扫描后重试。');
        if (state != 'pending') {
          task.state = 'skipped';
          task.data['error'] = '';
          await store.saveTask(task);
          changed();
          return;
        }
      }
      if (task.data['deviceId'] != target.deviceId) {
        final batch = await api.request(
          'POST',
          '/v1/batches',
          json: {
            // 同原批次同日期复用恢复批次；不同归档日仍各自冻结，不能改旧路径。
            'clientKey': sha256
                .convert(
                  utf8.encode(
                    'resume:${task.batchGroupId}:${target.deviceId}:${task.data['archiveDate']}',
                  ),
                )
                .toString(),
            'libraryId': task.libraryId,
            'mode': 'manual',
            'manualDate': task.data['archiveDate'],
          },
        );
        task.data['originalBatchId'] ??= task.data['batchId'];
        task.data['batchId'] = batch['id'];
        task.data['deviceId'] = target.deviceId;
        task.data['sessionId'] = null;
        await store.saveTask(task);
      }
      Json session;
      if (task.data['sessionId'] != null) {
        session = await api.request(
          'GET',
          '/v1/uploads/${task.data['sessionId']}',
        );
      } else {
        session = await api.request(
          'POST',
          '/v1/uploads',
          json: {
            'clientKey': task.id,
            'batchId': task.data['batchId'],
            'hash': task.hash,
            'size': task.size,
            'filename': task.filename,
            'kind': task.data['kind'] ?? 'photo',
            'captureDate': task.data['captureDate'],
            'creationDate': task.data['creationDate'],
          },
        );
      }
      task.data['sessionId'] = session['id'];
      task.data['offset'] = session['offset'];
      task.data['archiveDate'] = session['archiveDate'];
      await store.saveTask(task);
      final handle = await file.open();
      try {
        while (session['state'] != 'complete' && task.offset < task.size) {
          if (_pause || !_foreground) {
            task.state = 'paused';
            await store.saveTask(task);
            return;
          }
          await handle.setPosition(task.offset);
          final bytes = await handle.read(
            (task.size - task.offset).clamp(1, 4 * 1024 * 1024),
          );
          if (bytes.isEmpty) throw StateError('原图读取中断，请重新核对。');
          task.state = 'uploading';
          changed();
          session = await api.request(
            'PUT',
            '/v1/uploads/${session['id']}/content?offset=${task.offset}',
            bytes: Uint8List.fromList(bytes),
          );
          task.data['offset'] = session['offset'];
          await store.saveTask(task);
          changed();
        }
      } finally {
        await handle.close();
      }
      if (session['state'] != 'complete') {
        task.state = 'checking';
        changed();
        session = await api.request(
          'POST',
          '/v1/uploads/${session['id']}/complete',
          json: {},
        );
      }
      final receipt = Map<String, dynamic>.from(session['receipt'] as Map);
      if (session['state'] != 'complete' ||
          receipt['receiverId'] != task.receiverId ||
          receipt['libraryId'] != task.libraryId ||
          receipt['hash'] != task.hash ||
          receipt['size'] != task.size) {
        throw StateError('回执与本次任务不匹配，未标记上传成功。');
      }
      task.state = 'complete';
      task.data['receipt'] = receipt;
      task.data['error'] = '';
      await store.saveTask(task);
      await _observation(
        asset,
        identity,
        {'receipt': receipt, 'matches': []},
        task.receiverId,
        task.libraryId,
      );
      online = true;
      changed();
    } finally {
      api.close();
      _activeApi = null;
    }
  }

  @override
  void dispose() {
    _disposed = true;
    _catalogEpoch++;
    stopChecking();
    _pause = true;
    _activeApi?.close();
    super.dispose();
  }
}
