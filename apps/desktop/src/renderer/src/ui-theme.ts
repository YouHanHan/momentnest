import type { GlobalThemeOverrides } from 'naive-ui'
import { themePalette as palette } from '../../shared/theme-palette'

/** 共用浅绿主题和紧凑尺寸，避免不同库组件各自使用默认样式。 */
// 当前配色统一读取粉暖色板，保留组件原有紧凑尺寸。
export const uiTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: palette['primary-text'], primaryColorHover: palette['on-primary'], primaryColorPressed: palette['on-primary'], primaryColorSuppl: palette['primary-text'],
    textColorBase: palette.ink, textColor1: palette.ink, textColor2: palette.secondary, textColor3: palette.muted,
    bodyColor: palette.background, cardColor: palette.surface, modalColor: palette.surface, popoverColor: palette.surface, inputColor: palette.surface,
    tableColor: palette.surface, actionColor: palette.raised, hoverColor: palette.selected,
    errorColor: palette.error, warningColor: palette.warning,
    borderColor: palette.line, dividerColor: palette.line, borderRadius: '12px', borderRadiusSmall: '10px', fontSize: '13px', fontSizeSmall: '12px',
    heightSmall: '32px', heightMedium: '36px', fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    boxShadow2: '0 6px 24px rgba(117, 105, 98, .08)', boxShadow3: '0 16px 48px rgba(117, 105, 98, .12)'
  },
  Checkbox: { colorChecked: palette.primary, checkMarkColor: palette['on-primary'], borderChecked: `1px solid ${palette.accent}` },
  Switch: { railColorActive: palette.primary, buttonBoxShadow: '0 1px 3px rgba(117, 105, 98, .18)' },
  DatePicker: { panelBorderRadius: '12px', itemBorderRadius: '6px', itemCellHeight: '30px' },
  Select: { peers: { InternalSelection: { borderRadius: '10px' }, InternalSelectMenu: { borderRadius: '12px', optionHeightSmall: '32px' } } },
  Popover: { borderRadius: '10px', padding: '8px' },
  Modal: { peers: { Dialog: { borderRadius: '18px' }, Card: { borderRadius: '18px' } } }
}
