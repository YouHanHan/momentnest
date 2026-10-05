import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'

export const imageExtensions = new Set(['.jpg','.jpeg','.jpe','.jfif','.png','.webp','.gif','.heic','.heif','.avif','.bmp','.tif','.tiff','.dng'])
export const videoExtensions = new Set(['.mp4','.mov','.m4v','.avi','.mkv','.webm','.3gp','.mts','.m2ts'])
export const mediaExtensions = new Set([...imageExtensions,...videoExtensions])

/** 根据受支持的文件后缀区分照片与视频，传输始终保留原始字节。 */
export function mediaKind(path: string): 'photo' | 'video' {
  const extension = extname(path).toLowerCase()
  requireValue(mediaExtensions.has(extension), '暂不支持此照片或视频格式。')
  return videoExtensions.has(extension) ? 'video' : 'photo'
}
export class RequestError extends Error {
  status: number
  constructor(message: string, status = 400) { super(message); this.status = status }
}
export function requireValue(condition: unknown, message: string, status = 400): asserts condition {
  if (!condition) throw new RequestError(message,status)
}
export function textValue(value: unknown, max = 200): string {
  requireValue(typeof value === 'string' && value.length > 0 && value.length <= max, '文本参数无效。')
  return value
}
export function validDate(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const date = new Date(`${value}T12:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0,10) === value
}
export function localDate(date = new Date()): string {
  return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`
}
function validatedIdentity(data: Record<string,unknown>, maximum: number, message: string): {hash:string;size:number} {
  requireValue(typeof data.hash === 'string' && /^[a-f0-9]{64}$/.test(data.hash), '内容指纹无效。')
  requireValue(typeof data.size === 'number' && Number.isSafeInteger(data.size) && data.size > 0 && data.size <= maximum, message)
  return {hash:data.hash,size:data.size}
}
export function contentIdentity(data: Record<string,unknown>): {hash:string;size:number} {
  return validatedIdentity(data, 2*1024**3, '媒体大小须在 1 字节到 2 GiB 之间。')
}
/** 本地索引及复制不受网络传输大小上限约束，空文件不能作为有效媒体。 */
export function localMediaIdentity(data: Record<string,unknown>): {hash:string;size:number} {
  return validatedIdentity(data, Number.MAX_SAFE_INTEGER, '本地媒体为空或大小无效。')
}
/** 哈希在服务工作线程中流式计算，检查读取期间文件是否变化。 */
export async function hashFile(path: string): Promise<{hash:string;size:number;mtime:number}> {
  const before = await stat(path)
  requireValue(before.isFile(), '不是普通文件。')
  const hash=createHash('sha256')
  // 使用有界大读块减少文件读取调度，仍完整计算所有字节并校验前后文件身份。
  for await (const chunk of createReadStream(path,{highWaterMark:256*1024})) hash.update(chunk)
  const after=await stat(path)
  requireValue(before.size===after.size && before.mtimeMs===after.mtimeMs, '文件读取期间发生变化。',409)
  return {hash:hash.digest('hex'),size:after.size,mtime:after.mtimeMs}
}
export async function canonicalDirectory(path: string): Promise<string> {
  const canonical=await realpath(textValue(path,4096))
  requireValue((await stat(canonical)).isDirectory(),'目录不存在。')
  return canonical
}
/** 拒绝路径穿越和目录联接，避免写出用户授权的根目录。 */
export async function safePath(root: string, child: string): Promise<string> {
  const path=resolve(root,child), rel=relative(root,path)
  requireValue(rel !== '' && !rel.startsWith(`..${sep}`) && rel!=='..' && !isAbsolute(rel),'路径超出授权目录。')
  requireValue((await realpath(root)).toLowerCase()===resolve(root).toLowerCase(),'根目录身份已变化。',409)
  let current=root
  for (const part of rel.split(sep)) {
    current=join(current,part)
    try { requireValue(!(await lstat(current)).isSymbolicLink(),'目录包含不允许的链接。') }
    catch(error) { if ((error as NodeJS.ErrnoException).code!=='ENOENT') throw error }
  }
  return path
}
export function archiveName(name: string, hash: string, id: string): string {
  const extension=extname(name).toLowerCase()
  requireValue(mediaExtensions.has(extension),'暂不支持此照片或视频格式。')
  const stem=basename(name,extname(name)).replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').replace(/[. ]+$/g,'').slice(0,80) || 'photo'
  return `${stem}__${hash.slice(0,12)}_${id.slice(0,8)}${extension}`
}
