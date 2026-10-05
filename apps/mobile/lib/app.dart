import 'package:flutter/material.dart';
import 'package:flutter_localizations/flutter_localizations.dart';

import 'home_screen.dart';
import 'gallery_style.dart';

/// 配置中文界面及两端一致的暖色主题。
class MomentNestApp extends StatelessWidget {
  const MomentNestApp({super.key, this.home = const HomeScreen()});
  final Widget home;

  @override
  Widget build(BuildContext context) {
    // V2 延续相册布局，使用中性近白与统一灰绿色操作色。
    final colors = ColorScheme.fromSeed(
      seedColor: galleryGreen,
      primary: galleryGreen,
      surface: galleryBackground,
      onSurface: galleryInk,
      error: const Color(0xFFE4583E),
    );
    return MaterialApp(
      title: '拾光匣',
      debugShowCheckedModeBanner: false,
      locale: const Locale('zh', 'CN'),
      supportedLocales: const [Locale('zh', 'CN')],
      localizationsDelegates: GlobalMaterialLocalizations.delegates,
      theme: ThemeData(
        colorScheme: colors,
        scaffoldBackgroundColor: galleryBackground,
        appBarTheme: const AppBarTheme(
          backgroundColor: galleryBackground,
          surfaceTintColor: Colors.transparent,
          centerTitle: false,
          titleTextStyle: TextStyle(color: galleryInk, fontSize: 22, fontWeight: FontWeight.w600),
        ),
        cardTheme: CardThemeData(elevation: 0, margin: EdgeInsets.zero, color: gallerySelected, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8))),
        filledButtonTheme: FilledButtonThemeData(style: FilledButton.styleFrom(minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)))),
        outlinedButtonTheme: OutlinedButtonThemeData(style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(8)))),
        dividerTheme: const DividerThemeData(color: Color(0xFFE6EBE7), thickness: 1),
        navigationBarTheme: NavigationBarThemeData(
          height: 68,
          backgroundColor: galleryBackground,
          indicatorColor: Colors.transparent,
          labelTextStyle: WidgetStateProperty.resolveWith((states) => TextStyle(fontSize: 12, fontWeight: FontWeight.w500, color: states.contains(WidgetState.selected) ? galleryGreen : galleryMuted)),
        ),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}
