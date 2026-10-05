import 'package:flutter/material.dart';
import 'dart:typed_data';
import 'package:photo_manager/photo_manager.dart';
import 'models.dart';
import 'transfer_controller.dart';
import 'gallery_style.dart';

const transferTaskStateLabels = {
  'queued': '排队中',
  'checking': '核对 / 校验中',
  'uploading': '传输中',
  'complete': '已保存',
  'skipped': '跳过 · 电脑已有',
  'failed': '失败',
  'paused': '已暂停',
  'cancelled': '已取消',
};

double _progress(UploadTask task) =>
    task.size > 0 ? (task.offset / task.size).clamp(0.0, 1.0) : 0;

/// 已保存统计只采用与任务身份一致的电脑回执。
bool taskSaved(UploadTask task) {
  final receipt = task.data['receipt'];
  return task.state == 'complete' &&
      receipt is Map &&
      receipt['receiverId'] == task.receiverId &&
      receipt['libraryId'] == task.libraryId &&
      receipt['hash'] == task.hash &&
      receipt['size'] == task.size;
}

String taskStatus(UploadTask task) => taskSaved(task)
    ? '已保存'
    : task.state == 'complete' ||
          (task.state == 'checking' &&
              task.size > 0 &&
              task.offset >= task.size)
    ? '等待电脑确认'
    : transferTaskStateLabels[task.state] ?? task.state;

IconData taskStatusIcon(UploadTask task) => taskSaved(task)
    ? Icons.check_circle
    : task.state == 'failed'
    ? Icons.error
    : task.state == 'paused'
    ? Icons.pause_circle
    : task.state == 'queued'
    ? Icons.circle_outlined
    : task.state == 'cancelled'
    ? Icons.stop_circle_outlined
    : Icons.schedule;

Color taskStatusColor(UploadTask task) => taskSaved(task)
    ? galleryGreen
    : task.state == 'failed'
    ? const Color(0xFFE4583E)
    : galleryMuted;

/// 任务缩略图按需读取已授权系统媒体，不扫描或计算整库指纹。
class TransferThumbnail extends StatefulWidget {
  const TransferThumbnail({super.key, required this.task, this.size = 56});
  final UploadTask task;
  final double size;
  @override
  State<TransferThumbnail> createState() => _TransferThumbnailState();
}

class _TransferThumbnailState extends State<TransferThumbnail> {
  late Future<Uint8List?> bytes = load();
  Future<Uint8List?> load() async {
    try {
      final id = widget.task.data['assetId'];
      if (id is! String) return null;
      final asset = await AssetEntity.fromId(id);
      return await asset?.thumbnailDataWithSize(const ThumbnailSize(240, 240));
    } catch (_) {
      return null;
    }
  }

  @override
  void didUpdateWidget(TransferThumbnail oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.task.data['assetId'] != widget.task.data['assetId'] ||
        oldWidget.task.data['hash'] != widget.task.data['hash']) {
      bytes = load();
    }
  }

  @override
  Widget build(BuildContext context) => ClipRRect(
    borderRadius: BorderRadius.circular(8),
    child: SizedBox.square(
      dimension: widget.size,
      child: FutureBuilder<Uint8List?>(
        future: bytes,
        builder: (_, snapshot) => snapshot.data == null
            ? ColoredBox(
                color: gallerySelected,
                child: Icon(
                  widget.task.data['kind'] == 'video'
                      ? Icons.videocam_outlined
                      : Icons.image_outlined,
                  color: galleryMuted,
                ),
              )
            : Image.memory(
                snapshot.data!,
                fit: BoxFit.cover,
                errorBuilder: (_, _, _) => const Icon(Icons.image_outlined),
              ),
      ),
    ),
  );
}

/// 任务列表只显示媒体名称与状态，完整保存信息在详情页查看。
class TransferTaskTile extends StatelessWidget {
  const TransferTaskTile({super.key, required this.task, required this.onTap});
  final UploadTask task;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final showProgress = [
      'uploading',
      'checking',
      'paused',
    ].contains(task.state);
    final state = taskStatus(task);
    return ListTile(
      key: ValueKey('transfer-task-${task.id}'),
      contentPadding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      leading: TransferThumbnail(task: task),
      title: Text(task.filename, maxLines: 1, overflow: TextOverflow.ellipsis),
      subtitle: Row(
        children: [
          Icon(taskStatusIcon(task), color: taskStatusColor(task), size: 17),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              showProgress
                  ? '$state · 已传 ${(_progress(task) * 100).round()}%'
                  : state,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(color: taskStatusColor(task)),
            ),
          ),
        ],
      ),
      trailing: const Icon(Icons.chevron_right),
      onTap: onTap,
    );
  }
}

/// 按任务标识监听最新记录，离开列表后仍实时呈现进度和保存回执。
class TransferTaskDetailScreen extends StatelessWidget {
  const TransferTaskDetailScreen({
    super.key,
    required this.controller,
    required this.taskId,
  });
  final TransferController controller;
  final String taskId;

  @override
  Widget build(BuildContext context) => Scaffold(
    key: const ValueKey('transfer-task-detail'),
    appBar: AppBar(title: const Text('任务详情')),
    body: SafeArea(
      top: false,
      child: AnimatedBuilder(
        animation: controller,
        builder: (context, _) {
          final task = controller.tasks
              .where((item) => item.id == taskId)
              .firstOrNull;
          if (task == null) {
            return const Center(child: Text('未找到这条传输记录'));
          }
          final receipt = task.data['receipt'];
          final relativePath = taskSaved(task) && receipt is Map
              ? receipt['relativePath']
              : null;
          final canAct = !controller.running && !controller.busy;
          return ListView(
            padding: const EdgeInsets.all(20),
            children: [
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  TransferThumbnail(task: task, size: 88),
                  const SizedBox(width: 16),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          task.filename,
                          style: Theme.of(
                            context,
                          ).textTheme.titleMedium?.copyWith(fontSize: 18),
                        ),
                        const SizedBox(height: 12),
                        Row(
                          children: [
                            Icon(
                              taskStatusIcon(task),
                              color: taskStatusColor(task),
                              size: 20,
                            ),
                            const SizedBox(width: 6),
                            Expanded(
                              child: Text(
                                taskStatus(task),
                                style: TextStyle(
                                  color: taskStatusColor(task),
                                  fontSize: 16,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ],
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 24),
              if (task.state != 'skipped') ...[
                Row(
                  children: [
                    Expanded(
                      child: Text(
                        '${byteLabel(task.offset)} / ${byteLabel(task.size)}',
                        style: const TextStyle(
                          fontSize: 16,
                          color: galleryMuted,
                        ),
                      ),
                    ),
                    Text(
                      '${(_progress(task) * 100).round()}%',
                      style: const TextStyle(fontSize: 16, color: galleryMuted),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                ClipRRect(
                  borderRadius: BorderRadius.circular(8),
                  child: LinearProgressIndicator(
                    value: _progress(task),
                    minHeight: 10,
                    color: taskSaved(task) ? galleryGreen : transferPending,
                    backgroundColor: gallerySelected,
                  ),
                ),
              ],
              if (taskStatus(task) == '等待电脑确认')
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    '文件已发送，电脑正在校验与保存。',
                    style: TextStyle(fontSize: 16, color: galleryMuted),
                  ),
                ),
              if (taskSaved(task))
                const Padding(
                  padding: EdgeInsets.only(top: 8),
                  child: Text(
                    '电脑已确认保存。',
                    style: TextStyle(fontSize: 16, color: galleryMuted),
                  ),
                ),
              if (task.state == 'skipped') const Text('电脑已发现相同原文件，本项已跳过。'),
              if (task.error.isNotEmpty) ...[
                const SizedBox(height: 16),
                SelectableText(
                  task.error,
                  style: TextStyle(
                    color: Theme.of(context).colorScheme.error,
                    fontSize: 16,
                  ),
                ),
              ],
              const Divider(height: 40),
              _DetailValue(label: '接收电脑', value: task.data['receiverName']),
              _DetailValue(label: '接收目录', value: task.data['libraryPath']),
              _DetailValue(label: '归档日期', value: task.data['archiveDate']),
              if (relativePath != null)
                _DetailValue(label: '已保存位置', value: relativePath),
              if (controller.notice.isNotEmpty &&
                  controller.notice != task.error) ...[
                const SizedBox(height: 16),
                Text(controller.notice),
              ],
              if (controller.busy) ...[
                const SizedBox(height: 16),
                const LinearProgressIndicator(),
              ],
              if (['failed', 'paused'].contains(task.state)) ...[
                const SizedBox(height: 24),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    FilledButton(
                      key: const ValueKey('transfer-task-retry'),
                      onPressed: canAct
                          ? () =>
                                controller.action(() => controller.retry(task))
                          : null,
                      child: Text(task.state == 'failed' ? '重试' : '继续传输'),
                    ),
                    const SizedBox(height: 8),
                    FilledButton(
                      key: const ValueKey('transfer-task-cancel'),
                      style: FilledButton.styleFrom(
                        backgroundColor: const Color(0xFFE9EDEC),
                        foregroundColor: galleryInk,
                      ),
                      onPressed: canAct
                          ? () =>
                                controller.action(() => controller.cancel(task))
                          : null,
                      child: const Text('取消任务'),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                const Text(
                  '只停止任务，手机原文件与已保存副本保留。',
                  style: TextStyle(fontSize: 12, color: galleryMuted),
                ),
              ],
              if (controller.running &&
                  task.receiverId == controller.connection?.id &&
                  ['queued', 'checking', 'uploading'].contains(task.state)) ...[
                const SizedBox(height: 24),
                FilledButton.icon(
                  style: FilledButton.styleFrom(
                    backgroundColor: const Color(0xFFE9EDEC),
                    foregroundColor: galleryInk,
                  ),
                  onPressed: controller.busy ? null : controller.pause,
                  icon: const Icon(Icons.pause),
                  label: const Text('暂停队列'),
                ),
              ],
            ],
          );
        },
      ),
    ),
  );
}

class _DetailValue extends StatelessWidget {
  const _DetailValue({required this.label, required this.value});
  final String label;
  final Object? value;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(bottom: 16),
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(label, style: const TextStyle(color: galleryMuted)),
        const SizedBox(height: 4),
        SelectableText(
          value?.toString() ?? '未记录',
          style: const TextStyle(fontSize: 16, color: galleryInk),
        ),
        const Divider(height: 24),
      ],
    ),
  );
}
