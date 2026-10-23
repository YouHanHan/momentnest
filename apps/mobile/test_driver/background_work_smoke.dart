import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;
import 'package:crypto/crypto.dart';
import 'package:flutter/material.dart';
import 'package:path_provider/path_provider.dart';
import 'package:momentnest_mobile/background_work.dart';
import 'package:momentnest_mobile/family_controller.dart';
import 'package:momentnest_mobile/transfer_controller.dart';

/// 模拟器专用入口：只生成应用私有合成文件，验证真实服务和原生线程。
void main() => runApp(const MaterialApp(home: BackgroundSmoke()));

class BackgroundSmoke extends StatefulWidget {
  const BackgroundSmoke({super.key});
  @override
  State<BackgroundSmoke> createState() => _BackgroundSmokeState();
}

class _BackgroundSmokeState extends State<BackgroundSmoke>
    with WidgetsBindingObserver {
  final background = BackgroundWork();
  bool running = false;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    debugPrint('BACKGROUND_SMOKE lifecycle=${state.name}');
  }

  Future<void> run() async {
    setState(() => running = true);
    var stopped = false;
    final subscription = background.interruptions.listen((reason) {
      stopped = true;
      debugPrint('BACKGROUND_SMOKE interrupted=$reason');
    });
    BackgroundLease? transfer, faces;
    try {
      final directory = await getApplicationSupportDirectory();
      final original = File('${directory.path}/background-smoke.bin');
      final bytes = List<int>.generate(2 * 1024 * 1024, (index) => index % 251);
      await original.writeAsBytes(bytes);
      final expected = sha256.convert(bytes).toString();
      final recorder = ui.PictureRecorder();
      final canvas = Canvas(recorder);
      canvas.drawRect(
        const Rect.fromLTWH(0, 0, 128, 128),
        Paint()..color = Colors.green,
      );
      final picture = recorder.endRecording();
      final image = await picture.toImage(128, 128);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      final photo = File('${directory.path}/background-smoke.png');
      await photo.writeAsBytes(png!.buffer.asUint8List());
      image.dispose();
      picture.dispose();
      transfer = await background.begin(BackgroundTask.transfer, '合成文件指纹验证');
      faces = await background.begin(BackgroundTask.faceScan, '合成图片原生分析');
      debugPrint('BACKGROUND_SMOKE started');
      for (var index = 1; index <= 120 && !stopped; index++) {
        final identity = await fingerprintAndroidFile(original.path);
        if (identity['hash'] != expected) throw StateError('完整指纹不符');
        await FamilyController.channel.invokeMethod<Object?>('analyze', {
          'path': photo.path,
          'kind': 'photo',
          'frames': 4,
        });
        background.update(transfer, '$index / 120');
        background.update(faces, '$index / 120');
        if (index % 5 == 0) debugPrint('BACKGROUND_SMOKE processed=$index');
        await Future<void>.delayed(const Duration(milliseconds: 200));
      }
      debugPrint('BACKGROUND_SMOKE result=${stopped ? 'paused' : 'complete'}');
    } catch (error, stack) {
      debugPrint('BACKGROUND_SMOKE failed=$error\n$stack');
    } finally {
      await background.finish(transfer);
      await background.finish(faces);
      await subscription.cancel();
      if (mounted) setState(() => running = false);
      debugPrint('BACKGROUND_SMOKE released');
    }
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    body: Center(
      child: FilledButton(
        onPressed: running ? null : run,
        child: Text(running ? '验证运行中' : '开始后台验证'),
      ),
    ),
  );

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    background.dispose();
    super.dispose();
  }
}
