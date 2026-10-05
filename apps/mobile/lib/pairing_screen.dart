import 'package:flutter/material.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

/// 扫码只返回配对信息，证书校验和凭据交换由连接服务执行。
class PairingScreen extends StatefulWidget {
  const PairingScreen({super.key});
  @override
  State<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends State<PairingScreen> {
  bool camera = false, finished = false;
  final text = TextEditingController();
  void complete(String value) {
    if (finished || value.trim().isEmpty) return;
    finished = true;
    Navigator.pop(context, value.trim());
  }

  @override
  void dispose() {
    text.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(title: const Text('连接电脑')),
    body: ListView(
      padding: const EdgeInsets.all(20),
      children: [
        const Text('在电脑端选择接收目录，点击「连接新手机」。'),
        const SizedBox(height: 20),
        if (camera)
          SizedBox(
            height: 300,
            child: MobileScanner(
              onDetect: (capture) {
                for (final barcode in capture.barcodes) {
                  if (barcode.rawValue != null) {
                    complete(barcode.rawValue!);
                    break;
                  }
                }
              },
              errorBuilder: (context, error) => const Center(
                child: Text(
                  '摄像头不可用。请检查相机权限，或使用下方手动配对。',
                  textAlign: TextAlign.center,
                ),
              ),
            ),
          )
        else
          FilledButton.icon(
            onPressed: () => setState(() => camera = true),
            icon: const Icon(Icons.qr_code_scanner),
            label: const Text('打开相机扫码'),
          ),
        const SizedBox(height: 28),
        const Text(
          '也可以粘贴配对信息',
          style: TextStyle(fontSize: 18, fontWeight: FontWeight.w700),
        ),
        const SizedBox(height: 12),
        TextField(
          controller: text,
          minLines: 4,
          maxLines: 7,
          decoration: const InputDecoration(
            border: OutlineInputBorder(),
            hintText: '电脑端「显示手动配对信息」中的全部内容',
          ),
        ),
        const SizedBox(height: 14),
        FilledButton(
          onPressed: () => complete(text.text),
          child: const Text('使用配对信息连接'),
        ),
        const SizedBox(height: 12),
        const Text(
          '仅限同网段局域网：使用 Wi-Fi 或有线网络，不使用移动数据、VPN 或公网地址。配对信息五分钟内有效，使用一次后失效。',
        ),
      ],
    ),
  );
}
