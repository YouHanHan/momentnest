import type { DesktopApi } from '../../shared/desktop-api'

declare global {
  interface Window {
    momentnest?: DesktopApi
  }
}

export {}
