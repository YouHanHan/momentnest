import 'dart:async';
import 'dart:io';
import 'package:flutter/services.dart';

enum BackgroundTask { preparation, transfer, backupCheck, faceScan }

/// 一次任务独占自己的后台资格，旧任务结束不会停止新任务的服务。
class BackgroundLease {
  BackgroundLease._(this.task, this.text);
  final BackgroundTask task;
  String text;
  bool active = false, starting = true;
  Timer? _refresh;
}

/// 统一管理 Android 前台服务，系统中断后由业务保存检查点并暂停。
class BackgroundWork {
  BackgroundWork({bool? android, MethodChannel? channel})
    : enabled = android ?? Platform.isAndroid,
      _channel = channel ?? const MethodChannel('dev.momentnest/background') {
    if (enabled) _channel.setMethodCallHandler(_handle);
  }

  final bool enabled;
  final MethodChannel _channel;
  final _leases = <BackgroundTask, BackgroundLease>{};
  final _interruptions = StreamController<String>.broadcast(sync: true);
  Future<void> _operations = Future.value();
  bool _disposed = false;
  int _epoch = 0;
  Stream<String> get interruptions => _interruptions.stream;

  bool allows(BackgroundTask task) => _leases[task]?.active == true;
  bool starting(BackgroundTask task) =>
      enabled && _leases[task]?.starting == true;

  Future<T> _serial<T>(Future<T> Function() work) {
    final next = _operations.then((_) => work());
    _operations = next.then<void>((_) {}, onError: (Object _) {});
    return next;
  }

  /// 等待原生服务成功进入前台后，才允许业务离开界面继续执行。
  Future<BackgroundLease> begin(BackgroundTask task, String text) async {
    if (_disposed) throw StateError('后台任务管理器已关闭。');
    if (_leases.containsKey(task)) throw StateError('同类后台任务尚未结束。');
    final lease = BackgroundLease._(task, text);
    if (!enabled) {
      lease.starting = false;
      return lease;
    }
    final epoch = _epoch;
    _leases[task] = lease;
    try {
      await _serial(() async {
        if (_disposed || epoch != _epoch) throw StateError('后台任务已中断。');
        final running = await _channel.invokeMethod<bool>('start', {
          'task': task.name,
          'text': text,
        });
        if (_disposed || epoch != _epoch || running != true) {
          throw StateError('后台服务未就绪，任务已保留，请回到应用重试。');
        }
        lease.active = true;
      });
      return lease;
    } catch (_) {
      if (identical(_leases[task], lease)) _leases.remove(task);
      rethrow;
    } finally {
      lease.starting = false;
    }
  }

  /// 合并高频进度通知，通知内容仅包含计数和阶段。
  void update(BackgroundLease? lease, String text) {
    if (lease == null || !lease.active || lease.text == text || _disposed) {
      return;
    }
    lease.text = text;
    lease._refresh ??= Timer(const Duration(seconds: 1), () {
      lease._refresh = null;
      unawaited(
        _serial(() async {
          if (!lease.active || _disposed) return;
          try {
            await _channel.invokeMethod<void>('update', {
              'task': lease.task.name,
              'text': lease.text,
            });
          } catch (_) {
            _interrupt('后台服务不可用，进度已保留，请回到应用继续。');
            await _stopAll();
          }
        }),
      );
    });
  }

  /// 只释放本次任务的后台资格，其余任务继续使用服务。
  Future<void> finish(BackgroundLease? lease) async {
    if (lease == null) return;
    lease._refresh?.cancel();
    final wasActive = lease.active;
    lease.active = false;
    if (!identical(_leases[lease.task], lease)) return;
    _leases.remove(lease.task);
    if (wasActive) {
      await _serial(() async {
        try {
          await _channel.invokeMethod<void>('finish', {
            'task': lease.task.name,
          });
        } catch (_) {
          _interrupt('后台服务停止失败，任务已暂停，请重新打开应用。');
          await _stopAll();
        }
      });
    }
  }

  Future<void> _handle(MethodCall call) async {
    if (call.method == 'interrupted') {
      final args = Map<Object?, Object?>.from(call.arguments as Map);
      _interrupt(args['reason'] as String? ?? '后台任务已停止，进度已保留。');
    }
  }

  void _interrupt(String reason) {
    _epoch++;
    for (final lease in _leases.values) {
      lease.active = false;
      lease._refresh?.cancel();
    }
    _leases.clear();
    if (!_disposed) _interruptions.add(reason);
  }

  Future<void> _stopAll() async {
    try {
      await _channel.invokeMethod<void>('stopAll');
    } catch (_) {
      // 系统已停止服务时不再重启，业务继续使用已落盘断点。
    }
  }

  void dispose() {
    if (_disposed) return;
    _disposed = true;
    _interrupt('后台任务已关闭。');
    if (enabled) {
      _channel.setMethodCallHandler(null);
      unawaited(_serial(_stopAll));
    }
    unawaited(_interruptions.close());
  }
}
