import 'dart:async';
import 'dart:io';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';
import 'package:path_provider/path_provider.dart';
import 'package:photo_manager/photo_manager.dart';
import 'family_models.dart';
import 'backup_catalog.dart';
import 'local_store.dart';
import 'models.dart';
import 'transfer_controller.dart';
import 'system_gallery.dart';
import 'media_favorites.dart';

/// 管理手机相册索引、宝宝归类与记录同步，不写入上传回执。
class FamilyController extends ChangeNotifier {
  FamilyController(
    this.transfer, {
    LocalStore? store,
    SystemGalleryGateway? galleryGateway,
    Future<AssetEntity?> Function(String)? mediaResolver,
  }) : store = store ?? LocalStore(),
       galleryGateway = galleryGateway ?? PhotoManagerGalleryGateway(),
       mediaResolver = mediaResolver ?? AssetEntity.fromId {
    favorites = MediaFavorites(this.store);
    favorites.addListener(changed);
    transfer.addListener(_transferChanged);
  }
  final TransferController transfer;
  final LocalStore store;
  final SystemGalleryGateway galleryGateway;
  final Future<AssetEntity?> Function(String) mediaResolver;
  late final MediaFavorites favorites;
  static const channel = MethodChannel('dev.momentnest/family');
  final Map<String, FamilyAsset> assets = {};
  final Map<String, FamilyAsset> _localIndex = {};
  final Map<String, BabyProfile> babies = {};
  final Map<String, Json> decisions = {};
  final Map<String, Json> dates = {};
  final Map<String, bool> _growthWatermarkDisplay = {};
  bool ready = false, scanning = false, limited = false;
  bool initializing = false;
  bool modelReady = false, _opened = false, _disposed = false;
  bool scanPaused = false, matching = false;
  int scanTotal = 0, scanProcessed = 0, scanCached = 0, scanAnalyzed = 0;
  String scanStage = '', matchProgress = '';
  final Map<String, Json> scanFailures = {};
  String notice = '', progress = '', modelError = '';
  int _epoch = 0;
  Directory? _directory;
  String? activeBaby;
  Future<void>? _initialization;
  Timer? _scanNotification;
  Future<void>? _scanTask, _scanSave;
  bool _foreground = true, _resumeScan = false;
  String _scanMode = 'scan';
  final List<String> _retryPending = [];

  void changed() {
    _scanNotification?.cancel();
    _scanNotification = null;
    if (!_disposed) notifyListeners();
  }

  /// 合并连续扫描进度，避免每张照片都重建并排序整个宝宝列表。
  void _scanChanged() {
    if (_disposed || _scanNotification != null) return;
    _scanNotification = Timer(const Duration(milliseconds: 200), changed);
  }

  /// 宝宝相册仅使用手机媒体，旧电脑记录保留在存储中但不参与展示与识别。
  bool isLocalAsset(FamilyAsset asset) =>
      asset.localId != null && asset.data['_authorized'] != false;

  Iterable<FamilyAsset> get localAssets => assets.values.where(isLocalAsset);

  /// 合并重复读取，失败后允许重试，成功后复用已恢复的本机记录。
  Future<void> initialize() {
    if (ready) return Future.value();
    return _initialization ??= _initialize().whenComplete(() {
      _initialization = null;
    });
  }

  Future<void> _initialize() async {
    initializing = true;
    notice = '';
    var stage = '本地存储';
    changed();
    try {
      await store.open();
      _opened = true;
      stage = '应用目录';
      final directory = Directory(
        '${(await getApplicationDocumentsDirectory()).path}/family',
      );
      await directory.create(recursive: true);
      final restoredBabies = <String, BabyProfile>{};
      final restoredAssets = <String, FamilyAsset>{};
      final restoredLocalIndex = <String, FamilyAsset>{};
      final restoredDecisions = <String, Json>{};
      final restoredDates = <String, Json>{};
      final restoredFailures = <String, Json>{};
      final restoredDisplay = <String, bool>{};
      stage = '宝宝档案';
      for (final data
          in (await store.preference('family-babies') as List? ?? [])) {
        final baby = BabyProfile(Map<String, dynamic>.from(data as Map));
        restoredBabies[baby.id] = baby;
        final display = await store.preference(
          'family-growth-watermark:${baby.id}',
        );
        if (display is bool) restoredDisplay[baby.id] = display;
      }
      stage = '照片记录';
      for (final data
          in (await store.preference('family-assets') as List? ?? [])) {
        final item = FamilyAsset(Map<String, dynamic>.from(data as Map));
        restoredAssets[item.id] = item;
        if (item.localId != null) restoredLocalIndex[item.localId!] = item;
        if (restoredAssets.length % 200 == 0) {
          await Future<void>.delayed(Duration.zero);
        }
      }
      stage = '相册归属';
      for (final data
          in (await store.preference('family-decisions') as List? ?? [])) {
        final item = Map<String, dynamic>.from(data as Map);
        restoredDecisions['${item['babyId']}:${item['assetId']}'] = item;
      }
      stage = '日期记录';
      for (final value
          in (await store.preference('family-dates') as List? ?? [])) {
        final data = Map<String, dynamic>.from(value as Map);
        restoredDates[data['assetId'] as String] = data;
      }
      stage = '整理记录';
      for (final value
          in (await store.preference('family-scan-failures') as List? ?? [])) {
        final failure = Map<String, dynamic>.from(value as Map);
        restoredFailures[failure['localId'] as String] = failure;
      }
      final checkpoint = await store.preference('family-scan-progress');
      // 所有记录读取成功后统一展示，读取失败不暴露可编辑的半份相册。
      _directory = directory;
      babies.addAll(restoredBabies);
      assets.addAll(restoredAssets);
      _localIndex.addAll(restoredLocalIndex);
      decisions.addAll(restoredDecisions);
      dates.addAll(restoredDates);
      scanFailures.addAll(restoredFailures);
      _growthWatermarkDisplay.addAll(restoredDisplay);
      if (checkpoint is Map) {
        int count(String key) => checkpoint[key] is int
            ? (checkpoint[key] as int).clamp(0, 1 << 31)
            : 0;
        scanTotal = count('total');
        scanProcessed = count('processed').clamp(0, scanTotal);
        scanCached = count('cached');
        scanAnalyzed = count('analyzed');
        scanPaused = checkpoint['unfinished'] == true;
        _scanMode = checkpoint['mode'] == 'retry' ? 'retry' : 'scan';
        if (checkpoint['retryPending'] is List) {
          _retryPending.addAll(
            (checkpoint['retryPending'] as List).whereType<String>(),
          );
        }
        if (scanPaused) {
          scanStage = '已恢复整理进度';
          progress = '整理已授权媒体 $scanProcessed / $scanTotal';
        }
      } else {
        final indexed = localAssets.toList();
        scanTotal = indexed.length;
        scanCached = indexed
            .where(
              (item) =>
                  item.data['faceState'] == 'done' &&
                  item.data['_faceModel'] == 'sface-mobile-v1',
            )
            .length;
        scanProcessed =
            scanCached +
            indexed.where((item) => item.data['faceState'] == 'error').length;
      }
      await favorites.initialize(openStore: false);
      await favorites.importLegacy({
        for (final asset in restoredAssets.values)
          if (isLocalAsset(asset) &&
              asset.data['favorite'] == true &&
              asset.data['_version'] is String)
            asset.localId!: asset.data['_version'] as String,
      });
      activeBaby = babies.keys.firstOrNull;
      ready = true;
      changed();
      try {
        final status = await channel.invokeMapMethod<String, dynamic>('ready');
        modelReady = status?['ready'] == true;
      } catch (error) {
        modelError = transfer.explain(error);
      }
      changed();
      // 启动只恢复宝宝记录，人脸整理由宝宝入口按需启动。
    } catch (error) {
      notice = '宝宝相册读取失败（$stage）：${transfer.explain(error)}';
    } finally {
      initializing = false;
      changed();
    }
  }

  static const permissionOption = PermissionRequestOption(
    androidPermission: AndroidPermission(
      type: RequestType.common,
      mediaLocation: true,
    ),
  );

  Future<void> persist() async {
    if (!_opened) return;
    await store.setPreference(
      'family-babies',
      babies.values.map((value) => value.data).toList(),
    );
    await store.setPreference('family-decisions', decisions.values.toList());
    await store.setPreference('family-dates', dates.values.toList());
    await store.setPreference(
      'family-scan-failures',
      scanFailures.values.toList(),
    );
    await store.setPreference(
      'family-assets',
      assets.values.map((value) => value.data).toList(),
    );
    // 先保存分析结果，再保存进度，避免恢复到尚未落盘的完成计数。
    await store.setPreference('family-scan-progress', {
      'total': scanTotal,
      'processed': scanProcessed,
      'cached': scanCached,
      'analyzed': scanAnalyzed,
      'unfinished': scanning || scanPaused,
      'mode': _scanMode,
      'retryPending': List.of(_retryPending),
    });
  }

  Future<void> action(Future<void> Function() work) async {
    notice = '';
    changed();
    try {
      await work();
    } catch (error) {
      notice = transfer.explain(error);
    }
    changed();
  }

  /// 每个宝宝记住本机显示开关，默认开启，不随家庭档案同步。
  bool growthWatermarkVisible(String babyId) =>
      _growthWatermarkDisplay[babyId] != false;

  Future<void> setGrowthWatermarkDisplay(String babyId, bool enabled) async {
    if (!babies.containsKey(babyId)) throw StateError('请先选择宝宝档案。');
    await store.setPreference('family-growth-watermark:$babyId', enabled);
    _growthWatermarkDisplay[babyId] = enabled;
    changed();
  }

  /// 相册预览与自动扫描共用内容身份，避免建立两份宝宝媒体记录。
  Future<FamilyAsset> registerMedia(
    AssetEntity media, {
    bool persistRecord = true,
  }) async {
    final previous = _localIndex[media.id];
    if (previous != null && await _unchangedMedia(previous, media)) {
      return previous;
    }
    final identity = await transfer.inspectPhoto(media, useCache: true);
    final id = contentAssetId(
      identity['hash'] as String,
      identity['size'] as int,
    );
    if (previous != null && previous.id != id) {
      // 系统媒体 ID 可能被编辑后的内容复用，旧指纹只保留历史记录。
      previous.data['_authorized'] = false;
      previous.data['_changedLocalVersion'] = true;
      previous.data.remove('_localId');
      previous.data.remove('_path');
      previous.data.remove('_version');
      for (final location in previous.data['locations'] as List? ?? []) {
        if ((location as Map)['id'] == 'phone:${media.id}') {
          location['available'] = false;
        }
      }
      previous.data['available'] = false;
    }
    final old = assets[id];
    final capture = identity['captureDate'] as String?;
    final creation = (media.createDateSecond ?? 0) > 0
        ? dateLabel(media.createDateTime)
        : null;
    final item = FamilyAsset({
      ...?old?.data,
      'id': id,
      'hash': identity['hash'],
      'size': identity['size'],
      'filename': identity['filename'],
      'kind': identity['kind'],
      'date': old?.data['dateSource'] == 'manual'
          ? old!.date
          : capture ?? creation,
      'dateSource': old?.data['dateSource'] == 'manual'
          ? 'manual'
          : capture != null
          ? 'capture'
          : creation != null
          ? 'creation'
          : 'unknown',
      'dateConfirmed': old?.data['dateSource'] == 'manual' || capture != null,
      'captureDate': capture,
      'creationDate': creation,
      'width': media.width,
      'height': media.height,
      'duration': media.duration,
      'available': true,
      'babyIds': [],
      'personIds': [],
      'favorite': old?.data['favorite'] ?? false,
      'faces': old?.data['faces'] ?? [],
      'faceState': old?.data['faceState'] ?? 'pending',
      'locations': [
        {
          'id': 'phone:${media.id}',
          'source': 'phone',
          'label': '这部手机',
          'path': '',
          'available': true,
        },
      ],
      '_localId': media.id,
      '_version': photoVersion(media),
      '_path': identity['path'],
      '_fileModified': identity['fileModified'],
      '_authorized': true,
    });
    assets[id] = item;
    _applyDate(item);
    _localIndex[media.id] = item;
    // 扫描只建立索引，人脸与浏览共用系统媒体；不可见缩略图延后读取。
    if (!scanning && _directory != null && item.thumbnailPath == null) {
      final bytes = await media.thumbnailDataWithSize(
        const ThumbnailSize(360, 360),
      );
      if (bytes != null) {
        final file = File('${_directory!.path}/$id-thumb.jpg');
        await file.writeAsBytes(bytes, flush: true);
        item.data['_thumb'] = file.path;
      }
    }
    if (persistRecord) await persist();
    return item;
  }

  /// 缓存仍核对系统版本、原文件路径、大小与修改时间，变化后重新计算指纹。
  Future<bool> _unchangedMedia(FamilyAsset previous, AssetEntity media) async {
    if (previous.data['_version'] != photoVersion(media)) return false;
    final file = await media.originFile;
    if (file == null) return false;
    final stat = await file.stat();
    return stat.type == FileSystemEntityType.file &&
        previous.data['size'] == stat.size &&
        previous.data['_fileModified'] ==
            stat.modified.millisecondsSinceEpoch &&
        previous.localPath == file.path;
  }

  /// 扫描所有已授权照片和视频，未变化的原文件复用指纹和人脸分析。
  Future<void> scan({bool requestPermission = true}) {
    if (scanPaused && _scanMode == 'retry' && _retryPending.isNotEmpty) {
      return retryScanFailures();
    }
    return _startScan(
      (epoch) => _scan(epoch, requestPermission: requestPermission),
    );
  }

  /// 暂停不能中断正在运行的原生推理，下一轮等待当前项保存后再开始。
  Future<void> _startScan(Future<void> Function(int) run) {
    if (_disposed ||
        scanning ||
        !ready ||
        matching ||
        transfer.running ||
        !_foreground) {
      return Future.value();
    }
    final previous = _scanTask, epoch = ++_epoch;
    scanning = true;
    scanPaused = false;
    _resumeScan = false;
    scanStage = '读取系统相册';
    notice = '';
    changed();
    late final Future<void> task;
    task = () async {
      try {
        await previous;
        if (!_disposed && epoch == _epoch) await run(epoch);
      } catch (error) {
        if (!_disposed && epoch == _epoch) {
          notice = transfer.explain(error);
          scanPaused = true;
        }
      } finally {
        if (!_disposed) {
          if (epoch == _epoch) {
            scanning = false;
            scanStage = scanPaused ? '整理中断' : '整理完成';
            progress = scanPaused ? '整理已授权媒体 $scanProcessed / $scanTotal' : '';
          }
          try {
            await persist();
          } catch (error) {
            if (epoch == _epoch) {
              scanPaused = true;
              notice = '整理进度保存失败：${transfer.explain(error)}';
            }
          }
          changed();
        }
      }
    }();
    _scanTask = task;
    return task.whenComplete(() {
      if (identical(_scanTask, task)) _scanTask = null;
    });
  }

  /// 先核对当前授权范围与已完成缓存，再处理剩余媒体，不把恢复计数清零。
  Future<void> _scan(int epoch, {required bool requestPermission}) async {
    _scanMode = 'scan';
    _retryPending.clear();
    final seen = <String>{};
    final pending = <AssetEntity>[];
    final cached = <(AssetEntity, FamilyAsset)>[];
    final previous = {
      for (final item in assets.values)
        if (item.localId != null) item.localId!: item,
    };
    final permission = await galleryGateway.permission(
      request: requestPermission,
    );
    if (_disposed || epoch != _epoch) return;
    if (!permission.hasAccess) throw StateError('请授权照片和视频后，再整理宝宝相册。');
    limited = !permission.isAuth;
    final album = await galleryGateway.open(type: RequestType.common);
    if (_disposed || epoch != _epoch) return;
    final total = await album?.count() ?? 0;
    if (_disposed || epoch != _epoch) return;
    scanTotal = total;
    scanProcessed = scanProcessed.clamp(0, total);
    scanStage = '核对授权媒体与已完成缓存';
    changed();
    for (var page = 0; page * 100 < total; page++) {
      if (_disposed || epoch != _epoch) return;
      final batch = await album!.page(number: page, size: 100);
      if (_disposed || epoch != _epoch) return;
      if (batch.isEmpty) throw StateError('系统相册在整理中发生变化，已保留完成项，请继续整理。');
      for (final media in batch) {
        if (!seen.add(media.id)) continue;
        final item = previous[media.id];
        if (item != null &&
            item.data['_version'] == photoVersion(media) &&
            (item.data['faceState'] == 'error' ||
                !modelReady ||
                (item.data['faceState'] == 'done' &&
                    item.data['_faceModel'] == 'sface-mobile-v1'))) {
          cached.add((media, item));
        } else {
          pending.add(media);
        }
      }
    }
    if (seen.length != total) {
      throw StateError('系统相册在整理中发生变化，已保留完成项，请继续整理。');
    }
    var completed = 0, reused = 0;
    for (final (media, item) in cached) {
      if (_disposed || epoch != _epoch) return;
      var unchanged = false;
      try {
        unchanged = await _unchangedMedia(item, media);
      } catch (_) {
        // 读取异常交给剩余任务保存明确失败原因，不把缓存当成已核实。
      }
      if (_disposed || epoch != _epoch) return;
      if (!unchanged) {
        pending.add(media);
        continue;
      }
      item.data['_authorized'] = true;
      if (item.data['faceState'] == 'error') {
        scanFailures[media.id] = {
          'localId': media.id,
          'filename': media.title ?? item.filename,
          'reason': item.data['faceError'] as String? ?? '人脸分析失败，请仅重试失败项。',
        };
      } else {
        classify(item);
        scanFailures.remove(media.id);
        if (item.data['faceState'] == 'done') reused++;
      }
      completed++;
    }
    scanProcessed = completed;
    scanCached = reused;
    scanAnalyzed = 0;
    progress = '整理已授权媒体 $scanProcessed / $total';
    changed();
    var handled = 0;
    for (final media in pending) {
      if (_disposed || epoch != _epoch) return;
      scanStage = '读取文件与指纹';
      _scanChanged();
      try {
        final item = await registerMedia(media, persistRecord: false);
        item.data['_authorized'] = true;
        if (modelReady &&
            (item.data['faceState'] == 'pending' ||
                item.data['_faceModel'] != 'sface-mobile-v1')) {
          if (item.data['faceState'] == 'error') {
            throw StateError(
              item.data['faceError'] as String? ?? '人脸分析失败，请仅重试失败项。',
            );
          }
          scanStage = item.kind == 'video' ? '分析视频 4 个采样帧' : '分析照片人脸';
          _scanChanged();
          await analyze(item);
          scanAnalyzed++;
        } else if (item.data['faceState'] == 'done') {
          scanCached++;
        } else if (item.data['faceState'] == 'error') {
          throw StateError(
            item.data['faceError'] as String? ?? '人脸分析失败，请仅重试失败项。',
          );
        }
        classify(item);
        scanFailures.remove(media.id);
      } catch (error) {
        scanFailures[media.id] = {
          'localId': media.id,
          'filename': media.title ?? '媒体 ${media.id}',
          'reason': transfer.explain(error),
        };
      }
      scanProcessed++;
      progress = '整理已授权媒体 $scanProcessed / $total';
      _scanChanged();
      if (++handled % 100 == 0 && !_disposed) await persist();
    }
    if (_disposed || epoch != _epoch) return;
    for (final item in assets.values) {
      if (item.localId != null && !seen.contains(item.localId)) {
        item.data['_authorized'] = false;
      }
    }
    final errors = scanFailures.keys.where(seen.contains).length;
    notice = total == 0
        ? '当前授权范围没有照片和视频。'
        : '${limited ? '已整理当前授权范围。' : '已整理手机照片和视频。'}读取 $scanProcessed 个文件，复用 $scanCached 项，新增分析 $scanAnalyzed 项；${errors > 0 ? '$errors 项失败，可查看原因并仅重试失败。' : '没有失败项。'}';
  }

  /// 用户暂停保持完成计数，当前项结束后保存结果，继续时不会并行启动第二轮。
  void pauseScan() {
    _pauseScan(resume: false, message: '已暂停整理，进度已保留，继续时仅处理剩余媒体。');
  }

  void _pauseScan({required bool resume, required String message}) {
    _epoch++;
    scanning = false;
    scanPaused = true;
    _resumeScan = resume;
    scanStage = '整理已暂停';
    progress = '整理已授权媒体 $scanProcessed / $scanTotal';
    notice = message;
    changed();
    final epoch = _epoch;
    final previous = _scanSave;
    late final Future<void> save;
    save = (previous ?? Future<void>.value()).then((_) => persist()).catchError(
      (Object error) {
        if (!_disposed && epoch == _epoch) {
          notice = '整理进度保存失败：${transfer.explain(error)}';
          changed();
        }
      },
    );
    _scanSave = save;
    unawaited(
      save.whenComplete(() {
        if (identical(_scanSave, save)) _scanSave = null;
      }),
    );
  }

  /// 应用回到前台后续接此前运行的任务，手工暂停不自动恢复。
  void foreground(bool value) {
    _foreground = value;
    if (!value && scanning) {
      _pauseScan(resume: true, message: '应用进入后台，整理进度已保留，回到前台后继续。');
    } else if (value) {
      _resumePendingScan();
    }
  }

  void _transferChanged() {
    if (transfer.running && scanning) {
      _pauseScan(resume: true, message: '正在传输，宝宝整理暂缓；传输结束后继续。');
    } else {
      _resumePendingScan();
    }
  }

  void _resumePendingScan() {
    if (_resumeScan && _foreground && !transfer.running && !_disposed) {
      unawaited(scan(requestPermission: false));
    }
  }

  /// 参考选图等待当前整理项结束，避免同时处理同一份人脸缓存。
  Future<void> waitForScan() => _scanTask ?? Future.value();

  /// 人脸模型在本机运行，视频只分析均匀抽出的四帧。
  Future<void> analyze(FamilyAsset asset) async {
    try {
      final file = await fileFor(asset);
      if (file == null) throw StateError('本机原文件暂不可读，请检查相册权限或重新选择照片。');
      final result = await channel.invokeMapMethod<String, dynamic>('analyze', {
        'path': file.path,
        'kind': asset.kind,
        'frames': 4,
      });
      asset.data['faces'] = (result?['faces'] as List? ?? [])
          .map((value) => Map<String, dynamic>.from(value as Map))
          .toList();
      asset.data['faceState'] = 'done';
      asset.data['_faceModel'] = 'sface-mobile-v1';
      asset.data.remove('faceError');
    } catch (error) {
      asset.data['faceState'] = 'error';
      asset.data['faceError'] = transfer.explain(error);
      rethrow;
    }
    classify(asset);
    if (scanning) {
      _scanChanged();
    } else {
      changed();
    }
  }

  List<double> _embedding(Json face) {
    final values = face['embedding'];
    if (values is! List || values.any((value) => value is! num)) return [];
    return values.map((value) => (value as num).toDouble()).toList();
  }

  /// 选脸、保存和参考计数共用有效特征规则，拒绝空值、零向量和非有限数。
  bool canReferenceFace(Json face) {
    final embedding = _embedding(face);
    return embedding.length == 128 &&
        embedding.every((value) => value.isFinite) &&
        embedding.any((value) => value != 0);
  }

  /// 手工加入和排除有最高优先级，识别只能更新自身产生的归类记录。
  void classify(FamilyAsset asset) {
    if (!isLocalAsset(asset)) return;
    for (final baby in babies.values) {
      final key = '${baby.id}:${asset.id}';
      if (decisions[key]?['origin'] == 'manual') continue;
      if (!baby.autoMatch) {
        final previous = decisions[key];
        if (previous?['origin'] == 'recognition' &&
            previous?['state'] == 'included') {
          decisions[key] = {
            ...previous!,
            'state': 'candidate',
            'updatedAt': DateTime.now().toUtc().toIso8601String(),
          };
        }
        continue;
      }
      final references = <List<double>>[];
      for (final reference in baby.references) {
        final original = assets[reference['assetId']];
        final face = original?.faces
            .where((face) => face['id'] == reference['faceId'])
            .firstOrNull;
        if (original != null &&
            isLocalAsset(original) &&
            face != null &&
            canReferenceFace(face)) {
          references.add(_embedding(face));
        }
      }
      if (references.isEmpty) continue;
      var score = -1.0;
      for (final face in asset.faces) {
        for (final reference in references) {
          final similarity = cosineSimilarity(_embedding(face), reference);
          if (similarity > score) score = similarity;
        }
      }
      final state = recognitionState(score);
      if (state == null) {
        decisions.remove(key);
        continue;
      }
      if (decisions[key]?['state'] == state &&
          (decisions[key]?['score'] as num?)?.toDouble() == score) {
        continue;
      }
      decisions[key] = {
        'id': '${baby.id}-${asset.id}',
        'babyId': baby.id,
        'assetId': asset.id,
        'state': state,
        'origin': 'recognition',
        'score': score,
        'updatedAt': DateTime.now().toUtc().toIso8601String(),
      };
    }
  }

  /// 保存出生档案并重新评估本机已有的人物特征。
  Future<void> saveBaby({
    String? id,
    required String name,
    required String birthday,
    required bool autoMatch,
  }) async {
    final parsed = DateTime.tryParse(birthday);
    if (name.trim().isEmpty ||
        name.trim().length > 40 ||
        parsed == null ||
        dateLabel(parsed) != birthday) {
      throw StateError('请填写宝宝姓名和有效出生日期。');
    }
    final previous = babies[id];
    final baby = BabyProfile({
      'id': id ?? newId(),
      'name': name.trim(),
      'birthday': birthday,
      'autoMatch': autoMatch,
      'referenceFaces': previous?.references ?? [],
      if (previous?.avatarPath != null) '_avatarPath': previous!.avatarPath,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    });
    babies[baby.id] = baby;
    activeBaby = baby.id;
    if (previous == null || previous.autoMatch != autoMatch) {
      await rematchCached();
    }
    await persist();
    changed();
  }

  /// 用户选定参考人脸后再匹配其余媒体，不默认将第一张脸当成宝宝。
  Future<void> reference(BabyProfile baby, FamilyAsset asset, Json face) async {
    if (!isLocalAsset(asset)) throw StateError('请从手机相册重新选择宝宝照片。');
    if (matching) throw StateError('正在更新匹配，请稍后保存参考。');
    if (!asset.faces.any((value) => value['id'] == face['id'])) {
      throw StateError('该人脸已更新，请重新选择。');
    }
    if (!canReferenceFace(face)) {
      throw StateError('该人脸没有本机特征，请先在手机重新分析原文件。');
    }
    final references = baby.references
        .where(
          (value) =>
              value['assetId'] != asset.id || value['faceId'] != face['id'],
        )
        .toList();
    if (references.length >= 20) {
      throw StateError('最多保留 20 张参考人脸，请先调整参考范围。');
    }
    references.add({'assetId': asset.id, 'faceId': face['id']});
    baby.data['referenceFaces'] = references;
    baby.data['updatedAt'] = DateTime.now().toUtc().toIso8601String();
    await decide(baby.id, asset.id, 'included');
    await rematchCached();
    await persist();
    changed();
  }

  /// 重新选参考时只清除本机识别结果，保留用户的手工加入与排除。
  Future<void> clearReferences(BabyProfile baby) async {
    baby.data['referenceFaces'] = <Json>[];
    baby.data['updatedAt'] = DateTime.now().toUtc().toIso8601String();
    decisions.removeWhere(
      (_, value) =>
          value['babyId'] == baby.id && value['origin'] == 'recognition',
    );
    await persist();
    changed();
  }

  /// 单独移除参考关联并重算缓存，不移除媒体或手工归属。
  Future<void> removeReference(BabyProfile baby, Json reference) async {
    if (matching) throw StateError('正在更新匹配，请稍后调整参考。');
    baby.data['referenceFaces'] = baby.references
        .where(
          (value) =>
              value['assetId'] != reference['assetId'] ||
              value['faceId'] != reference['faceId'],
        )
        .toList();
    baby.data['updatedAt'] = DateTime.now().toUtc().toIso8601String();
    decisions.removeWhere(
      (_, value) =>
          value['babyId'] == baby.id && value['origin'] == 'recognition',
    );
    await rematchCached();
    await persist();
    changed();
  }

  /// 手工修正记录独立于识别置信度，并可同步到电脑。
  Future<void> decide(String baby, String asset, String state) async {
    if (!['included', 'excluded', 'candidate'].contains(state)) {
      throw StateError('宝宝归类状态无效。');
    }
    final key = '$baby:$asset';
    decisions[key] = {
      'id': '$baby-$asset',
      'babyId': baby,
      'assetId': asset,
      'state': state,
      'origin': 'manual',
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    await persist();
    changed();
  }

  String? decision(String baby, String asset) =>
      decisions['$baby:$asset']?['state'] as String?;

  bool isReference(String baby, String asset) =>
      babies[baby]?.references.any((value) => value['assetId'] == asset) ==
      true;

  /// 参考只根据有效缓存特征计数，失去原文件不会凭空产生新特征。
  int validReferenceCount(BabyProfile baby) =>
      baby.references.where((reference) {
        final original = assets[reference['assetId']];
        if (original == null || !isLocalAsset(original)) return false;
        final face = original.faces
            .where((face) => face['id'] == reference['faceId'])
            .firstOrNull;
        return face != null && canReferenceFace(face);
      }).length;

  /// 保存头像只使用系统选图返回的本机副本，不参与识别及跨端同步。
  Future<void> chooseAvatar(BabyProfile baby) async {
    final path = await channel.invokeMethod<String>('chooseAvatar');
    if (path == null || _disposed || babies[baby.id] == null) return;
    babies[baby.id]!.data['_avatarPath'] = path;
    await persist();
    changed();
  }

  /// 缓存匹配分段让出界面线程，归属确认与参考选择保持独立。
  Future<void> rematchCached() async {
    if (matching) throw StateError('正在更新匹配，请稍后再试。');
    matching = true;
    final before = decisions.entries
        .where(
          (entry) =>
              entry.value['state'] == 'included' ||
              entry.value['state'] == 'candidate',
        )
        .map((entry) => entry.key)
        .toSet();
    final cached = localAssets.toList();
    try {
      for (var index = 0; index < cached.length; index++) {
        if (_disposed) return;
        classify(cached[index]);
        if (index % 40 == 0) {
          matchProgress = '更新缓存匹配 ${index + 1} / ${cached.length}';
          changed();
          await Future<void>.delayed(Duration.zero);
        }
      }
      final added = decisions.entries
          .where(
            (entry) =>
                !before.contains(entry.key) &&
                (entry.value['state'] == 'included' ||
                    entry.value['state'] == 'candidate'),
          )
          .length;
      notice = '已复用 ${cached.length} 项缓存更新匹配，新增 $added 项宝宝相关结果。';
    } finally {
      matching = false;
      matchProgress = '';
      changed();
    }
  }

  /// 只重新读取失败媒体；其余已完成缓存不重复分析。
  Future<void> retryScanFailures() {
    final resume = scanPaused && _scanMode == 'retry';
    return _startScan((epoch) async {
      if (!resume) {
        _scanMode = 'retry';
        _retryPending
          ..clear()
          ..addAll(scanFailures.keys);
        scanTotal = _retryPending.length;
        scanProcessed = 0;
        scanCached = 0;
        scanAnalyzed = 0;
      }
      for (final id in List.of(_retryPending)) {
        if (_disposed || epoch != _epoch) return;
        final previous = scanFailures[id];
        if (previous == null) {
          _retryPending.remove(id);
          continue;
        }
        progress = '重试失败 $scanProcessed / $scanTotal';
        scanStage = '仅重试失败媒体';
        changed();
        try {
          final media = await mediaResolver(id);
          if (media == null) throw StateError('此媒体不在当前授权范围，请调整系统相册授权。');
          final asset = await registerMedia(media, persistRecord: false);
          if (asset.data['faceState'] == 'error' && !modelReady) {
            throw StateError('本机人脸模型暂不可用，请检查模型后再重试。');
          }
          if (modelReady && asset.data['faceState'] != 'done') {
            await analyze(asset);
            scanAnalyzed++;
          } else if (asset.data['faceState'] == 'done') {
            scanCached++;
          }
          classify(asset);
          scanFailures.remove(id);
        } catch (error) {
          scanFailures[id] = {...previous, 'reason': transfer.explain(error)};
        }
        _retryPending.remove(id);
        scanProcessed++;
        await persist();
      }
      if (epoch == _epoch) {
        notice = '失败项重试结束，仍有 ${scanFailures.length} 项，可查看具体原因。';
      }
    });
  }

  void _applyDate(FamilyAsset asset) {
    final correction = dates[asset.id];
    if (correction == null) return;
    asset.data['date'] = correction['date'];
    asset.data['dateSource'] = 'manual';
    asset.data['dateConfirmed'] = true;
  }

  /// 人工拍摄日用于相册和月龄，不更改已建立传输批次的归档路径。
  Future<void> setDate(FamilyAsset asset, String date) async {
    final parsed = DateTime.tryParse(date);
    if (parsed == null || dateLabel(parsed) != date) {
      throw StateError('拍摄日期无效。');
    }
    dates[asset.id] = {
      'assetId': asset.id,
      'date': date,
      'updatedAt': DateTime.now().toUtc().toIso8601String(),
    };
    _applyDate(asset);
    await persist();
    changed();
  }

  List<FamilyAsset> collection(
    String baby, {
    bool candidates = false,
    bool includeCandidates = false,
  }) =>
      localAssets
          .where(
            (asset) =>
                decision(baby, asset.id) ==
                    (candidates ? 'candidate' : 'included') ||
                (includeCandidates && decision(baby, asset.id) == 'candidate'),
          )
          .toList()
        ..sort((left, right) => (right.date ?? '').compareTo(left.date ?? ''));

  /// 已加入、疑似与人工排除互不混入待核对，旧自动排除仍可人工检查。
  String? reviewReason(String babyId, FamilyAsset asset) {
    if (!isLocalAsset(asset)) return null;
    final record = decisions['$babyId:${asset.id}'];
    if (record?['state'] == 'included' ||
        record?['state'] == 'candidate' ||
        (record?['state'] == 'excluded' && record?['origin'] == 'manual')) {
      return null;
    }
    if (asset.data['faceState'] == 'error') return '识别失败';
    if (asset.data['faceState'] != 'done') return '尚未分析';
    if (asset.faces.isEmpty) return '未检出人脸';
    final baby = babies[babyId];
    if (baby == null || validReferenceCount(baby) == 0) return '缺少有效参考';
    if (!baby.autoMatch) return '自动匹配已关闭';
    return '相似度不足';
  }

  List<FamilyAsset> reviewCollection(String babyId) => localAssets
      .where((asset) => reviewReason(babyId, asset) != null)
      .toList();

  bool isFavorite(FamilyAsset asset) =>
      favorites.contains(asset.localId, asset.data['_version'] as String?);

  /// 宝宝预览和普通相册使用同一份本机收藏，不影响相册归属或传输。
  Future<void> toggleFavorite(FamilyAsset asset) async {
    if (!isLocalAsset(asset) || asset.data['_version'] is! String) {
      throw StateError('请重新整理或从手机相册打开此媒体。');
    }
    await favorites.set(
      asset.localId!,
      asset.data['_version'] as String,
      !isFavorite(asset),
    );
  }

  /// 两端只交换档案和归类记录，远端缩略图缓存不会冒充手机已有原文件。
  /// 旧同步接口仅保留兼容提示，手机宝宝相册不再交换电脑记录。
  Future<void> sync() async {
    // 以下保留旧实现注释，原同步与下载逻辑已停用。
    // 每次推送有界记录，其后按游标取回电脑相册。
    // 电脑的位置和人物结果不能覆盖手机独立分析与本机原文件位置。
    /* 暂时不可用的目录不阻止其余归类记录同步。 */
    notice = '宝宝相册仅使用手机本地照片和视频，无需连接电脑。';
    changed();
  }

  /// 本地内容版本变化后不复用旧记录，远端原文件必须完整校验后缓存。
  /// 原文件只从手机相册读取；系统缓存路径变化时校验内容身份，绝不下载电脑文件。
  Future<File?> fileFor(FamilyAsset asset) async {
    final id = asset.localId;
    if (id == null) return null;
    final media = await mediaResolver(id);
    if (media == null) return null;
    final file = await media.originFile;
    if (file == null || !await file.exists()) return null;
    final stat = await file.stat();
    if (photoVersion(media) == asset.data['_version'] &&
        stat.size == asset.data['size'] &&
        stat.modified.millisecondsSinceEpoch == asset.data['_fileModified'] &&
        file.path == asset.localPath) {
      return file;
    }
    final identity = await transfer.inspectPhoto(media, useCache: true);
    if (contentAssetId(identity['hash'] as String, identity['size'] as int) !=
        asset.id) {
      return null;
    }
    asset.data['_version'] = photoVersion(media);
    asset.data['_path'] = identity['path'];
    asset.data['_fileModified'] = identity['fileModified'];
    asset.data['_authorized'] = true;
    asset.data['available'] = true;
    await persist();
    changed();
    return file;
  }

  @override
  void dispose() {
    scanPaused = scanPaused || scanning;
    scanning = false;
    _disposed = true;
    _epoch++;
    transfer.removeListener(_transferChanged);
    _scanNotification?.cancel();
    favorites.removeListener(changed);
    favorites.dispose();
    if (_opened) {
      unawaited(
        _scanTask == null && _scanSave == null
            ? store.close()
            : _closeAfterScan(),
      );
    }
    super.dispose();
  }

  /// 关闭前等待当前项与检查点保存，存储不先于任务关闭。
  Future<void> _closeAfterScan() async {
    try {
      await _scanTask;
      await _scanSave;
      await persist();
    } catch (_) {
      // 关闭期间的失败保留已有落盘记录，下次启动重新核对缓存。
    } finally {
      await store.close();
    }
  }
}
