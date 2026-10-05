import type { BabyProfile, MediaAsset } from '../../shared/family'

/** IPC 仅传普通领域数据，移除 Vue 响应式代理及嵌套引用。 */
export function plainData<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

/** 使用日历月与余天计算月龄，月末生日按当月最后一天计算。 */
export function calendarAge(birthday: string, dateText: string | null): { months: number; days: number; totalDays: number; text: string } | null {
  if (!dateText) return null
  const parse = (value: string) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
    const date = new Date(`${value}T00:00:00Z`)
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? date : null
  }
  const birth = parse(birthday), date = parse(dateText)
  if (!birth || !date || date < birth) return null
  let months = (date.getUTCFullYear() - birth.getUTCFullYear()) * 12 + date.getUTCMonth() - birth.getUTCMonth()
  const anniversary = (count: number) => new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + count, Math.min(birth.getUTCDate(), new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + count + 1, 0)).getUTCDate())))
  if (anniversary(months) > date) months--
  const days = Math.round((date.getTime() - anniversary(months).getTime()) / 86400000)
  return { months, days, totalDays: Math.round((date.getTime() - birth.getTime()) / 86400000), text: months ? `${months}个月${days ? `${days}天` : ''}` : `${days}天` }
}

/** 文件创建日期仅用于归档；确认实际拍摄日期后才用于宝宝月龄。 */
export function hasReliableDate(asset: MediaAsset, baby: BabyProfile): boolean {
  return asset.dateConfirmed && (asset.dateSource === 'capture' || asset.dateSource === 'manual') && calendarAge(baby.birthday, asset.date) !== null
}

export interface GrowthStamp { age: string; date: string }

/** 已归属宝宝且拍摄日期可靠的照片才显示成长文字，浏览时不生成文件。 */
export function growthStamp(asset: MediaAsset, baby: BabyProfile): GrowthStamp | null {
  if (asset.kind !== 'photo' || !asset.babyIds.includes(baby.id) || !hasReliableDate(asset, baby)) return null
  const age = calendarAge(baby.birthday, asset.date)!
  let text: string
  if (age.months === 0) text = `出生第 ${age.totalDays + 1} 天`
  else if (age.months % 12 === 0 && age.days === 0) text = `${age.months / 12} 岁啦`
  else text = [Math.floor(age.months / 12) ? `${Math.floor(age.months / 12)} 岁` : '', age.months % 12 ? `${age.months % 12} 个月` : '', age.days ? `${age.days} 天` : ''].filter(Boolean).join(' ')
  return { age: text, date: asset.date!.replaceAll('-', ' · ') }
}

export function monthRange(birthday: string, offset: number): { from: string; to: string } {
  const birth = new Date(`${birthday}T00:00:00Z`)
  const anniversary = (count: number) => new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + count, Math.min(birth.getUTCDate(), new Date(Date.UTC(birth.getUTCFullYear(), birth.getUTCMonth() + count + 1, 0)).getUTCDate())))
  const end = anniversary(offset + 1)
  end.setUTCDate(end.getUTCDate() - 1)
  return { from: anniversary(offset).toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) }
}
