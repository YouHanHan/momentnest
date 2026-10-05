import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

/// 从更多菜单触发预览操作，继续验证原有业务结果。
Future<void> choosePreviewTool(WidgetTester tester, String key) async {
  await tester.tap(find.byKey(const ValueKey('preview-tools')));
  await tester.pumpAndSettle();
  final item = find.byKey(ValueKey(key));
  await tester.ensureVisible(item);
  await tester.tap(item);
  await tester.pumpAndSettle();
}
