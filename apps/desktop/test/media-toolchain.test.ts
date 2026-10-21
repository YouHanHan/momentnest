import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { promisify } from 'node:util'
import test from 'node:test'
import sharp from 'sharp'
import { ffmpegPath, ffprobePath } from '@momentnest/media-tools'
import { readMetadata, thumbnail, videoFrames, watermarkExport, watermarkPreview } from '../src/service/media-tools.ts'

const execute = promisify(execFile)
const fingerprint = async (file: string) => createHash('sha256').update(await readFile(file)).digest('hex')

test('固定源码构建的两项工具同版，保留 H.264 编码、AV1 解码和 PNG 水印支持', async () => {
  const options = { windowsHide: true, timeout: 20000 }
  const ffmpeg = await execute(ffmpegPath, ['-version'], options)
  const ffprobe = await execute(ffprobePath, ['-version'], options)
  assert.match(ffmpeg.stdout, /ffmpeg version (?:n)?6\.1\.1/)
  assert.match(ffprobe.stdout, /ffprobe version (?:n)?6\.1\.1/)
  for (const flag of ['--enable-gpl', '--enable-version3', '--disable-autodetect', '--enable-libx264', '--enable-libdav1d', '--enable-zlib']) assert.ok(ffmpeg.stdout.includes(flag))
  assert.ok(!ffmpeg.stdout.includes('--enable-nonfree'))
  const decoders = await execute(ffmpegPath, ['-hide_banner', '-decoders'], options)
  for (const codec of ['h264', 'hevc', 'libdav1d', 'vp9', 'png']) assert.ok(decoders.stdout.includes(codec), codec)
})

test('新工具执行真实元数据、缩略图、抽帧及水印流程，原视频完整保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-media-toolchain-'))
  const input = join(directory, '合成视频.mp4')
  const cache = join(directory, 'cache')
  await mkdir(cache)
  await execute(ffmpegPath, ['-hide_banner', '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc2=size=192x128:rate=8',
    '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000', '-t', '1.5', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac',
    '-metadata', 'creation_time=2026-10-01T12:00:00Z', '-n', input], { windowsHide: true, timeout: 45000 })
  const originalHash = await fingerprint(input)
  const metadata = await readMetadata(input, 'video')
  assert.equal(metadata.width, 192)
  assert.equal(metadata.height, 128)
  assert.equal(metadata.captureDate, '2026-10-01')
  assert.ok(metadata.duration >= 1.4 && metadata.duration <= 1.6)
  const cover = join(cache, 'cover.jpg')
  await thumbnail(input, 'video', cover)
  assert.equal((await sharp(cover).metadata()).format, 'jpeg')
  const frames = await videoFrames(input, metadata.duration, cache)
  assert.equal(frames.length, 3)
  for (const frame of frames) assert.equal((await sharp(frame.path).metadata()).format, 'jpeg')
  const options = { babyId: 'synthetic-baby', position: 'bottom-right' as const, fontSize: 32, color: '#ffffff', opacity: 0.8,
    showName: true, showAge: false, showDate: false, showDayCount: false }
  const preview = await watermarkPreview(input, 'video', '合成水印', options, cache)
  assert.equal((await sharp(preview).metadata()).format, 'jpeg')
  const output = join(directory, '水印副本.mp4')
  await watermarkExport(input, 'video', '合成水印', options, output, cache)
  const outputMetadata = await readMetadata(output, 'video')
  assert.equal(outputMetadata.width, metadata.width)
  assert.equal(outputMetadata.height, metadata.height)
  assert.ok(outputMetadata.duration >= metadata.duration - 0.2)
  assert.equal(await fingerprint(input), originalHash)
})
