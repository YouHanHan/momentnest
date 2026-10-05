import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(root, 'models')
const models = [
  ['face_detection_yunet', 'face_detection_yunet_2023mar.onnx'],
  ['face_recognition_sface', 'face_recognition_sface_2021dec.onnx'],
]
await mkdir(directory, { recursive: true })
const manifest = []
for (const [folder, filename] of models) {
  const source = `https://raw.githubusercontent.com/opencv/opencv_zoo/main/models/${folder}`
  const pointerResponse = await fetch(`${source}/${filename}`)
  if (!pointerResponse.ok) throw new Error(`模型清单下载失败：${pointerResponse.status}`)
  const pointer = await pointerResponse.text()
  const hash = pointer.match(/oid sha256:([a-f0-9]{64})/)?.[1]
  const size = Number(pointer.match(/size (\d+)/)?.[1])
  if (!hash || !size || size > 50 * 1024 ** 2) throw new Error('模型内容指纹无效。')
  let bytes
  try { bytes = await readFile(join(directory, filename)) } catch { /* 首次安装下载公开模型。 */ }
  if (!bytes || createHash('sha256').update(bytes).digest('hex') !== hash) {
    const response = await fetch(`https://media.githubusercontent.com/media/opencv/opencv_zoo/main/models/${folder}/${filename}`)
    if (!response.ok) throw new Error(`模型下载失败：${response.status}`)
    bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length !== size || createHash('sha256').update(bytes).digest('hex') !== hash) throw new Error('模型校验失败。')
    await writeFile(join(directory, filename), bytes)
  }
  const license = await fetch(`${source}/LICENSE`)
  if (!license.ok) throw new Error('模型授权文件下载失败。')
  await writeFile(join(directory, `${folder}-LICENSE.txt`), await license.text())
  manifest.push({ filename, sha256: hash, size, source: `${source}/${filename}` })
  console.log(`模型已校验：${filename} (${size} 字节)`)
}
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
