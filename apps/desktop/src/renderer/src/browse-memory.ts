import type { MediaAsset, MediaPage } from '../../shared/family'

export interface BrowseSnapshot {
  media: MediaPage; page: number; babyId: string; growthMonth: string; resultFilter: string; matchScope: 'library' | 'all'; revision?: string
  candidateCount: number; matchCounts: { included: number; candidates: number }
  unconfirmedCount?: number
  filters: { search: string; kind: string; source: string; dateSource: string; personId: string; ungroupedFaces: boolean; from: string; to: string; order: 'asc' | 'desc' }
  collapsed: boolean; overrides: Map<string, boolean>; selected: Map<string, MediaAsset>; selectionMode: boolean; scroll: number; paginationDirty: boolean
}
const views = new Map<string, BrowseSnapshot>()
/** 仅在内存中保留最近的浏览上下文，切库使用独立键，不写入个人照片记录。 */
export function rememberBrowse(key: string, value: BrowseSnapshot): void {
  views.delete(key); views.set(key, value)
  while (views.size > 8) views.delete(views.keys().next().value!)
}
export function recallBrowse(key: string): BrowseSnapshot | undefined { return views.get(key) }
