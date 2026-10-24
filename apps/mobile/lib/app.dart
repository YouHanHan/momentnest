import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
    // 当前统一为奶油白和柔粉色，预览画布继续使用独立的深色背景。
    // A 方案使用浅杏桃按钮、暖灰文字与浅奶油预览画布。
    final colors = ColorScheme.fromSeed(
      brightness: Brightness.light,
      seedColor: galleryAccent,
      primary: galleryAccent,
      onPrimary: Colors.white,
      primaryContainer: gallerySelected,
      onPrimaryContainer: galleryAccentPressed,
      secondary: galleryAccent,
      secondaryContainer: galleryPeach,
      onSecondaryContainer: galleryInk,
      surface: galleryBackground,
      onSurface: galleryInk,
      onSurfaceVariant: galleryMuted,
      surfaceContainerLowest: gallerySurface,
      surfaceContainerLow: galleryBackground,
      surfaceContainer: gallerySelected,
      surfaceContainerHigh: gallerySelected,
      surfaceContainerHighest: galleryLine,
      outline: galleryMuted,
      outlineVariant: galleryLine,
      error: galleryError,
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
          systemOverlayStyle: SystemUiOverlayStyle.dark,
          centerTitle: false,
          titleTextStyle: TextStyle(color: galleryInk, fontSize: 22, fontWeight: FontWeight.w600),
        ),
        cardTheme: CardThemeData(
          elevation: 0,
          margin: EdgeInsets.zero,
          color: gallerySurface,
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(16), side: const BorderSide(color: galleryLine)),
        ),
        filledButtonTheme: FilledButtonThemeData(
          style: FilledButton.styleFrom(backgroundColor: galleryPrimary, foregroundColor: galleryOnPrimary, minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
        ),
        outlinedButtonTheme: OutlinedButtonThemeData(
          style: OutlinedButton.styleFrom(foregroundColor: galleryAccent, side: const BorderSide(color: galleryLine), minimumSize: const Size(48, 48), shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
        ),
        textButtonTheme: TextButtonThemeData(
          style: TextButton.styleFrom(foregroundColor: galleryAccent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(12))),
        ),
        inputDecorationTheme: InputDecorationTheme(
          filled: true,
          fillColor: gallerySurface,
          contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
          border: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: galleryLine)),
          enabledBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: galleryLine)),
          focusedBorder: OutlineInputBorder(borderRadius: BorderRadius.circular(12), borderSide: const BorderSide(color: galleryAccentIndicator, width: 1.5)),
        ),
        checkboxTheme: CheckboxThemeData(
          fillColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? galleryPrimary : gallerySurface),
          checkColor: const WidgetStatePropertyAll(galleryOnPrimary),
          side: const BorderSide(color: galleryAccentIndicator, width: 1.5),
          shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(5)),
        ),
        switchTheme: SwitchThemeData(
          trackColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? galleryPrimary : galleryLine),
          thumbColor: const WidgetStatePropertyAll(gallerySurface),
          trackOutlineColor: WidgetStateProperty.resolveWith((states) => states.contains(WidgetState.selected) ? galleryAccentIndicator : galleryLine),
        ),
        dividerTheme: const DividerThemeData(color: galleryLine, thickness: 1),
        dialogTheme: DialogThemeData(backgroundColor: gallerySurface, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(20))),
        bottomSheetTheme: const BottomSheetThemeData(backgroundColor: gallerySurface, modalBackgroundColor: gallerySurface, surfaceTintColor: Colors.transparent, shape: RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(22)))),
        popupMenuTheme: PopupMenuThemeData(color: gallerySurface, surfaceTintColor: Colors.transparent, elevation: 4, shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14))),
        progressIndicatorTheme: const ProgressIndicatorThemeData(color: galleryAccentIndicator, linearTrackColor: gallerySelected),
        navigationBarTheme: NavigationBarThemeData(
          height: 68,
          backgroundColor: galleryBackground,
          indicatorColor: gallerySelected,
          indicatorShape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(18)),
          labelTextStyle: WidgetStateProperty.resolveWith((states) => TextStyle(fontSize: 12, fontWeight: states.contains(WidgetState.selected) ? FontWeight.w600 : FontWeight.w400, color: states.contains(WidgetState.selected) ? galleryAccent : galleryMuted)),
        ),
        useMaterial3: true,
      ),
      home: home,
    );
  }
}
