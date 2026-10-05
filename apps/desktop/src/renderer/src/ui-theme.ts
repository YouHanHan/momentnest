import type { GlobalThemeOverrides } from 'naive-ui'

/** 共用浅绿主题和紧凑尺寸，避免不同库组件各自使用默认样式。 */
export const uiTheme: GlobalThemeOverrides = {
  common: {
    primaryColor: '#3b755c', primaryColorHover: '#4c876d', primaryColorPressed: '#2c604a', primaryColorSuppl: '#3b755c',
    textColorBase: '#27332d', textColor1: '#27332d', textColor2: '#53685b', textColor3: '#78877e',
    borderColor: '#dce5df', borderRadius: '8px', borderRadiusSmall: '6px', fontSize: '13px', fontSizeSmall: '12px',
    heightSmall: '32px', heightMedium: '36px', fontFamily: '"Microsoft YaHei UI", "Microsoft YaHei", sans-serif',
    boxShadow2: '0 8px 28px rgba(23, 45, 34, .12)', boxShadow3: '0 20px 64px rgba(23, 45, 34, .18)'
  },
  DatePicker: { panelBorderRadius: '12px', itemBorderRadius: '6px', itemCellHeight: '30px' },
  Select: { peers: { InternalSelection: { borderRadius: '8px' }, InternalSelectMenu: { borderRadius: '10px', optionHeightSmall: '32px' } } },
  Popover: { borderRadius: '10px', padding: '8px' },
  Modal: { peers: { Dialog: { borderRadius: '12px' }, Card: { borderRadius: '12px' } } }
}
