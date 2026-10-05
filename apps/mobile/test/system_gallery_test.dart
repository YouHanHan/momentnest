import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:photo_manager/photo_manager.dart';
import 'package:momentnest_mobile/system_gallery.dart';

AssetEntity media(String id, {bool video = false}) => AssetEntity(
  id: id,
  typeInt: video ? 2 : 1,
  width: 100,
  height: 100,
  createDateSecond: 100,
);

class GallerySource extends SystemGallerySource {
  GallerySource(this.total, this.batches);
  final int total;
  final Map<int, List<AssetEntity>> batches;
  final List<int> pages = [], sizes = [];
  final Map<int, Completer<List<AssetEntity>>> gates = {};
  final Set<int> failOnce = {};
  @override
  Future<int> count() async => total;
  @override
  Future<List<AssetEntity>> page({required int number, required int size}) async {
    pages.add(number);
    sizes.add(size);
    if (failOnce.remove(number)) throw StateError('测试读取失败。');
    final gate = gates[number];
    if (gate != null) return gate.future;
    return batches[number] ?? [];
  }
}

class GalleryGateway extends SystemGalleryGateway {
  GalleryGateway(this.source);
  SystemGallerySource? source;
  PermissionState state = PermissionState.authorized;
  final List<bool> requests = [], managed = [];
  final List<RequestType> opened = [];
  final Map<RequestType, SystemGallerySource> types = {};
  Completer<PermissionState>? permissionGate;
  PermissionState? requestedState, managedState;
  @override
  Future<PermissionState> permission({required bool request}) async {
    requests.add(request);
    if (request && requestedState != null) return state = requestedState!;
    return permissionGate?.future ?? state;
  }
  @override
  Future<SystemGallerySource?> open({required RequestType type}) async {
    opened.add(type);
    return types[type] ?? source;
  }
  @override
  Future<void> manageAccess({required bool limited}) async {
    managed.add(limited);
    if (managedState != null) state = managedState!;
  }
}

void main() {
  test('Android 分别授权时直接读取获准类别，并用系统设置管理授权', () async {
    TestWidgetsFlutterBinding.ensureInitialized();
    const channel = MethodChannel('com.fluttercandies/photo_manager');
    const mediaChannel = MethodChannel('dev.jinchuan/media');
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, (call) async {
      expect(call.method, 'sdkInt');
      return 28;
    });
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(mediaChannel, null));
    final calls = <MethodCall>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
          calls.add(call);
          final arguments = call.arguments as Map? ?? {};
          if (call.method == 'getPermissionState') {
            final option = arguments['androidPermission'] as Map;
            expect(option['mediaLocation'], isFalse);
            return option['type'] == RequestType.image.value
                ? PermissionState.authorized.index
                : PermissionState.denied.index;
          }
          if (call.method == 'getAssetPathList') {
            expect(arguments['type'], RequestType.image.value);
            expect(arguments['onlyAll'], isTrue);
            final filter = arguments['option'] as Map;
            final value = filter['child'] as Map;
            expect(value['where'], 'media_type IN (1)');
            expect(value['orderBy'], [
              {'column': 'date_added', 'isAsc': false},
              {'column': '_id', 'isAsc': false},
            ]);
            return {'data': []};
          }
          if (call.method == 'openSetting') return null;
          throw StateError('未预期的平台操作：${call.method}');
        });
    addTearDown(() => TestDefaultBinaryMessengerBinding.instance
        .defaultBinaryMessenger.setMockMethodCallHandler(channel, null));
    final gateway = PhotoManagerGalleryGateway();
    expect(await gateway.permission(request: false), PermissionState.limited);
    await gateway.open(type: RequestType.common);
    final queried = calls.where((call) => call.method == 'getAssetPathList').length;
    expect(await gateway.open(type: RequestType.video), isNull);
    expect(calls.where((call) => call.method == 'getAssetPathList').length, queried);
    await gateway.manageAccess(limited: true);
    expect(calls.last.method, 'openSetting');
    expect(calls.any((call) => call.method == 'requestPermissionExtend'), isFalse);
  });

  test('启动只读取现有授权，未授权时不查询系统媒体或自动弹出授权', () async {
    final source = GallerySource(50000, {});
    final gateway = GalleryGateway(source)..state = PermissionState.denied;
    final controller = SystemGalleryController(gateway: gateway);
    addTearDown(controller.dispose);
    await controller.initialize();
    expect(gateway.requests, [false]);
    expect(gateway.opened, isEmpty);
    expect(source.pages, isEmpty);
    expect(controller.authorized, isFalse);
    expect(controller.ready, isTrue);
    expect(controller.loading, isFalse);
    expect(controller.notice, contains('允许访问系统相册'));
  });

  test('初次读取尚未完成时，显式授权等待结束后仅申请一次并显示原媒体', () async {
    final source = GallerySource(1, {0: [media('photo')]});
    final gateway = GalleryGateway(source)
      ..permissionGate = Completer<PermissionState>()
      ..requestedState = PermissionState.authorized;
    final controller = SystemGalleryController(gateway: gateway);
    addTearDown(controller.dispose);
    final initial = controller.initialize();
    final grant = controller.requestAccess();
    expect(gateway.requests, [false]);
    gateway.permissionGate!.complete(PermissionState.denied);
    await Future.wait([initial, grant]);
    expect(gateway.requests, [false, true]);
    expect(controller.assets.single.id, 'photo');
    expect(controller.authorized, isTrue);
  });

  test('五万条系统照片视频仅读取首60项，保持原生查询顺序和原媒体对象', () async {
    final first = List.generate(
      60,
      (index) => media('${50000 - index}', video: index.isOdd),
    );
    final source = GallerySource(50000, {0: first});
    final gateway = GalleryGateway(source);
    final controller = SystemGalleryController(gateway: gateway);
    addTearDown(controller.dispose);
    await controller.initialize();
    expect(source.pages, [0]);
    expect(source.sizes, [60]);
    expect(gateway.opened, [RequestType.common]);
    expect(controller.total, 50000);
    expect(controller.hasMore, isTrue);
    expect(controller.assets, first);
    expect(identical(controller.assets.first, first.first), isTrue);
    expect(controller.assets[1].type, AssetType.video);
    expect(() => controller.assets.clear(), throwsUnsupportedError);
  });

  test('并发滚动只请求同一页一次，系统页边界重复媒体不会重复显示', () async {
    final source = GallerySource(7, {
      0: [media('6'), media('5'), media('4')],
      2: [media('1')],
    })..gates[1] = Completer<List<AssetEntity>>();
    final controller = SystemGalleryController(
      gateway: GalleryGateway(source),
      pageSize: 3,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    final first = controller.loadMore(), second = controller.loadMore();
    expect(source.pages, [0, 1]);
    expect(controller.loadingMore, isTrue);
    source.gates[1]!.complete([media('4'), media('3'), media('2')]);
    await Future.wait([first, second]);
    expect(controller.assets.map((asset) => asset.id), ['6', '5', '4', '3', '2']);
    expect(controller.loadingMore, isFalse);
    await controller.loadMore();
    await controller.loadMore();
    expect(source.pages, [0, 1, 2]);
    expect(controller.hasMore, isFalse);
    expect(controller.assets.last.id, '1');
  });

  test('分页失败保留已显示媒体，重试原页而不跳过后续照片', () async {
    final source = GallerySource(4, {
      0: [media('4'), media('3'), media('2')],
      1: [media('1')],
    })..failOnce.add(1);
    final controller = SystemGalleryController(
      gateway: GalleryGateway(source),
      pageSize: 3,
    );
    addTearDown(controller.dispose);
    await controller.initialize();
    await controller.loadMore();
    expect(controller.assets, hasLength(3));
    expect(controller.notice, contains('请重试'));
    expect(controller.hasMore, isTrue);
    await controller.loadMore();
    expect(source.pages, [0, 1, 1]);
    expect(controller.assets.last.id, '1');
    expect(controller.hasMore, isFalse);
  });

  test('刷新后迟到的旧分页不能加入新相册或影响新页面的加载状态', () async {
    final old = GallerySource(4, {0: [media('old-0'), media('old-1')]})
      ..gates[1] = Completer<List<AssetEntity>>();
    final gateway = GalleryGateway(old);
    final controller = SystemGalleryController(gateway: gateway, pageSize: 2);
    addTearDown(controller.dispose);
    await controller.initialize();
    final pending = controller.loadMore();
    gateway.source = GallerySource(1, {0: [media('new')]});
    await controller.refresh();
    old.gates[1]!.complete([media('old-2'), media('old-3')]);
    await pending;
    expect(controller.assets.map((asset) => asset.id), ['new']);
    expect(controller.loadingMore, isFalse);
    expect(controller.loading, isFalse);
    expect(controller.total, 1);
  });

  test('部分授权明确提示，可管理授权后刷新；权限撤销后清空已加载范围', () async {
    final gateway = GalleryGateway(GallerySource(1, {0: [media('allowed')]}))
      ..state = PermissionState.limited
      ..managedState = PermissionState.authorized;
    final controller = SystemGalleryController(gateway: gateway);
    addTearDown(controller.dispose);
    await controller.initialize();
    expect(controller.authorized, isTrue);
    expect(controller.limited, isTrue);
    expect(controller.notice, isEmpty);
    await controller.manageAccess();
    expect(gateway.managed, [true]);
    expect(gateway.requests, [false, false]);
    expect(controller.limited, isFalse);
    gateway.state = PermissionState.denied;
    await controller.refresh();
    expect(controller.assets, isEmpty);
    expect(controller.total, 0);
    expect(controller.authorized, isFalse);
    expect(controller.hasMore, isFalse);
  });

  test('类型筛选重新发出原生查询，旧照片分页不能进入视频列表', () async {
    final source = GallerySource(4, {0: [media('photo-0'), media('photo-1')]})
      ..gates[1] = Completer<List<AssetEntity>>();
    final gateway = GalleryGateway(source)
      ..types[RequestType.video] = GallerySource(1, {
        0: [media('video', video: true)],
      });
    final controller = SystemGalleryController(gateway: gateway, pageSize: 2);
    addTearDown(controller.dispose);
    await controller.initialize();
    final oldPage = controller.loadMore();
    await controller.setType(RequestType.video);
    source.gates[1]!.complete([media('photo-2'), media('photo-3')]);
    await oldPage;
    expect(gateway.opened, [RequestType.common, RequestType.video]);
    expect(controller.assets.single.id, 'video');
    expect(controller.type, RequestType.video);
    expect(controller.loadingMore, isFalse);
  });

  test('控制器销毁后延迟授权返回不再通知或继续查询媒体', () async {
    final gateway = GalleryGateway(GallerySource(1, {0: [media('photo')]}))
      ..permissionGate = Completer<PermissionState>();
    final controller = SystemGalleryController(gateway: gateway);
    var notifications = 0;
    controller.addListener(() => notifications++);
    final initial = controller.initialize();
    final before = notifications;
    controller.dispose();
    await controller.requestAccess();
    gateway.permissionGate!.complete(PermissionState.authorized);
    await initial;
    await controller.refresh();
    await controller.loadMore();
    await controller.requestAccess();
    await controller.manageAccess();
    expect(notifications, before);
    expect(gateway.opened, isEmpty);
    expect(gateway.managed, isEmpty);
  });
}
