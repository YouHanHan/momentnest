import { readFile, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
/** 只按仓库内已审核的清单准备模型，不在安装时更新模型身份或许可证。 */
export async function prepareModels(projectRoot = root, fetchModel = fetch) {
  const directory = join(projectRoot, 'models')
  const manifest = JSON.parse(await readFile(join(directory, 'manifest.json'), 'utf8'))
  if (!Array.isArray(manifest) || !manifest.length) throw new Error('模型清单不能为空。')
  const filenames = new Set()
  for (const model of manifest) {
    if (!model || typeof model !== 'object' || typeof model.filename !== 'string' ||
        !/^[a-z0-9_]+\.onnx$/.test(model.filename) || filenames.has(model.filename) ||
        typeof model.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(model.sha256) ||
        !Number.isSafeInteger(model.size) || model.size < 1 || model.size > 50 * 1024 ** 2 ||
        typeof model.source !== 'string') throw new Error('模型清单的文件名、大小或指纹无效。')
    const source = /^https:\/\/raw\.githubusercontent\.com\/opencv\/opencv_zoo\/([a-f0-9]{40})\/models\/(face_[a-z_]+)\/([a-z0-9_]+\.onnx)$/.exec(model.source)
    if (!source || source[3] !== model.filename) throw new Error('模型来源必须固定到 OpenCV Zoo 提交，并与文件名一致。')
    filenames.add(model.filename)
    const license = await readFile(join(directory, `${source[2]}-LICENSE.txt`), 'utf8')
    if (!license.trim()) throw new Error(`模型许可文本缺失：${model.filename}`)
  }

  for (const { filename, sha256, size, source } of manifest) {
    const matches = bytes => bytes?.length === size && createHash('sha256').update(bytes).digest('hex') === sha256
    const destination = join(directory, filename)
    let bytes
    try { bytes = await readFile(destination) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    if (!matches(bytes)) {
      const download = source.replace('https://raw.githubusercontent.com/', 'https://media.githubusercontent.com/media/')
      const response = await fetchModel(download, { signal: AbortSignal.timeout(60000) })
      if (!response.ok) throw new Error(`模型下载失败：${filename}，HTTP ${response.status}`)
      bytes = Buffer.from(await response.arrayBuffer())
      if (!matches(bytes)) throw new Error(`模型大小或 SHA-256 与已审核清单不符：${filename}`)
      await writeFile(destination, bytes)
    }
    console.log(`模型已校验：${filename} (${size} 字节)`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareModels().catch(error => {
    console.error(`模型准备失败：${error.message}`)
    process.exitCode = 1
  })
}
