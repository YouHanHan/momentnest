import type { DesktopApi } from '../../shared/desktop-api'

declare global {
  interface Window {
    jinchuan?: DesktopApi
  }
}

export {}
