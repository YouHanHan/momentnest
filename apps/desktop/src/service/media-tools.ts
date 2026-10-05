import { execFile } from 'node:child_process'
import { createRequire } from 'node:module'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import sharp from 'sharp'
import exifr from 'exifr'
import type { Exifr } from 'exifr'
import ffmpegPath from 'ffmpeg-static'
import { webpExif } from './media-content.ts'
import { localDate, requireValue, validDate } from './files.ts'
import type { BabyProfile, DateSource, MediaKind, WatermarkOptions } from '../shared/family.ts'

// 避免 Windows 文件句柄缓存锁住已读照片，保留正常编辑和再次索引能力。
sharp.cache({ files: 0 })

const require = createRequire(typeof __filename === 'string' ? __filename : import.meta.url)
const ffprobePath: string = require('ffprobe-static').path
const ExifReader = exifr.Exifr as unknown as typeof Exifr
type ClosableExifReader = Exifr & { file?: { close?(): Promise<void> | void } }
export interface MediaMetadata {
  captureDate: string | null; creationDate: string | null; date: string | null
  dateSource: DateSource; width: number; height: number; duration: number
}

/** 保留元数据表达的自然日，不把无时区拍摄日期转换到电脑时区。 */
export function metadataDate(value: unknown): string | null {
  if (typeof value === 'string') {
    const date = value.slice(0, 10).replaceAll(':', '-')
    return validDate(date) ? date : null
  }
  if (value instanceof Date && Number.isFinite(value.getTime())) return localDate(value)
  return null
}

/** 运行随应用分发的媒体工具，始终使用参数数组，禁止拼接 shell 命令。 */
async function run(binary: string | null, args: string[], timeout = 120000): Promise<Buffer> {
  requireValue(binary, '本地媒体工具不可用，请检查应用安装。')
  return new Promise((resolve, reject) => {
    execFile(binary, args, { windowsHide: true, timeout, maxBuffer: 8 * 1024 ** 2, encoding: 'buffer' }, (error, stdout, stderr) => {
      if (error) reject(new Error(`媒体处理失败：${String(stderr).slice(-300) || error.message}`))
      else resolve(stdout)
    })
  })
}

/** 在复制前读取拍摄日和源文件创建日；解码不支持时仍允许原字节备份。 */
export async function readMetadata(path: string, kind: MediaKind, suppliedCapture?: string | null, suppliedCreation?: string | null): Promise<MediaMetadata> {
  const info = await stat(path)
  const creationDate = suppliedCreation === null ? null : validDate(suppliedCreation) ? suppliedCreation : info.birthtimeMs > 0 ? localDate(info.birthtime) : null
  let captureDate: string | null = null, width = 0, height = 0, duration = 0
  if (kind === 'photo') {
    const reader = new ExifReader({ pick: ['DateTimeOriginal', 'CreateDate'], reviveValues: false }) as ClosableExifReader
    try {
      await reader.read(await webpExif(path) ?? path)
      const tags = await reader.parse()
      captureDate = metadataDate(tags?.DateTimeOriginal) ?? metadataDate(tags?.CreateDate)
    } catch { /* 没有可解析 EXIF 时使用明确的源文件创建日。 */ }
    finally {
      // 截断或损坏的图片头可能让第三方解析提前退出，始终显式释放分块读取句柄。
      await reader.file?.close?.()
    }
    try {
      const metadata = await sharp(path, { failOn: 'none' }).metadata()
      const rotated = metadata.orientation === 6 || metadata.orientation === 8
      width = (rotated ? metadata.height : metadata.width) ?? 0
      height = (rotated ? metadata.width : metadata.height) ?? 0
    } catch { /* 原文件可保存，预览格式限制单独提示。 */ }
  } else {
    try {
      const metadata = JSON.parse((await run(ffprobePath, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', path], 20000)).toString())
      const stream = metadata.streams?.find((item: { codec_type: string }) => item.codec_type === 'video')
      width = Number(stream?.width) || 0; height = Number(stream?.height) || 0
      duration = Number(metadata.format?.duration ?? stream?.duration) || 0
      captureDate = metadataDate(metadata.format?.tags?.creation_time) ?? metadataDate(stream?.tags?.creation_time)
      const rotation = Number(stream?.tags?.rotate ?? stream?.side_data_list?.find((item: { rotation?: number }) => item.rotation !== undefined)?.rotation) || 0
      if (Math.abs(rotation) % 180 === 90) [width, height] = [height, width]
    } catch { /* 无法解码的视频仍可按文件创建日归档。 */ }
  }
  captureDate ??= validDate(suppliedCapture) ? suppliedCapture : null
  return { captureDate, creationDate, date: captureDate ?? creationDate, dateSource: captureDate ? 'capture' : creationDate ? 'creation' : 'unknown', width, height, duration }
}

/** 生成照片缩略图或视频封面，不改变源文件。 */
export async function thumbnail(path: string, kind: MediaKind, output: string): Promise<void> {
  await mkdir(join(output, '..'), { recursive: true })
  if (kind === 'photo') {
    await sharp(path, { failOn: 'none' }).rotate().resize({ width: 480, height: 480, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toFile(output)
  } else {
    await run(ffmpegPath, ['-v', 'error', '-nostdin', '-i', path, '-frames:v', '1', '-vf', 'scale=480:480:force_original_aspect_ratio=decrease', '-y', output], 45000)
  }
}

/** 视频仅抽取有限帧用于人物查找，命中不代表视频已被逐帧完整检查。 */
export async function videoFrames(path: string, duration: number, directory: string): Promise<{ path: string; time: number }[]> {
  const frames: { path: string; time: number }[] = []
  for (const time of videoFrameTimes(duration)) frames.push(await videoFrame(path, time, directory))
  return frames
}

/** 补检采用更密集的有限抽样，超过上限时均匀覆盖时长；时长未知仅检查起始帧。 */
export function videoFrameTimes(duration: number, supplement = false): number[] {
  if (!Number.isFinite(duration) || duration <= 0) return [0]
  const count = supplement ? Math.max(3, Math.min(48, Math.ceil(duration / 2))) : Math.max(3, Math.min(8, Math.ceil(duration / 5)))
  return Array.from({ length: count }, (_, index) => duration * (index + 0.5) / count)
}

/** 逐帧生成应用缓存，调用方可保存已完成进度并仅重试失败帧。 */
export async function videoFrame(path: string, time: number, directory: string): Promise<{ path: string; time: number }> {
  await mkdir(directory, { recursive: true })
  const output = join(directory, `${randomUUID()}.jpg`)
  await run(ffmpegPath, ['-v', 'error', '-nostdin', '-ss', String(time), '-i', path, '-frames:v', '1', '-vf', 'scale=1920:1920:force_original_aspect_ratio=decrease', '-y', output], 45000)
  // 工具可能在时间点超出视频时正常退出但没有输出，不能把缺帧记为已检查。
  requireValue((await stat(output)).size > 0, '视频在该抽样时间没有可读取的画面。')
  return { path: output, time }
}

function calendarDate(value: string): Date { return new Date(`${value}T12:00:00Z`) }
function shiftedMonth(birthday: Date, months: number): Date {
  const first = new Date(Date.UTC(birthday.getUTCFullYear(), birthday.getUTCMonth() + months, 1, 12))
  const last = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + 1, 0, 12)).getUTCDate()
  first.setUTCDate(Math.min(birthday.getUTCDate(), last))
  return first
}

/** 月龄按日历月计算，月末出生时以目标月最后一天作为月龄边界。 */
export function babyAge(birthday: string, date: string): { months: number; days: number; totalDays: number } {
  requireValue(validDate(birthday) && validDate(date), '请确认出生日期和拍摄日期。')
  const birth = calendarDate(birthday), photo = calendarDate(date)
  requireValue(photo >= birth, '拍摄日期早于宝宝出生日期，请先修正日期。')
  let months = (photo.getUTCFullYear() - birth.getUTCFullYear()) * 12 + photo.getUTCMonth() - birth.getUTCMonth()
  if (shiftedMonth(birth, months) > photo) months--
  return { months, days: Math.round((photo.getTime() - shiftedMonth(birth, months).getTime()) / 86400000), totalDays: Math.round((photo.getTime() - birth.getTime()) / 86400000) }
}

export function watermarkText(baby: BabyProfile, date: string, options: WatermarkOptions): string {
  const age = babyAge(baby.birthday, date), parts: string[] = []
  if (options.template === 'growth') {
    if (options.showName) parts.push(baby.name)
    if (options.showAge || options.showDayCount) parts.push(growthAgeText(baby.birthday, date, options.growthMode ?? 'auto'))
    const heading = parts.join(' · '), subheading = options.showDate ? date.replaceAll('-', ' · ') : ''
    requireValue(heading || subheading, '请至少选择一种水印内容。')
    return subheading ? `${heading}\n${subheading}` : heading
  }
  if (options.showName) parts.push(baby.name)
  if (options.showAge) parts.push(`${age.months} 个月 ${age.days} 天`)
  if (options.showDayCount) parts.push(`出生第 ${age.totalDays + 1} 天`)
  if (options.showDate) parts.push(date)
  requireValue(parts.length > 0, '请至少选择一种水印内容。')
  return parts.join(' · ')
}

/** 成长文案沿用日历月边界，出生当天为第 1 天，周年只在对应边界当天显示。 */
export function growthAgeText(birthday: string, date: string, mode: 'auto' | 'day-count' = 'auto'): string {
  const age = babyAge(birthday, date)
  if (mode === 'day-count' || age.months === 0) return `出生第 ${age.totalDays + 1} 天`
  if (age.months >= 12 && age.months % 12 === 0 && age.days === 0) return `${age.months / 12} 岁啦`
  const years = Math.floor(age.months / 12), months = age.months % 12, parts: string[] = []
  if (years) parts.push(`${years} 岁`)
  if (months) parts.push(`${months} 个月`)
  if (age.days) parts.push(`${age.days} 天`)
  return parts.join(' ')
}

const xml = (value: string) => value.replace(/[&<>"']/g, item => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[item]!))

/** 主标题、日期、阴影与局部暗底在同一画布排版，四角及极窄照片均完整缩放。 */
async function growthWatermarkOverlay(text: string, options: WatermarkOptions, width: number, height: number): Promise<{ buffer: Buffer; left: number; top: number }> {
  const shortest = Math.min(width, height), font = Math.max(1, Math.round(options.fontSize * shortest / 1000))
  const margin = Math.min(Math.round(shortest * 0.04), Math.floor((shortest - 1) / 2))
  const availableWidth = width - margin * 2, availableHeight = height - margin * 2
  const shadow = availableWidth > 2 && availableHeight > 2 ? Math.max(1, Math.round(font * 0.04)) : 0
  const textWidth = Math.max(1, availableWidth - shadow), align = options.position.endsWith('right') ? 'right' : 'left'
  const [heading, subheading = ''] = text.split('\n'), rows: { data: Buffer; width: number; height: number }[] = []
  for (const [content, size, bold] of [[heading, font, true], [subheading, Math.max(1, Math.round(font * 0.6)), false]] as const) {
    if (!content) continue
    const row = await sharp({ text: { text: `<span foreground="${options.color}"${bold ? ' weight="bold"' : ''}>${xml(content)}</span>`, font: `Microsoft YaHei ${size}`, dpi: 72, width: textWidth, wrap: 'word-char', align, rgba: true } }).png().toBuffer({ resolveWithObject: true })
    rows.push({ data: row.data, width: row.info.width, height: row.info.height })
  }
  requireValue(rows.length, '请至少选择一种水印内容。')
  const gap = rows.length > 1 ? Math.max(1, Math.round(font * 0.3)) : 0
  const combinedWidth = Math.max(...rows.map(row => row.width)), combinedHeight = rows.reduce((total, row) => total + row.height, 0) + gap
  let top = 0
  const rowsToComposite = rows.map(row => {
    const layer = { input: row.data, left: align === 'right' ? combinedWidth - row.width : 0, top }
    top += row.height + gap
    return layer
  })
  const combined = await sharp({ create: { width: combinedWidth, height: combinedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(rowsToComposite).png().toBuffer({ resolveWithObject: true })
  const fitted = combined.info.width + shadow > availableWidth || combined.info.height + shadow > availableHeight
    ? await sharp(combined.data).resize({ width: Math.max(1, availableWidth - shadow), height: Math.max(1, availableHeight - shadow), fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    : combined
  const padding = options.shade ? Math.min(margin, Math.round(shortest * 0.05), Math.floor((width - fitted.info.width - shadow) / 2), Math.floor((height - fitted.info.height - shadow) / 2)) : 0
  const paddedWidth = fitted.info.width + shadow + padding * 2, paddedHeight = fitted.info.height + shadow + padding * 2
  const layers: { input: Buffer; left: number; top: number }[] = []
  if (options.shade && paddedWidth > 2 && paddedHeight > 2) {
    // 椭圆羽化暗底在四边完全透明，只轻微压暗文字附近，避免形成贴纸边框。
    const background = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${paddedWidth}" height="${paddedHeight}"><defs><radialGradient id="shade" cx="50%" cy="50%" r="50%"><stop offset="0" stop-color="#000000" stop-opacity="${0.22 * options.opacity}"/><stop offset="0.45" stop-color="#000000" stop-opacity="${0.16 * options.opacity}"/><stop offset="0.75" stop-color="#000000" stop-opacity="${0.06 * options.opacity}"/><stop offset="0.93" stop-color="#000000" stop-opacity="0"/><stop offset="1" stop-color="#000000" stop-opacity="0"/></radialGradient></defs><rect width="100%" height="100%" fill="url(#shade)"/></svg>`)
    layers.push({ input: await sharp(background).png().toBuffer(), left: 0, top: 0 })
  }
  if (shadow) layers.push({ input: await sharp(fitted.data).linear([0, 0, 0, options.opacity * 0.3], [0, 0, 0, 0]).png().toBuffer(), left: padding + shadow, top: padding + shadow })
  layers.push({ input: await sharp(fitted.data).linear([1, 1, 1, options.opacity], [0, 0, 0, 0]).png().toBuffer(), left: padding, top: padding })
  const buffer = await sharp({ create: { width: paddedWidth, height: paddedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer()
  return { buffer, left: align === 'right' ? width - paddedWidth - margin + padding : margin - padding, top: options.position.startsWith('bottom') ? height - paddedHeight - margin + padding : margin - padding }
}

/** 使用同一叠加图生成预览与导出；水印输出永远写入新副本。 */
export async function watermarkOverlay(text: string, options: WatermarkOptions, width: number, height: number): Promise<{ buffer: Buffer; left: number; top: number }> {
  if (options.template === 'growth') return growthWatermarkOverlay(text, options, width, height)
  const font = Math.max(12, Math.round(options.fontSize * Math.min(width, height) / 1000))
  const shortest = Math.min(width, height), margin = Math.min(Math.max(1, Math.round(shortest * 0.025)), Math.floor((shortest - 1) / 2))
  const availableWidth = width - margin * 2, availableHeight = height - margin * 2
  const shadow = availableWidth > 2 && availableHeight > 2 ? 1 : 0
  const textWidth = Math.max(1, availableWidth - shadow), lines: string[] = []
  let line = ''
  for (const part of text.split(' · ')) {
    const candidate = line ? `${line} · ${part}` : part
    const measured = await sharp({ text: { text: xml(candidate), font: `Microsoft YaHei ${font}`, dpi: 72, rgba: true } }).metadata()
    if (line && measured.width! > textWidth) { lines.push(line); line = part } else line = candidate
  }
  if (line) lines.push(line)
  // 按实际字体宽度换行，保留中文、月龄和日期的完整内容。
  const rendered = await sharp({ text: { text: `<span foreground="${options.color}">${xml(lines.join('\n'))}</span>`, font: `Microsoft YaHei ${font}`, dpi: 72, width: textWidth, wrap: 'word-char', align: options.position.endsWith('right') ? 'right' : 'left', rgba: true } }).png().toBuffer({ resolveWithObject: true })
  // 极小或极窄照片可能连一行字都放不下，仅此时整体缩小水印，禁止裁切。
  const fitted = rendered.info.width + shadow > availableWidth || rendered.info.height + shadow > availableHeight
    ? await sharp(rendered.data).resize({ width: Math.max(1, availableWidth - shadow), height: Math.max(1, availableHeight - shadow), fit: 'inside', withoutEnlargement: true }).png().toBuffer({ resolveWithObject: true })
    : rendered
  const foreground = await sharp(fitted.data).linear([1, 1, 1, options.opacity], [0, 0, 0, 0]).png().toBuffer()
  const layers = [{ input: foreground, left: 0, top: 0 }]
  if (shadow) layers.unshift({ input: await sharp(fitted.data).linear([0, 0, 0, options.opacity * 0.25], [0, 0, 0, 0]).png().toBuffer(), left: shadow, top: shadow })
  const paddedWidth = fitted.info.width + shadow, paddedHeight = fitted.info.height + shadow
  const buffer = await sharp({ create: { width: paddedWidth, height: paddedHeight, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(layers).png().toBuffer()
  return { buffer, left: options.position.endsWith('right') ? width - paddedWidth - margin : margin, top: options.position.startsWith('bottom') ? height - paddedHeight - margin : margin }
}

export async function watermarkPreview(path: string, kind: MediaKind, text: string, options: WatermarkOptions, cache: string): Promise<Buffer> {
  let input: string | Buffer = path
  if (kind === 'video') {
    const frame = join(cache, `${randomUUID()}.jpg`)
    await thumbnail(path, kind, frame)
    input = await readFile(frame)
  }
  const photo = await sharp(input, { failOn: 'none' }).rotate().resize({ width: 1200, height: 1200, fit: 'inside', withoutEnlargement: true }).jpeg().toBuffer()
  const metadata = await sharp(photo).metadata()
  const stamp = await watermarkOverlay(text, options, metadata.width!, metadata.height!)
  return sharp(photo).composite([{ input: stamp.buffer, left: stamp.left, top: stamp.top }]).jpeg({ quality: 90 }).toBuffer()
}

export async function watermarkExport(path: string, kind: MediaKind, text: string, options: WatermarkOptions, output: string, cache: string, captureDate?: string): Promise<void> {
  if (kind === 'photo') {
    requireValue(captureDate === undefined || validDate(captureDate), '请先确认拍摄日期，不能为水印副本写入无效日期。')
    const photo = await sharp(path, { failOn: 'none' }).rotate().jpeg({ quality: 95 }).toBuffer()
    const metadata = await sharp(photo).metadata(), stamp = await watermarkOverlay(text, options, metadata.width!, metadata.height!)
    const result = sharp(photo).composite([{ input: stamp.buffer, left: stamp.left, top: stamp.top }]).jpeg({ quality: 95 })
    // 仅写已确认的自然日，避免复制定位、设备信息及已经旋正的旧方向标记。
    if (captureDate) result.withExif({ IFD2: { DateTimeOriginal: `${captureDate.replaceAll('-', ':')} 12:00:00` } })
    await result.toFile(output)
  } else {
    const metadata = await readMetadata(path, kind)
    requireValue(metadata.width > 0 && metadata.height > 0, '视频画面无法解码，原文件仍保持完整。')
    const stamp = await watermarkOverlay(text, options, metadata.width, metadata.height), overlayPath = join(cache, `${randomUUID()}.png`)
    await mkdir(cache, { recursive: true }); await writeFile(overlayPath, stamp.buffer, { flag: 'wx' })
    await run(ffmpegPath, ['-v', 'error', '-nostdin', '-i', path, '-i', overlayPath, '-filter_complex', `[0:v][1:v]overlay=${stamp.left}:${stamp.top}[video]`, '-map', '[video]', '-map', '0:a?', '-c:v', 'libx264', '-crf', '20', '-preset', 'fast', '-c:a', 'aac', '-movflags', '+faststart', '-n', output], 30 * 60 * 1000)
  }
}
