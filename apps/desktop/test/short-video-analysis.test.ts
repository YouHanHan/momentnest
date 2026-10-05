import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFile, mkdir, mkdtemp } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import ffmpegPath from 'ffmpeg-static'
import { FaceEngine } from '../src/service/face-engine.ts'
import { hashFile } from '../src/service/files.ts'
import { readMetadata } from '../src/service/media-tools.ts'
import { Store } from '../src/service/store.ts'
import { MediaCatalog } from '../src/service/media-catalog.ts'
import type { BabyDecision, FamilyJob } from '../src/shared/family.ts'

/** 只使用项目示例生成短视频，首尾保留人物，中间一秒覆盖为空白。 */
test('普通三秒视频首尾有脸而中间无人时仍能找到宝宝，原文件和完成缓存保留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-short-video-')), data = join(directory, 'state'), library = join(directory, 'media')
  await mkdir(data); await mkdir(library)
  const sample = join(process.cwd(), 'design/layout-preview/assets/family-demo.png'), referencePath = join(library, 'reference.png'), videoPath = join(library, 'first-last-faces.mp4')
  await copyFile(sample, referencePath)
  await new Promise<void>((resolve, reject) => execFile(ffmpegPath!, ['-v', 'error', '-nostdin', '-loop', '1', '-i', sample, '-t', '3', '-vf', "drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='between(t,1,2)',scale=640:480:force_original_aspect_ratio=decrease,pad=640:480:(ow-iw)/2:(oh-ih)/2:color=black,format=yuv420p", '-r', '10', '-c:v', 'libx264', '-crf', '18', '-n', videoPath], { windowsHide: true }, error => error ? reject(error) : resolve()))
  const engine = new FaceEngine(join(process.cwd(), 'models')), store = new Store(join(data, 'synthetic.sqlite')), libraryId = 'short-video-library', babyId = 'short-video-baby'
  let catalog: MediaCatalog | undefined
  try {
    assert.equal((await engine.ready()).ready, true)
    const referenceFaces = await engine.detect(referencePath)
    assert.ok(referenceFaces.length > 0)
    const seed = async (path: string, filename: string, kind: 'photo' | 'video') => {
      const identity = await hashFile(path), metadata = await readMetadata(path, kind), id = `${identity.hash}-${identity.size}`
      const asset = { id, hash: identity.hash, size: identity.size, filename, kind, ...metadata, dateConfirmed: false, available: true, locations: [{ id: filename, path, relativePath: filename, mtime: identity.mtime, source: 'folder', label: libraryId, libraryId, available: true }], babyIds: [], personIds: [], favorite: false, faces: [], faceState: kind === 'photo' ? 'done' : 'pending', updatedAt: new Date().toISOString() }
      store.put('familyAsset', asset)
      return asset
    }
    const reference = await seed(referencePath, 'reference.png', 'photo'), video = await seed(videoPath, 'first-last-faces.mp4', 'video')
    assert.equal(video.duration, 3)
    store.put('library', { id: libraryId, path: library, name: '合成短视频测试', enabled: true })
    store.put('familyFace', { ...referenceFaces[0], id: 'short-video-reference', assetId: reference.id })
    store.put('familyBaby', { id: babyId, name: '测试宝宝', birthday: '2026-01-01', autoMatch: true, referenceFaces: [{ assetId: reference.id, faceId: 'short-video-reference' }], updatedAt: new Date().toISOString() })
    const counts: number[] = []
    catalog = new MediaCatalog(store, data, 'synthetic', undefined, { ready: () => engine.ready(), async detect(path: string) { const faces = await engine.detect(path); counts.push(faces.length); return faces }, close: () => engine.close() })
    catalog.analyzeFaces(libraryId)
    for (let attempt = 0; attempt < 2000 && store.list<FamilyJob>('familyJob').some(job => job.state === 'running'); attempt++) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(store.list<FamilyJob>('familyJob').every(job => job.state === 'done'))
    assert.equal(counts.length, 3); assert.ok(counts[0] > 0 && counts[2] > 0); assert.equal(counts[1], 0)
    const record = store.get<any>('familyAsset', video.id)
    assert.equal(record.faceState, 'done'); assert.deepEqual(record.faceFrames, ['0.5', '1.5', '2.5'])
    const faces = catalog.queryMedia({ libraryId, search: 'first-last' }).items[0].faces
    assert.deepEqual([...new Set(faces.map(face => face.frameTime))].sort(), [0.5, 2.5])
    const result = store.get<BabyDecision>('familyDecision', `${babyId}:${video.id}`)
    assert.equal(result?.state, 'included'); assert.ok(result!.score! >= 0.65)
    assert.equal(catalog.queryMedia({ libraryId, babyId, includeCandidates: true }).items.some(asset => asset.id === video.id), true)
    catalog.analyzeFaces(libraryId); assert.equal(counts.length, 3, '完成缓存不因抽样改进而自动重复分析')
    assert.equal((await hashFile(videoPath)).hash, video.hash)
  } finally { if (catalog) await catalog.close(); else await engine.close(); store.close() }
})
