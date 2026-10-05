import test from 'node:test'
import assert from 'node:assert/strict'
import type { BabyProfile, MediaAsset } from '../src/shared/family.ts'
import { growthStamp } from '../src/renderer/src/family-ui.ts'

const baby = { id: 'baby-one', birthday: '2024-08-05' } as BabyProfile
const photo = { kind: 'photo', babyIds: [baby.id], date: '2024-08-13', dateSource: 'capture', dateConfirmed: true } as MediaAsset

test('查看成长水印按真实拍摄日计算出生天数、月龄和周年', () => {
  for (const [date, age] of [
    ['2024-08-05', '出生第 1 天'], ['2024-08-12', '出生第 8 天'],
    ['2025-02-08', '6 个月 3 天'], ['2025-08-05', '1 岁啦'],
    ['2026-09-07', '2 岁 1 个月 2 天'],
  ]) assert.deepEqual(growthStamp({ ...photo, date }, baby), { age, date: date.replaceAll('-', ' · ') })
})

test('查看成长水印保留月底和闰日生日的日历边界', () => {
  assert.equal(growthStamp({ ...photo, date: '2024-02-29' }, { ...baby, birthday: '2024-01-31' })?.age, '1 个月')
  assert.equal(growthStamp({ ...photo, date: '2025-02-28' }, { ...baby, birthday: '2024-02-29' })?.age, '1 岁啦')
})

test('视频、未归属和未确认拍摄日期不能显示确定的成长水印', () => {
  for (const invalid of [
    { kind: 'video' }, { babyIds: [] }, { babyIds: ['other-baby'] },
    { dateConfirmed: false }, { dateSource: 'creation' }, { dateSource: 'unknown' },
    { date: null }, { date: '2024-08-04' }, { date: '2024-02-31' },
  ]) assert.equal(growthStamp({ ...photo, ...invalid } as MediaAsset, baby), null)
  assert.equal(growthStamp(photo, { ...baby, birthday: 'invalid' }), null)
})
