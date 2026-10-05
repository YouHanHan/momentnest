import { createHash } from 'node:crypto'
import { open } from 'node:fs/promises'
import type { FileHandle } from 'node:fs/promises'
import exifr from 'exifr'
import type { Exifr } from 'exifr'
import type { MediaKind } from '../shared/family.ts'

interface Box { type: string; start: number; data: number; end: number }
const metadataLimit = 16 * 1024 ** 2
const ExifReader = exifr.Exifr as unknown as typeof Exifr

/** 精确读取有限区间，拒绝截断、越界与过大的元数据。 */
async function bytes(file: FileHandle, start: number, length: number): Promise<Buffer> {
  if (!Number.isSafeInteger(start) || start < 0 || length < 0 || length > metadataLimit) throw new Error('媒体结构无效。')
  const result = Buffer.alloc(length)
  let offset = 0
  while (offset < length) {
    const read = await file.read(result, offset, length - offset, start + offset)
    if (!read.bytesRead) throw new Error('媒体结构被截断。')
    offset += read.bytesRead
  }
  return result
}

/** 对编码数据流式计算指纹，不使用缩略图、降采样或相似度。 */
async function hashRange(file: FileHandle, hash: ReturnType<typeof createHash>, start: number, end: number): Promise<void> {
  if (start < 0 || end < start || !Number.isSafeInteger(end)) throw new Error('媒体区间无效。')
  for (let offset = start; offset < end; offset += 256 * 1024) hash.update(await bytes(file, offset, Math.min(256 * 1024, end - offset)))
}

async function boxes(file: FileHandle, start: number, end: number): Promise<Box[]> {
  const result: Box[] = []
  while (start < end) {
    const header = await bytes(file, start, 8)
    let length = header.readUInt32BE(0), data = start + 8
    if (length === 1) { length = Number((await bytes(file, data, 8)).readBigUInt64BE()); data += 8 }
    if (length === 0) length = end - start
    if (!Number.isSafeInteger(length) || length < data - start || start + length > end) throw new Error('媒体容器无效。')
    result.push({ type: header.toString('latin1', 4, 8), start, data, end: start + length })
    start += length
  }
  return result
}

/** 按真实 RIFF 结构读取 EXIF，支持被命名为 JPG 的 WEBP。 */
export async function webpExif(path: string): Promise<Buffer | undefined> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    if (size < 12) return
    const header = await bytes(file, 0, 12)
    if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WEBP') return
    const end = header.readUInt32LE(4) + 8
    if (end > size) return
    for (let offset = 12; offset + 8 <= end;) {
      const chunk = await bytes(file, offset, 8), length = chunk.readUInt32LE(4)
      if (offset + 8 + length > end) return
      if (chunk.toString('ascii', 0, 4) === 'EXIF') {
        const data = await bytes(file, offset + 8, length)
        return data.subarray(0, 6).equals(Buffer.from('Exif\0\0')) ? data.subarray(6) : data
      }
      offset += 8 + length + (length % 2)
    }
  } finally { await file.close() }
}

async function jpegHash(file: FileHandle, hash: ReturnType<typeof createHash>, size: number): Promise<void> {
  let offset = 2
  while (offset < size) {
    const marker = await bytes(file, offset, 2)
    if (marker[0] !== 255) throw new Error('JPEG 标记无效。')
    if (marker[1] === 255) { offset++; continue }
    if (marker[1] === 0xda || marker[1] === 0xd9) { await hashRange(file, hash, offset, size); return }
    const length = (await bytes(file, offset + 2, 2)).readUInt16BE()
    if (length < 2 || offset + length + 2 > size) throw new Error('JPEG 段无效。')
    const isExif = marker[1] === 0xe1 && length >= 8 && (await bytes(file, offset + 4, 6)).equals(Buffer.from('Exif\0\0'))
    if (!isExif) await hashRange(file, hash, offset, offset + length + 2)
    offset += length + 2
  }
  throw new Error('JPEG 数据不完整。')
}

async function pngHash(file: FileHandle, hash: ReturnType<typeof createHash>, size: number): Promise<void> {
  for (let offset = 8; offset < size;) {
    const header = await bytes(file, offset, 8), length = header.readUInt32BE(), end = offset + length + 12
    if (end > size) throw new Error('PNG 段无效。')
    const type = header.toString('ascii', 4, 8)
    if (type !== 'eXIf') await hashRange(file, hash, offset, end)
    offset = end
    if (type === 'IEND') { await hashRange(file, hash, offset, size); return }
  }
  throw new Error('PNG 数据不完整。')
}

async function webpHash(file: FileHandle, hash: ReturnType<typeof createHash>, size: number): Promise<void> {
  const end = (await bytes(file, 0, 8)).readUInt32LE(4) + 8
  if (end !== size) throw new Error('WEBP 容器无效。')
  for (let offset = 12; offset < end;) {
    const chunk = await bytes(file, offset, 8), length = chunk.readUInt32LE(4), next = offset + 8 + length + (length % 2)
    if (next > end) throw new Error('WEBP 段无效。')
    const type = chunk.toString('ascii', 0, 4)
    if (type === 'VP8X') {
      const flags = await bytes(file, offset + 8, length)
      flags[0] &= ~0x08
      hash.update(type); hash.update(flags)
    } else if (type !== 'EXIF') await hashRange(file, hash, offset, next)
    offset = next
  }
}

/** QuickTime 只忽略创建/修改时间，保留编码、轨道矩阵、样本表和全部媒体数据。 */
async function movieHash(file: FileHandle, hash: ReturnType<typeof createHash>, start: number, end: number): Promise<void> {
  for (const box of await boxes(file, start, end)) {
    hash.update(JSON.stringify([box.type, box.end - box.data]))
    if (['moov', 'trak', 'mdia'].includes(box.type)) await movieHash(file, hash, box.data, box.end)
    else if (['mvhd', 'tkhd', 'mdhd'].includes(box.type)) {
      const data = await bytes(file, box.data, box.end - box.data), length = data[0] === 1 ? 16 : data[0] === 0 ? 8 : 0
      if (!length || data.length < length + 4) throw new Error('QuickTime 时间头无效。')
      data.fill(0, 4, 4 + length); hash.update(data)
    } else await hashRange(file, hash, box.data, box.end)
  }
}

/** HEIF 比较图像项目及渲染属性，排除 EXIF 项目与其文件偏移。 */
async function heifHash(file: FileHandle, hash: ReturnType<typeof createHash>, top: Box[]): Promise<void> {
  const meta = top.find(box => box.type === 'meta')
  if (!meta) throw new Error('HEIF 缺少项目目录。')
  const children = await boxes(file, meta.data + 4, meta.end)
  const iinf = children.find(box => box.type === 'iinf'), iloc = children.find(box => box.type === 'iloc')
  if (!iinf || !iloc) throw new Error('HEIF 项目目录不完整。')
  const infoHeader = await bytes(file, iinf.data, 8)
  const items = new Map<number, string>()
  for (const item of await boxes(file, iinf.data + (infoHeader[0] === 0 ? 6 : 8), iinf.end)) {
    if (item.type !== 'infe') throw new Error('HEIF 项目类型无效。')
    const data = await bytes(file, item.data, item.end - item.data), version = data[0]
    if (version !== 2 && version !== 3) throw new Error('HEIF 项目版本暂不支持。')
    const id = version === 2 ? data.readUInt16BE(4) : data.readUInt32BE(4), offset = version === 2 ? 8 : 10
    if (data.readUInt16BE(offset - 2)) throw new Error('加密 HEIF 项目暂不支持。')
    items.set(id, data.toString('ascii', offset, offset + 4))
  }
  for (const property of children.filter(box => ['pitm', 'iprp'].includes(box.type))) { hash.update(property.type); await hashRange(file, hash, property.data, property.end) }
  const references = children.find(box => box.type === 'iref')
  if (references) for (const relation of await boxes(file, references.data + 4, references.end)) {
    if (relation.type !== 'cdsc') { hash.update(relation.type); await hashRange(file, hash, relation.data, relation.end) }
  }
  const data = await bytes(file, iloc.data, iloc.end - iloc.data), version = data[0]
  if (version > 2) throw new Error('HEIF 位置版本暂不支持。')
  let cursor = 6
  const number = (width: number): number => {
    if (width > 8 || cursor + width > data.length) throw new Error('HEIF 位置截断。')
    let value = 0
    for (let index = 0; index < width; index++) value = value * 256 + data[cursor++]
    if (!Number.isSafeInteger(value)) throw new Error('HEIF 位置越界。')
    return value
  }
  const offsetSize = data[4] >> 4, lengthSize = data[4] & 15, baseSize = data[5] >> 4, indexSize = version ? data[5] & 15 : 0
  const count = number(version < 2 ? 2 : 4), idat = children.find(box => box.type === 'idat')
  let images = 0
  for (let index = 0; index < count; index++) {
    const id = number(version < 2 ? 2 : 4), method = version ? number(2) & 15 : 0, reference = number(2), base = number(baseSize), extents = number(2)
    const type = items.get(id)
    if (!type || reference || method > 1) throw new Error('HEIF 项目引用暂不支持。')
    const image = !['Exif', 'mime', 'uri '].includes(type)
    if (image) { images++; hash.update(JSON.stringify([id, type])) }
    for (let extent = 0; extent < extents; extent++) {
      number(indexSize)
      const offset = number(offsetSize), length = number(lengthSize), start = base + offset + (method === 1 ? idat?.data ?? -Infinity : 0)
      if (image) {
        if (!length || start < 0 || start + length > (method === 1 ? idat!.end : (await file.stat()).size)) throw new Error('HEIF 编码数据越界。')
        await hashRange(file, hash, start, start + length)
      }
    }
  }
  if (!images) throw new Error('HEIF 缺少图像项目。')
}

/** 只用于判断同一路径的元数据修订，完整文件指纹仍是去重与回执依据。 */
export async function mediaContentHash(path: string, kind: MediaKind): Promise<string | undefined> {
  const file = await open(path, 'r')
  try {
    const before = await file.stat(), header = await bytes(file, 0, Math.min(12, before.size)), hash = createHash('sha256')
    hash.update('media-content-v1:' + kind)
    if (kind === 'photo') {
      const embedded = await webpExif(path)
      const reader = new ExifReader({ pick: ['Orientation', 'ColorSpace'], translateValues: false, reviveValues: false }) as Exifr & { file?: { close?(): Promise<void> | void } }
      let tags: Record<string, unknown> | undefined
      try {
        if (embedded || header.toString('ascii', 8, 12) !== 'WEBP') { await reader.read(embedded ?? path); tags = await reader.parse() }
      } finally { await reader.file?.close?.() }
      hash.update(JSON.stringify([tags?.Orientation ?? 1, tags?.ColorSpace ?? 65535]))
      if (header.readUInt16BE(0) === 0xffd8) { hash.update('jpeg'); await jpegHash(file, hash, before.size) }
      else if (header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) { hash.update('png'); await pngHash(file, hash, before.size) }
      else if (header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP') { hash.update('webp'); await webpHash(file, hash, before.size) }
      else if (header.toString('ascii', 4, 8) === 'ftyp') { hash.update('heif'); await heifHash(file, hash, await boxes(file, 0, before.size)) }
      else return
    } else {
      if (header.toString('ascii', 4, 8) !== 'ftyp') return
      hash.update('quicktime')
      await movieHash(file, hash, 0, before.size)
    }
    const after = await file.stat()
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return
    return hash.digest('hex')
  } catch { return undefined }
  finally { await file.close() }
}
