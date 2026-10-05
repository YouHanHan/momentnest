import 'package:flutter/material.dart';
import 'family_controller.dart';
import 'family_models.dart';
import 'models.dart';

/// 档案草稿由弹窗管理，关闭动画结束后再释放输入控制器。
class BabyProfileDialog extends StatefulWidget {
  const BabyProfileDialog({super.key, required this.controller, this.previous});
  final FamilyController controller;
  final BabyProfile? previous;
  @override
  State<BabyProfileDialog> createState() => _BabyProfileDialogState();
}

class _BabyProfileDialogState extends State<BabyProfileDialog> {
  late final TextEditingController name;
  late String birthday;
  late bool auto;
  bool saving = false;
  String failure = '';

  @override
  void initState() {
    super.initState();
    name = TextEditingController(text: widget.previous?.name ?? '');
    birthday = widget.previous?.birthday ?? dateLabel(DateTime.now());
    auto = widget.previous?.autoMatch ?? true;
  }

  @override
  void dispose() {
    name.dispose();
    super.dispose();
  }

  Future<void> save() async {
    if (saving) return;
    setState(() {
      saving = true;
      failure = '';
    });
    try {
      await widget.controller.saveBaby(
        id: widget.previous?.id,
        name: name.text,
        birthday: birthday,
        autoMatch: auto,
      );
      if (mounted && ModalRoute.of(context)?.isCurrent == true) {
        Navigator.pop(context);
      }
    } catch (error) {
      if (mounted) {
        setState(() => failure = widget.controller.transfer.explain(error));
      }
    } finally {
      if (mounted) {
        setState(() => saving = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) => AlertDialog(
    title: Text(widget.previous == null ? '建立宝宝档案' : '编辑宝宝档案'),
    content: SingleChildScrollView(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            controller: name,
            maxLength: 40,
            enabled: !saving,
            decoration: const InputDecoration(labelText: '宝宝名字'),
          ),
          const SizedBox(height: 12),
          OutlinedButton.icon(
            onPressed: saving
                ? null
                : () async {
                    final now = DateTime.now(),
                        previous =
                            DateTime.tryParse(birthday) ?? DateTime.now();
                    final date = await showDatePicker(
                      context: context,
                      initialDate: previous.isAfter(now)
                          ? now
                          : previous.isBefore(DateTime(1900))
                          ? DateTime(1900)
                          : previous,
                      firstDate: DateTime(1900),
                      lastDate: now,
                    );
                    if (date != null && mounted) {
                      setState(() => birthday = dateLabel(date));
                    }
                  },
            icon: const Icon(Icons.cake_outlined),
            label: Text('出生日期 $birthday'),
          ),
          SwitchListTile(
            contentPadding: EdgeInsets.zero,
            title: const Text('自动整理相同人物'),
            subtitle: const Text('选定参考人脸后在本机离线匹配。较弱匹配由你确认。'),
            value: auto,
            onChanged: saving ? null : (value) => setState(() => auto = value),
          ),
          if (saving) const LinearProgressIndicator(minHeight: 2),
          if (failure.isNotEmpty)
            Text(failure, style: const TextStyle(color: Colors.deepOrange)),
        ],
      ),
    ),
    actions: [
      TextButton(
        onPressed: () => Navigator.pop(context),
        child: const Text('取消'),
      ),
      FilledButton(onPressed: saving ? null : save, child: const Text('保存档案')),
    ],
  );
}
