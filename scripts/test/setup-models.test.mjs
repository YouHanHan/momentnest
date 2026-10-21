import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { prepareModels } from '../setup-models.mjs'

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** 合成模型仅用于校验下载完整性，不调用真实模型或访问网络。 */
async function fixture() {
  const cache = join(workspace, '.cache')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'model-setup-test-'))
  const directory = join(root, 'models')
  await mkdir(directory)
  const bytes = Buffer.from('合成模型数据')
  const filename = 'face_detection_yunet_2023mar.onnx'
  const manifest = [{ filename, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length,
    source: `https://raw.githubusercontent.com/opencv/opencv_zoo/${'a'.repeat(40)}/models/face_detection_yunet/${filename}` }]
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
  await writeFile(join(directory, 'face_detection_yunet-LICENSE.txt'), '测试许可文本')
  return { root, directory, bytes, filename, manifest }
}

test('下载按固定提交、大小和完整 SHA-256 校验，保留清单与许可文本', async () => {
  const { root, directory, bytes, filename, manifest } = await fixture()
  const manifestBefore = await readFile(join(directory, 'manifest.json'), 'utf8')
  await prepareModels(root, async (url, options) => {
    assert.equal(url, manifest[0].source.replace('https://raw.githubusercontent.com/', 'https://media.githubusercontent.com/media/'))
    assert.ok(options.signal instanceof AbortSignal)
    return new Response(bytes)
  })
  assert.deepEqual(await readFile(join(directory, filename)), bytes)
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), manifestBefore)
  assert.equal(await readFile(join(directory, 'face_detection_yunet-LICENSE.txt'), 'utf8'), '测试许可文本')
})

test('本机模型已通过大小与哈希校验时，不访问网络', async () => {
  const { root, directory, bytes, filename } = await fixture()
  await writeFile(join(directory, filename), bytes)
  await prepareModels(root, () => { assert.fail('有效缓存不应重新下载') })
})

test('拒绝大小相同但内容被替换的下载，保留已有文件和清单', async () => {
  const { root, directory, bytes, filename } = await fixture()
  const existing = Buffer.from('已有文件保留')
  await writeFile(join(directory, filename), existing)
  const manifestBefore = await readFile(join(directory, 'manifest.json'), 'utf8')
  await assert.rejects(prepareModels(root, async () => new Response(Buffer.alloc(bytes.length))), /SHA-256/)
  assert.deepEqual(await readFile(join(directory, filename)), existing)
  assert.equal(await readFile(join(directory, 'manifest.json'), 'utf8'), manifestBefore)
})

test('大小不符或下载失败时，不生成模型文件', async () => {
  for (const response of [new Response('不完整'), new Response(null, { status: 503 })]) {
    const { root, directory, filename } = await fixture()
    await assert.rejects(prepareModels(root, async () => response), /大小|HTTP 503/)
    await assert.rejects(readFile(join(directory, filename)), { code: 'ENOENT' })
  }
})

test('可变分支、路径穿越和重复文件名在下载前被拒绝', async () => {
  for (const variant of ['branch', 'path', 'duplicate']) {
    const { root, directory, manifest } = await fixture()
    if (variant === 'branch') manifest[0].source = manifest[0].source.replace('a'.repeat(40), 'main')
    if (variant === 'path') manifest[0].filename = '../outside.onnx'
    if (variant === 'duplicate') manifest.push({ ...manifest[0] })
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest))
    await assert.rejects(prepareModels(root, () => { assert.fail('无效清单不应访问网络') }), /清单|固定/)
  }
})

test('缺少许可文本时，先停止准备，不下载模型', async () => {
  const { root, directory } = await fixture()
  await writeFile(join(directory, 'face_detection_yunet-LICENSE.txt'), '')
  await assert.rejects(prepareModels(root, () => { assert.fail('缺少许可时不应下载') }), /许可文本缺失/)
})
