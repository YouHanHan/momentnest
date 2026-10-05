import 'dart:convert';
import 'package:flutter/foundation.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:sqflite/sqflite.dart';
import 'models.dart';

/// 普通队列数据放 SQLite，设备访问令牌放系统安全存储。
class LocalStore {
  late Database _db;
  final FlutterSecureStorage _secure = const FlutterSecureStorage();
  final Map<String, Future<void>> _preferenceWrites = {};
  Future<void> open() async {
    final path = await getDatabasesPath();
    _db = await openDatabase(
      '$path/momentnest.sqlite',
      version: 1,
      onCreate: (db, version) async {
        await db.execute(
          'CREATE TABLE preferences (key TEXT PRIMARY KEY,value TEXT NOT NULL)',
        );
        await db.execute(
          'CREATE TABLE tasks (id TEXT PRIMARY KEY,data TEXT NOT NULL)',
        );
        await db.execute(
          'CREATE TABLE observations (asset TEXT NOT NULL,receiver TEXT NOT NULL,library TEXT NOT NULL,version TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(asset,receiver,library))',
        );
      },
    );
  }

  /// 分段读取旧记录，避免整库 JSON 超过 Android CursorWindow 的单行限制。
  Future<dynamic> preference(String key) =>
      _db.transaction((transaction) async {
        const chunkCharacters = 64 * 1024;
        final text = StringBuffer();
        for (var offset = 1; ; offset += chunkCharacters) {
          final rows = await transaction.rawQuery(
            'SELECT substr(value, ?, ?) AS value FROM preferences WHERE key=?',
            [offset, chunkCharacters, key],
          );
          if (rows.isEmpty) return null;
          final chunk = rows.first['value'] as String;
          text.write(chunk);
          // SQLite substr 按 Unicode 字符计数，不能用 Dart 的 UTF-16 长度判断。
          if (chunk.runes.length < chunkCharacters) break;
        }
        final serialized = text.toString();
        // 大相册的特征记录在独立 isolate 解码，避免占用界面线程。
        return serialized.length >= 256 * 1024
            ? await compute(_decodePreference, serialized)
            : jsonDecode(serialized);
      });

  Future<void> setPreference(String key, Object? value) {
    // 整理检查点仍沿用原存储格式，大列表的编码交给独立 isolate。
    final serialized = value is List && value.length >= 200
        ? compute(_encodePreference, value)
        : Future.value(jsonEncode(value));
    // 同一键按调用顺序落盘，防止较慢的旧编码覆盖后来的人工修改。
    final previous = _preferenceWrites[key] ?? Future<void>.value();
    late final Future<void> operation;
    operation =
        Future.wait<Object?>([previous.catchError((Object _) {}), serialized])
            .then((values) async {
              await _db.insert('preferences', {
                'key': key,
                'value': values[1] as String,
              }, conflictAlgorithm: ConflictAlgorithm.replace);
            })
            .whenComplete(() {
              if (identical(_preferenceWrites[key], operation)) {
                _preferenceWrites.remove(key);
              }
            });
    _preferenceWrites[key] = operation;
    return operation;
  }

  Future<List<UploadTask>> tasks() async => (await _db.query(
    'tasks',
  )).map((row) => UploadTask(jsonDecode(row['data'] as String))).toList();
  Future<void> saveTask(UploadTask task) async {
    await _db.insert('tasks', {
      'id': task.id,
      'data': jsonEncode(task.data),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> observe(
    String asset,
    String receiver,
    String library,
    String version,
    Json data,
  ) async {
    await _db.insert('observations', {
      'asset': asset,
      'receiver': receiver,
      'library': library,
      'version': version,
      'data': jsonEncode(data),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<Map<String, Json>> observations(
    String receiver,
    String library,
  ) async {
    final rows = await _db.query(
      'observations',
      where: 'receiver=? AND library=?',
      whereArgs: [receiver, library],
    );
    return {
      for (final row in rows)
        row['asset'] as String: {
          ...jsonDecode(row['data'] as String) as Json,
          'version': row['version'],
        },
    };
  }

  Future<void> saveToken(String receiver, String token) =>
      _secure.write(key: 'receiver:$receiver', value: token);

  /// 只加载当前页面的记录，不把整个相册的核对详情放入内存。
  Future<Map<String, Json>> observationsFor(
    String receiver,
    String library,
    List<String> assets,
  ) async {
    if (assets.isEmpty) return {};
    final placeholders = List.filled(assets.length, '?').join(',');
    final rows = await _db.query(
      'observations',
      where: 'receiver=? AND library=? AND asset IN ($placeholders)',
      whereArgs: [receiver, library, ...assets],
    );
    return {
      for (final row in rows)
        row['asset'] as String: {
          ...jsonDecode(row['data'] as String) as Json,
          'version': row['version'],
        },
    };
  }

  /// 跨接收目录复用未变化照片的指纹，不复用其他电脑的备份结论。
  Future<Json?> cachedIdentity(String asset, String version) async {
    final rows = await _db.query(
      'observations',
      columns: ['data'],
      where: 'asset=? AND version=?',
      whereArgs: [asset, version],
      limit: 1,
    );
    if (rows.isEmpty) return null;
    final data = jsonDecode(rows.first['data'] as String) as Json;
    return data['hash'] is String && data['size'] is int ? data : null;
  }

  Future<String?> token(String receiver) =>
      _secure.read(key: 'receiver:$receiver');
  Future<void> close() async {
    await Future.wait(_preferenceWrites.values);
    await _db.close();
  }
}

dynamic _decodePreference(String value) => jsonDecode(value);
String _encodePreference(Object? value) => jsonEncode(value);
