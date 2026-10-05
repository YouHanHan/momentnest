import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import exifr from 'exifr'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import { babyAge, growthAgeText, readMetadata, watermarkExport, watermarkOverlay, watermarkPreview, watermarkText } from '../src/service/media-tools.ts'
import { watermark } from '../src/main/family-validation.ts'
import type { BabyProfile, MediaAsset, WatermarkOptions } from '../src/shared/family.ts'

const baby: BabyProfile = { id: 'growth-baby', name: '小宝', birthday: '2024-08-05', autoMatch: false, referenceFaces: [], updatedAt: '2026-01-01T00:00:00Z' }
const options: WatermarkOptions = { babyId: baby.id, position: 'bottom-left', fontSize: 48, color: '#ffffff', opacity: 1, showName: false, showAge: true, showDayCount: false, showDate: true, template: 'growth', growthMode: 'auto', shade: false }
const digest = (data: Buffer) => createHash('sha256').update(data).digest('hex')

test('成长文字按日历边界切换，新生儿第1天、整月、周年与长期天数一致', () => {
  for (const [birthday, date, expected] of [
    ['2024-08-05', '2024-08-05', '出生第 1 天'],
    ['2024-08-05', '2024-08-12', '出生第 8 天'],
    ['2024-08-05', '2024-09-04', '出生第 31 天'],
    ['2024-08-05', '2024-09-05', '1 个月'],
    ['2024-08-05', '2025-02-08', '6 个月 3 天'],
    ['2024-08-05', '2025-08-05', '1 岁啦'],
    ['2024-08-05', '2025-08-06', '1 岁 1 天'],
    ['2024-08-05', '2025-10-08', '1 岁 2 个月 3 天'],
    ['2024-08-05', '2026-08-05', '2 岁啦'],
    ['2024-01-31', '2024-02-29', '1 个月'],
    ['2024-01-31', '2024-03-01', '1 个月 1 天'],
    ['2024-02-29', '2025-02-28', '1 岁啦'],
    ['2024-02-29', '2025-03-01', '1 岁 1 天'],
  ]) assert.equal(growthAgeText(birthday, date), expected)
  const age = babyAge(baby.birthday, '2025-02-08')
  assert.equal(growthAgeText(baby.birthday, '2025-02-08', 'day-count'), `出生第 ${age.totalDays + 1} 天`)
  assert.throws(() => growthAgeText('2024-08-05', '2024-08-04'), /早于/)
  assert.throws(() => growthAgeText('2024-08-05', '2025-02-29'), /确认/)
})

test('成长模板两行显示且保留旧模板文本，内容开关与姓名分别生效', () => {
  assert.equal(watermarkText(baby, '2024-08-12', options), '出生第 8 天\n2024 · 08 · 12')
  assert.equal(watermarkText(baby, '2025-02-08', { ...options, showName: true }), '小宝 · 6 个月 3 天\n2025 · 02 · 08')
  assert.equal(watermarkText(baby, '2025-02-08', { ...options, growthMode: 'day-count' }), `出生第 ${babyAge(baby.birthday, '2025-02-08').totalDays + 1} 天\n2025 · 02 · 08`)
  assert.equal(watermarkText(baby, '2024-08-12', { ...options, showDate: false }), '出生第 8 天')
  assert.equal(watermarkText(baby, '2024-08-12', { ...options, showAge: false }), '\n2024 · 08 · 12')
  assert.equal(watermarkText(baby, '2024-08-12', { ...options, template: undefined }), '0 个月 7 天 · 2024-08-12')
  assert.equal(watermarkText(baby, '2024-08-12', { ...options, template: 'classic' }), '0 个月 7 天 · 2024-08-12')
  assert.throws(() => watermarkText(baby, '2024-08-12', { ...options, showAge: false, showDate: false }), /至少/)
})

test('成长 IPC 新参数只接受明确枚举与布尔值，旧请求没有新默认字段', () => {
  assert.deepEqual(watermark(options), options)
  const { template: _template, growthMode: _mode, shade: _shade, ...classic } = options
  assert.deepEqual(watermark(classic), classic)
  for (const template of ['custom', '', null, true, {}, 1]) assert.throws(() => watermark({ ...options, template }), /选项/)
  for (const growthMode of ['month', '', null, true, {}, 1]) assert.throws(() => watermark({ ...options, growthMode }), /选项/)
  for (const shade of ['true', null, 0, 1, {}]) assert.throws(() => watermark({ ...options, shade }), /开关/)
})

test('实际字形主行与日期分开、日期更小，四角和极窄图片完整适配且暗底局部可选', async () => {
  const text = watermarkText(baby, '2024-08-12', options), stamp = await watermarkOverlay(text, options, 1000, 1000)
  const { data, info } = await sharp(stamp.buffer).extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  const ranges: number[] = []
  let block = 0
  for (let row = 0; row <= info.height; row++) {
    const active = row < info.height && data.subarray(row * info.width, (row + 1) * info.width).some(value => value > 0)
    if (active) block++
    else if (block) { ranges.push(block); block = 0 }
  }
  assert.equal(ranges.length, 2, '标题与日期应各有一段可见字形')
  assert.ok(ranges[0] > ranges[1], '日期字形高度应低于主标题')
  assert.equal(stamp.left, 40, '短边 1000 时左边距应为 4%')
  assert.ok(info.height < 150, '水印应只占照片小部分高度')
  for (const [width, height] of [[1000, 1400], [1400, 1000], [32, 16], [16, 256], [1, 1]]) {
    for (const position of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
      for (const shade of [false, true]) {
        const value = await watermarkOverlay(text, { ...options, position, shade }, width, height), metadata = await sharp(value.buffer).metadata()
        assert.ok(value.left >= 0 && value.top >= 0)
        assert.ok(value.left + metadata.width! <= width && value.top + metadata.height! <= height)
        await sharp({ create: { width, height, channels: 3, background: '#fafafa' } }).composite([{ input: value.buffer, left: value.left, top: value.top }]).png().toBuffer()
      }
    }
  }
  const shaded = await watermarkOverlay(text, { ...options, shade: true }, 1000, 1000)
  const alpha = (buffer: Buffer) => sharp(buffer).extractChannel('alpha').raw().toBuffer().then(bytes => bytes.reduce((total, value) => total + value, 0))
  assert.ok(await alpha(shaded.buffer) > await alpha(stamp.buffer), '开启暗底应增加局部可见背景')
  assert.ok((await sharp(shaded.buffer).metadata()).height! < 200)
  const shadedPixels = await sharp(shaded.buffer).extractChannel('alpha').raw().toBuffer({ resolveWithObject: true })
  for (let row = 0; row < shadedPixels.info.height; row++) {
    assert.equal(shadedPixels.data[row * shadedPixels.info.width], 0, '羽化暗底左边缘必须完全透明')
    assert.equal(shadedPixels.data[(row + 1) * shadedPixels.info.width - 1], 0, '羽化暗底右边缘必须完全透明')
  }
  assert.ok(shadedPixels.data.subarray(0, shadedPixels.info.width).every(value => value === 0), '羽化暗底上边缘必须完全透明')
  assert.ok(shadedPixels.data.subarray((shadedPixels.info.height - 1) * shadedPixels.info.width).every(value => value === 0), '羽化暗底下边缘必须完全透明')
  const offsetX = stamp.left - shaded.left, offsetY = stamp.top - shaded.top
  for (let row = 0; row < shadedPixels.info.height; row++) for (let column = 0; column < shadedPixels.info.width; column++) {
    const originalRow = row - offsetY, originalColumn = column - offsetX
    const previousAlpha = originalRow >= 0 && originalRow < info.height && originalColumn >= 0 && originalColumn < info.width ? data[originalRow * info.width + originalColumn] : 0
    assert.ok(shadedPixels.data[row * shadedPixels.info.width + column] - previousAlpha <= Math.ceil(255 * 0.22), '暗底新增透明度不能超过 22%')
  }
  const escaped = await watermarkOverlay(watermarkText({ ...baby, name: '<小宝&家人>' }, '2024-08-12', { ...options, showName: true }), options, 512, 512)
  assert.ok(escaped.buffer.length > 0, '姓名必须以纯文字安全渲染')
})

test('成长预览与导出保持相同像素布局、EXIF朝向与完整分辨率，源图片字节保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-growth-image-')), original = join(directory, 'original.jpg'), output = join(directory, 'copy.jpg')
  await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#c8bcae' } }).withMetadata({ orientation: 6 }).jpeg({ quality: 95 }).toFile(original)
  const before = digest(await readFile(original)), text = watermarkText(baby, '2024-08-12', options)
  const preview = await watermarkPreview(original, 'photo', text, { ...options, shade: true }, directory)
  await watermarkExport(original, 'photo', text, { ...options, shade: true }, output, directory)
  const exported = await readFile(output), previewMetadata = await sharp(preview).metadata(), exportMetadata = await sharp(exported).metadata()
  assert.deepEqual([previewMetadata.width, previewMetadata.height], [800, 1000])
  assert.deepEqual([exportMetadata.width, exportMetadata.height], [800, 1000])
  assert.equal(exportMetadata.orientation, undefined, '旋正输出不应遗留使其二次旋转的方向标记')
  assert.equal(digest(await readFile(original)), before)
  const previewPixels = await sharp(preview).removeAlpha().raw().toBuffer(), exportPixels = await sharp(exported).removeAlpha().raw().toBuffer()
  let difference = 0
  for (let index = 0; index < previewPixels.length; index++) difference += Math.abs(previewPixels[index] - exportPixels[index])
  assert.ok(difference / previewPixels.length < 2, '两者只能有 JPEG 质量差异，排版不能漂移')
  const large = join(directory, 'large.jpg'), largeCopy = join(directory, 'large-copy.jpg')
  await sharp({ create: { width: 1600, height: 2400, channels: 3, background: '#445566' } }).jpeg().toFile(large)
  await watermarkExport(large, 'photo', text, options, largeCopy, directory)
  assert.deepEqual([(await sharp(largeCopy).metadata()).width, (await sharp(largeCopy).metadata()).height], [1600, 2400])
})

test('成长副本保存最终确认拍摄日，再读取不变成创建日且不复制定位、设备或旧方向', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-growth-date-')), original = join(directory, 'original.jpg'), output = join(directory, 'copy.jpg')
  await sharp({ create: { width: 1000, height: 800, channels: 3, background: '#c8bcae' } }).withExif({
    IFD0: { Make: 'Private camera' },
    IFD2: { DateTimeOriginal: '2024:08:12 10:20:00' },
    IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '1/1 2/1 3/1', GPSLongitudeRef: 'E', GPSLongitude: '4/1 5/1 6/1' },
  }).withMetadata({ orientation: 6 }).jpeg().toFile(original)
  const before = digest(await readFile(original)), sourceTags = await exifr.parse(original)
  assert.ok(sourceTags.GPSLatitude && sourceTags.GPSLongitude, '合成源照片应包含定位数据，隐私检查才有效')
  assert.equal((await readMetadata(original, 'photo')).captureDate, '2024-08-12')
  const confirmed = '2024-08-13', style = { ...options, showDate: false }
  await watermarkExport(original, 'photo', watermarkText(baby, confirmed, style), style, output, directory, confirmed)
  const metadata = await readMetadata(output, 'photo'), tags = await exifr.parse(output)
  assert.equal(metadata.captureDate, confirmed, '已确认日期应优先于原图 EXIF，隐藏水印日期也要保留真实拍摄日')
  assert.equal(metadata.date, confirmed)
  assert.equal(metadata.dateSource, 'capture', '副本再次索引应按确认拍摄月归类')
  assert.deepEqual([metadata.width, metadata.height], [800, 1000], '旋正后的副本不能因旧方向再旋转')
  assert.notEqual((await sharp(output).metadata()).orientation, 6)
  for (const field of ['GPSLatitude', 'GPSLongitude', 'latitude', 'longitude', 'Make']) assert.equal(tags[field], undefined, `${field} 不得从源照片复制`)
  assert.equal(digest(await readFile(original)), before)
  await assert.rejects(watermarkExport(original, 'photo', '日期', options, join(directory, 'invalid.jpg'), directory, '2025-02-29'), /确认拍摄日期/)
})

/** 使用合成媒体建立真实保存位置，不依赖个人照片或人脸模型。 */
async function catalogFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-growth-batch-')), library = join(directory, 'library'), other = join(directory, 'other'), output = join(directory, 'output')
  await Promise.all([library, other, output].map(path => mkdir(path)))
  const store = new Store(join(directory, 'records.sqlite')), assets: MediaAsset[] = []
  store.put('library', { id: 'library-one', path: library, name: '一号库', enabled: true })
  store.put('library', { id: 'library-two', path: other, name: '二号库', enabled: true })
  async function seed(name: string, settings: { date?: string | null; confirmed?: boolean; source?: 'capture' | 'creation' | 'manual' | 'unknown'; included?: boolean; missing?: boolean; corrupt?: boolean; kind?: 'photo' | 'video'; outside?: boolean } = {}) {
    const path = join(settings.outside ? other : library, name), bytes = settings.corrupt ? Buffer.from('not a photo') : await sharp({ create: { width: 400, height: 300, channels: 3, background: `#${digest(Buffer.from(name)).slice(0, 6)}` } }).jpeg().toBuffer()
    if (!settings.missing) await writeFile(path, bytes)
    const hash = digest(bytes), size = bytes.length, id = `${hash}-${size}`, date = settings.date === undefined ? '2024-08-12' : settings.date
    const asset = { id, hash, size, filename: name, kind: settings.kind ?? 'photo', date, dateSource: settings.source ?? 'capture', dateConfirmed: settings.confirmed ?? true, captureDate: settings.source === 'creation' ? null : date, creationDate: '2024-08-12', width: 400, height: 300, duration: 0, available: true, locations: [{ id: randomUUID(), path, relativePath: name, mtime: settings.missing ? 0 : (await stat(path)).mtimeMs, libraryId: settings.outside ? 'library-two' : 'library-one', source: 'folder' as const, label: '合成库', available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'pending' as const, updatedAt: new Date().toISOString() }
    store.put('familyAsset', asset)
    if (settings.included !== false) store.put('familyDecision', { id: `${baby.id}:${id}`, babyId: baby.id, assetId: id, state: 'included', origin: 'manual', updatedAt: new Date().toISOString() })
    assets.push(asset)
    return asset
  }
  const good = await seed('可用一.jpg'), pending = await seed('创建日.jpg', { confirmed: false, source: 'creation' }), excluded = await seed('未归属.jpg', { included: false }), missing = await seed('离线.jpg', { missing: true }), corrupt = await seed('损坏.jpg', { corrupt: true }), second = await seed('可用二.jpg'), beforeBirth = await seed('出生前.jpg', { date: '2024-08-04' }), outside = await seed('另一库.jpg', { outside: true }), video = await seed('video.mp4', { kind: 'video' })
  const catalog = new MediaCatalog(store, directory, 'test-receiver', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { assert.fail('水印不能启动人物识别') } })
  catalog.saveBaby(baby)
  return { directory, store, catalog, library, output, good, pending, excluded, missing, corrupt, second, beforeBirth, outside, video }
}

test('批量成长水印逐张跳过不可靠日期、未归属、不可用、损坏及出生前照片，继续导出其余并保留失败副本', async () => {
  const setup = await catalogFixture(), { catalog, store, output, good, pending, excluded, missing, corrupt, second, beforeBirth } = setup
  try {
    const originals = await Promise.all([good, pending, excluded, corrupt, second, beforeBirth].map(async asset => ({ path: asset.locations[0].path, hash: digest(await readFile(asset.locations[0].path)) })))
    const results = await catalog.exportWatermark([good, pending, excluded, missing, corrupt, second, beforeBirth].map(asset => asset.id), options, output, 'library-one')
    assert.equal(results.length, 7)
    assert.deepEqual(results.filter(item => !item.error).map(item => item.assetId), [good.id, second.id])
    assert.match(results.find(item => item.assetId === pending.id)!.error!, /确认拍摄日期/)
    assert.match(results.find(item => item.assetId === excluded.id)!.error!, /属于该宝宝/)
    assert.match(results.find(item => item.assetId === missing.id)!.error!, /目录不可用/)
    assert.ok(results.find(item => item.assetId === corrupt.id)!.error)
    assert.match(results.find(item => item.assetId === beforeBirth.id)!.error!, /早于/)
    assert.equal(results.find(item => item.assetId === pending.id)!.filename, pending.filename)
    assert.equal(store.list('familyExport').length, 2, '失败副本不得记录为成功导出')
    for (const item of results.filter(item => !item.error)) {
      assert.ok(item.path); assert.ok((await stat(item.path!)).size > 0); assert.match(item.filename, /_成长_/)
      const metadata = await readMetadata(item.path!, 'photo')
      assert.equal(metadata.date, '2024-08-12', '无源 EXIF 的照片也应保存已确认拍摄日')
      assert.equal(metadata.dateSource, 'capture')
    }
    const failed = results.find(item => item.assetId === corrupt.id)!
    assert.ok(failed.path && (await stat(failed.path)).isFile(), '已建立但编码失败的副本不得自动删除')
    assert.equal((await readdir(output)).length, 3)
    for (const item of originals) assert.equal(digest(await readFile(item.path)), item.hash)
    catalog.setMediaDate(pending.id, '2024-08-13')
    const corrected = (await catalog.exportWatermark([pending.id], options, output, 'library-one'))[0]
    assert.ok(corrected.path)
    assert.equal((await readMetadata(corrected.path!, 'photo')).captureDate, '2024-08-13', '人工确认的拍摄日必须传入实际副本')
  } finally { await catalog.close(); store.close() }
})

test('成长批量参数、跨库和视频整批拒绝，目标无效不产生副本，单张不自动确认日期或归属', async () => {
  const setup = await catalogFixture(), { catalog, store, output, directory, good, pending, excluded, outside, video } = setup
  try {
    for (const overrides of [{ template: 'custom' }, { growthMode: 'custom' }, { shade: 'true' }, { showAge: 'true' }, { fontSize: 48.5 }, { showAge: false, showDate: false }]) {
      await assert.rejects(catalog.exportWatermark([good.id], { ...options, ...overrides } as WatermarkOptions, output, 'library-one'))
    }
    await assert.rejects(catalog.exportWatermark([good.id, outside.id], options, output, 'library-one'), /不都在当前/)
    await assert.rejects(catalog.exportWatermark([good.id, video.id], options, output, 'library-one'), /仅导出照片/)
    await assert.rejects(catalog.previewWatermark(video.id, options, 'library-one'), /仅支持照片/)
    await assert.rejects(catalog.exportWatermark([good.id], options, join(directory, 'missing-output'), 'library-one'))
    await assert.rejects(catalog.exportWatermark(['../../outside'], options, output, 'library-one'), /媒体标识/)
    await assert.rejects(catalog.previewWatermark(pending.id, options, 'library-one'), /确认拍摄日期/)
    await assert.rejects(catalog.previewWatermark(excluded.id, options, 'library-one'), /属于该宝宝/)
    assert.equal((await readdir(output)).length, 0)
    assert.equal(store.list('familyExport').length, 0)
    assert.equal(catalog.queryMedia({ libraryId: 'library-one' }).items.find(asset => asset.id === pending.id)!.dateConfirmed, false)
    assert.equal(catalog.queryMedia({ babyId: baby.id, libraryId: 'library-one' }).items.some(asset => asset.id === excluded.id), false)
  } finally { await catalog.close(); store.close() }
})
