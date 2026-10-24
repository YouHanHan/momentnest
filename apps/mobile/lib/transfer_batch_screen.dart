import 'package:flutter/material.dart';
import 'gallery_style.dart';
import 'models.dart';
import 'transfer_controller.dart';
import 'transfer_task_screen.dart';

/// 按持久化批次标识聚合；旧记录缺标识时独立成组，不按日期误合并。
class TransferBatch {
  TransferBatch(this.id, this.tasks);
  final String id;
  final List<UploadTask> tasks;
  int get saved => tasks.where(taskSaved).length;
  int get failed => tasks.where((task) => task.state == 'failed').length;
  int get pending => tasks.where((task) => !taskSaved(task) && !['failed', 'skipped', 'cancelled'].contains(task.state)).length;
  int get skipped => tasks.where((task) => task.state == 'skipped').length;
  int get cancelled => tasks.where((task) => task.state == 'cancelled').length;
  bool get active => pending > 0;
  DateTime? get created => DateTime.tryParse(tasks.first.data['createdAt'] ?? '');
  double get progress {
    final size = tasks.fold<int>(0, (sum, task) => sum + task.size);
    return size == 0 ? 0 : tasks.fold<int>(0, (sum, task) => sum + (taskSaved(task) ? task.size : task.offset.clamp(0, task.size))) / size;
  }
  String get title {
    final date = created, today = DateTime.now();
    final label = date == null ? '早期批次'
        : date.year == today.year && date.month == today.month && date.day == today.day
        ? '今天 ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}'
        : '${date.year == today.year ? '' : '${date.year}年'}${date.month}月${date.day}日 ${date.hour.toString().padLeft(2, '0')}:${date.minute.toString().padLeft(2, '0')}';
    return '$label · ${tasks.length}项';
  }
  String get summary => saved == tasks.length ? '全部已保存'
      : ['已保存 $saved', if (pending > 0) '待处理 $pending', if (failed > 0) '失败 $failed', if (skipped > 0) '跳过 $skipped', if (cancelled > 0) '取消 $cancelled'].join(' · ');
}

List<TransferBatch> transferBatches(List<UploadTask> tasks) {
  final groups = <String, List<UploadTask>>{};
  for (final task in tasks) {
    final id = task.batchGroupId;
    groups.putIfAbsent(id, () => []).add(task);
  }
  return groups.entries.map((entry) => TransferBatch(entry.key, entry.value)).toList()
      ..sort((a, b) => (b.created ?? DateTime(1900)).compareTo(a.created ?? DateTime(1900)));
}

class TransferBatchTile extends StatelessWidget {
  const TransferBatchTile({super.key, required this.batch, required this.onTap, this.showProgress = false});
  final TransferBatch batch;
  final VoidCallback onTap;
  final bool showProgress;
  @override
  Widget build(BuildContext context) => InkWell(
    key: ValueKey('transfer-batch-${batch.id}'),
    onTap: onTap,
    borderRadius: BorderRadius.circular(8),
    child: Padding(
      padding: const EdgeInsets.symmetric(vertical: 14, horizontal: 12),
      child: Row(children: [
        TransferThumbnail(task: batch.tasks.first, size: 64),
        const SizedBox(width: 12),
        Expanded(child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(batch.title, style: const TextStyle(fontWeight: FontWeight.w600)),
          if (showProgress) ...[const SizedBox(height: 10), ClipRRect(borderRadius: BorderRadius.circular(8), child: LinearProgressIndicator(value: batch.progress, minHeight: 6, color: galleryAccentIndicator, backgroundColor: gallerySelected))],
          const SizedBox(height: 8),
          Text(batch.summary, style: TextStyle(color: batch.saved == batch.tasks.length ? galleryAccent : galleryMuted, fontSize: 13)),
        ])),
        const SizedBox(width: 8),
        const Icon(Icons.chevron_right, size: 22),
      ]),
    ),
  );
}

/// 批次详情按标识读取实时队列，失败重试遵守全局暂停约束。
class TransferBatchDetailScreen extends StatefulWidget {
  const TransferBatchDetailScreen({super.key, required this.controller, required this.batchId});
  final TransferController controller;
  final String batchId;
  @override
  State<TransferBatchDetailScreen> createState() => _TransferBatchDetailScreenState();
}

class _TransferBatchDetailScreenState extends State<TransferBatchDetailScreen> {
  String filter = 'all';
  @override
  Widget build(BuildContext context) => Scaffold(
    key: const ValueKey('transfer-batch-detail'),
    appBar: AppBar(title: const Text('批次详情')),
    body: SafeArea(top: false, child: AnimatedBuilder(animation: widget.controller, builder: (context, _) {
      final model = widget.controller;
      final batch = transferBatches(model.tasks).where((batch) => batch.id == widget.batchId).firstOrNull;
      if (batch == null) return const Center(child: Text('未找到这批传输记录'));
      final files = batch.tasks.where((task) => filter == 'all' || (filter == 'failed' ? task.state == 'failed' : !taskSaved(task) && !['failed', 'skipped', 'cancelled'].contains(task.state))).toList();
      return Column(children: [
        Padding(padding: const EdgeInsets.fromLTRB(16, 12, 16, 0), child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(batch.title, style: Theme.of(context).textTheme.titleMedium),
          const SizedBox(height: 12),
          Container(decoration: BoxDecoration(color: gallerySelected, borderRadius: BorderRadius.circular(8)), padding: const EdgeInsets.symmetric(vertical: 16), child: Row(children: [
            _BatchCount(batch.saved, '已保存', galleryAccent), _BatchCount(batch.pending, '待处理', galleryMuted), _BatchCount(batch.failed, '失败', galleryError),
          ])),
          if (batch.skipped + batch.cancelled > 0) Padding(padding: const EdgeInsets.only(top: 8), child: Text('跳过 ${batch.skipped} · 取消 ${batch.cancelled}', style: const TextStyle(color: galleryMuted, fontSize: 12))),
          Row(children: [for (final entry in {'all': '全部', 'pending': '待处理', 'failed': '失败'}.entries) Expanded(child: InkWell(onTap: () => setState(() => filter = entry.key), child: Container(padding: const EdgeInsets.symmetric(vertical: 16), decoration: BoxDecoration(border: Border(bottom: BorderSide(color: filter == entry.key ? galleryAccent : Colors.transparent, width: 2))), child: Text(entry.value, textAlign: TextAlign.center, style: TextStyle(color: filter == entry.key ? galleryAccent : galleryMuted)))))]),
        ])),
        Expanded(child: files.isEmpty ? const Center(child: Text('暂无此类任务')) : ListView.separated(
          key: PageStorageKey('batch-${widget.batchId}-$filter'),
          itemCount: files.length,
          separatorBuilder: (_, _) => const Divider(height: 1, indent: 16, endIndent: 16),
          itemBuilder: (context, index) => TransferTaskTile(task: files[index], onTap: () => Navigator.push<void>(context, MaterialPageRoute(builder: (_) => TransferTaskDetailScreen(controller: model, taskId: files[index].id)))),
        )),
        Padding(padding: const EdgeInsets.all(16), child: Column(crossAxisAlignment: CrossAxisAlignment.stretch, children: [
          if (model.notice.isNotEmpty) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(model.notice, maxLines: 2, overflow: TextOverflow.ellipsis, style: const TextStyle(fontSize: 12))),
          if (model.running && batch.failed > 0) const Padding(padding: EdgeInsets.only(bottom: 6), child: Text('暂停队列后可重试', textAlign: TextAlign.center, style: TextStyle(fontSize: 12, color: galleryMuted))),
          if (batch.pending > 0) TextButton.icon(onPressed: model.busy ? null : model.running ? model.pause : () => model.action(() => model.continueBatch(batch.id)), icon: Icon(model.running ? Icons.pause : Icons.play_arrow), label: Text(model.running ? '暂停队列' : '继续本批次')),
          FilledButton(key: const ValueKey('batch-retry-failed'), onPressed: batch.failed == 0 || model.running || model.busy ? null : () => model.action(() => model.retryFailedBatch(batch.id)), child: Text('重试失败项（${batch.failed}）')),
        ])),
      ]);
    })),
  );
}

class _BatchCount extends StatelessWidget {
  const _BatchCount(this.value, this.label, this.color);
  final int value;
  final String label;
  final Color color;
  @override
  Widget build(BuildContext context) => Expanded(child: Column(children: [Text('$value', style: TextStyle(fontSize: 26, fontWeight: FontWeight.w600, color: color)), Text(label, style: TextStyle(color: color))]));
}
