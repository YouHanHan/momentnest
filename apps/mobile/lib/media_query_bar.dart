import 'dart:async';
import 'package:flutter/material.dart';

/// 两个相册共用搜索、日期排序和收藏入口，输入停顿后再查询。
class MediaQueryBar extends StatefulWidget {
  const MediaQueryBar({
    super.key,
    required this.prefix,
    required this.search,
    required this.oldestFirst,
    required this.favoritesOnly,
    required this.onSearch,
    required this.onOrder,
    this.onFavorites,
    this.showFavorites = true,
    this.leading,
  });
  final String prefix, search;
  final bool oldestFirst, favoritesOnly;
  final ValueChanged<String> onSearch;
  final ValueChanged<bool> onOrder;
  final ValueChanged<bool>? onFavorites;
  final bool showFavorites;
  final Widget? leading;

  @override
  State<MediaQueryBar> createState() => _MediaQueryBarState();
}

class _MediaQueryBarState extends State<MediaQueryBar> {
  late final input = TextEditingController(text: widget.search);
  Timer? debounce;
  late bool expanded = widget.search.isNotEmpty;

  @override
  void didUpdateWidget(covariant MediaQueryBar oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.search != widget.search &&
        input.text.trim() != widget.search) {
      debounce?.cancel();
      input.text = widget.search;
    }
  }

  void changed(String value) {
    setState(() {});
    debounce?.cancel();
    debounce = Timer(
      const Duration(milliseconds: 300),
      () => widget.onSearch(value),
    );
  }

  @override
  void dispose() {
    debounce?.cancel();
    input.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 0, 12, 0),
    child: Column(
      children: [
        if (expanded)
          TextField(
            key: ValueKey('${widget.prefix}-search'),
            controller: input,
            maxLength: 200,
            decoration: InputDecoration(
              hintText: '搜索文件名',
              counterText: '',
              isDense: true,
              prefixIcon: const Icon(Icons.search, size: 20),
              suffixIcon: input.text.isEmpty
                  ? null
                  : IconButton(
                      tooltip: '清空搜索',
                      onPressed: () {
                        debounce?.cancel();
                        input.clear();
                        setState(() {});
                        widget.onSearch('');
                      },
                      icon: const Icon(Icons.close, size: 18),
                    ),
            ),
            onChanged: changed,
            onSubmitted: (value) {
              debounce?.cancel();
              widget.onSearch(value);
            },
          ),
        Row(
          children: [
            if (widget.leading != null)
              Expanded(child: widget.leading!)
            else
              const Spacer(),
            IconButton(
              key: ValueKey('${widget.prefix}-open-search'),
              visualDensity: VisualDensity.compact,
              tooltip: expanded ? '收起搜索' : '搜索文件名',
              onPressed: () {
                if (expanded) {
                  debounce?.cancel();
                  input.clear();
                  widget.onSearch('');
                }
                setState(() => expanded = !expanded);
              },
              icon: Icon(expanded ? Icons.search_off : Icons.search),
            ),
            if (widget.showFavorites)
              IconButton(
                key: ValueKey('${widget.prefix}-favorites'),
                visualDensity: VisualDensity.compact,
                tooltip: widget.favoritesOnly ? '显示全部媒体' : '只看收藏',
                isSelected: widget.favoritesOnly,
                icon: const Icon(Icons.favorite_outline),
                selectedIcon: const Icon(Icons.favorite),
                onPressed: widget.onFavorites == null
                    ? null
                    : () => widget.onFavorites!(!widget.favoritesOnly),
              ),
            PopupMenuButton<bool>(
              key: ValueKey('${widget.prefix}-sort'),
              tooltip: '日期排序',
              initialValue: widget.oldestFirst,
              onSelected: widget.onOrder,
              itemBuilder: (_) => const [
                PopupMenuItem(value: false, child: Text('最新在前')),
                PopupMenuItem(value: true, child: Text('最早在前')),
              ],
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 8),
                child: Row(
                  children: [
                    Text(widget.oldestFirst ? '最早在前' : '最新在前'),
                    const Icon(Icons.expand_more, size: 18),
                  ],
                ),
              ),
            ),
          ],
        ),
      ],
    ),
  );
}
