import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { copyRuntimeLicenses } from '../third-party-licenses.mjs'

const workspace = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

async function fixture(dependencies) {
  const cache = join(workspace, '.cache')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'license-test-'))
  await mkdir(join(root, 'apps/desktop'), { recursive: true })
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ dependencies }))
  return root
}

async function dependency(root, name, metadata, notices = {}) {
  const directory = join(root, 'node_modules', name)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name, version: '1.0.0', license: 'MIT', ...metadata }))
  for (const [filename, content] of Object.entries(notices)) {
    await mkdir(dirname(join(directory, filename)), { recursive: true })
    await writeFile(join(directory, filename), content)
  }
  return directory
}

test('收集编入 JavaScript 的直接与传递依赖，保留版权和 NOTICE 目录', async () => {
  const root = await fixture({ parent: '1.0.0', '@example/shared': '1.0.0' })
  await dependency(root, 'parent', { dependencies: { '@example/shared': '1.0.0', string_decoder: '1.0.0' }, optionalDependencies: { absent: '1.0.0' } }, { LICENSE: '父包版权', 'licenses/NOTICE.txt': '原始声明' })
  await dependency(root, '@example/shared', {}, { 'LICENSE.md': '传递依赖版权' })
  await dependency(root, 'string_decoder', {}, { LICENSE: '与内置模块同名的 npm 兼容包' })
  await dependency(root, 'unrelated-dev-tool', {}, { LICENSE: '不属于运行依赖' })
  const destination = join(root, 'output')
  const report = await copyRuntimeLicenses(root, destination)
  assert.deepEqual(report.dependencies.map(item => item.name), ['@example/shared', 'parent', 'string_decoder'])
  assert.deepEqual(report.missingNotices, [])
  assert.equal(await readFile(join(destination, 'npm/parent@1.0.0/licenses/NOTICE.txt'), 'utf8'), '原始声明')
  assert.equal(await readFile(join(destination, 'npm/%40example%2Fshared@1.0.0/LICENSE.md'), 'utf8'), '传递依赖版权')
  assert.deepEqual(JSON.parse(await readFile(join(destination, 'npm-manifest.json'), 'utf8')), report)
})

test('不同依赖树中的同名不同版本各自保留许可', async () => {
  const root = await fixture({ parent: '1.0.0', shared: '1.0.0' })
  const parent = await dependency(root, 'parent', { dependencies: { shared: '2.0.0' } }, { LICENSE: '父包' })
  await dependency(root, 'shared', {}, { LICENSE: '第一版' })
  await dependency(parent, 'shared', { version: '2.0.0' }, { LICENSE: '第二版' })
  const destination = join(root, 'output')
  const report = await copyRuntimeLicenses(root, destination)
  assert.equal(report.dependencies.filter(item => item.name === 'shared').length, 2)
  assert.equal(await readFile(join(destination, 'npm/shared@1.0.0/LICENSE'), 'utf8'), '第一版')
  assert.equal(await readFile(join(destination, 'npm/shared@2.0.0/LICENSE'), 'utf8'), '第二版')
})

test('缺失声明列入报告，缺失必需依赖则停止收集', async () => {
  const root = await fixture({ undocumented: '1.0.0' })
  await dependency(root, 'undocumented', {})
  const report = await copyRuntimeLicenses(root, join(root, 'output'))
  assert.deepEqual(report.missingNotices, ['undocumented@1.0.0'])
  await writeFile(join(root, 'apps/desktop/package.json'), JSON.stringify({ dependencies: { 'missing-required': '1.0.0' } }))
  await assert.rejects(copyRuntimeLicenses(root, join(root, 'second-output')), /缺少运行依赖/)
})

test('README 中的完整许可原样随包保留', async () => {
  const root = await fixture({ embedded: '1.0.0' })
  const readme = '测试说明\nCopyright (c) 示例作者\nPermission is hereby granted\nTHE SOFTWARE IS PROVIDED'
  await dependency(root, 'embedded', {}, { 'README.md': readme })
  const destination = join(root, 'output')
  const report = await copyRuntimeLicenses(root, destination)
  assert.deepEqual(report.missingNotices, [])
  assert.equal(await readFile(join(destination, report.dependencies[0].files[0]), 'utf8'), readme)
})

test('上游补充许可只用于对应版本，完整哈希不符时停止收集', async () => {
  const root = await fixture({ supplemented: '1.0.0' })
  const directory = await dependency(root, 'supplemented', {})
  const text = '上游许可原文'
  await mkdir(join(root, 'third_party/licenses'), { recursive: true })
  const notice = { file: 'upstream-LICENSE.txt', source: 'https://example.com/upstream/LICENSE', sha256: createHash('sha256').update(text).digest('hex') }
  await writeFile(join(root, 'third_party/licenses', notice.file), text)
  await writeFile(join(root, 'third_party/npm-notices.json'), JSON.stringify({ 'supplemented@1.0.0': notice }))
  const report = await copyRuntimeLicenses(root, join(root, 'first-output'))
  assert.deepEqual(report.missingNotices, [])
  assert.equal(report.dependencies[0].supplementalSource, notice.source)
  await writeFile(join(root, 'third_party/licenses', notice.file), '被替换的文本')
  await assert.rejects(copyRuntimeLicenses(root, join(root, 'second-output')), /SHA-256/)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'supplemented', version: '2.0.0', license: 'MIT' }))
  const changed = await copyRuntimeLicenses(root, join(root, 'third-output'))
  assert.deepEqual(changed.missingNotices, ['supplemented@2.0.0'])
})

test('依据包元数据补充的许可保留整理依据，作者或许可声明不符时拒绝沿用', async () => {
  const root = await fixture({ attributed: '1.0.0' })
  const directory = await dependency(root, 'attributed', { author: { name: '测试作者' } })
  const text = '按作者已发布的 MIT 声明整理，不冒充上游原始文件'
  await mkdir(join(root, 'third_party/licenses'), { recursive: true })
  const notice = { file: 'attribution-NOTICE.txt', source: 'https://example.com/metadata', sha256: createHash('sha256').update(text).digest('hex'),
    declaredAuthor: '测试作者', declaredLicense: 'MIT', noticeBasis: 'published-package-metadata-and-standard-license' }
  await writeFile(join(root, 'third_party/licenses', notice.file), text)
  await writeFile(join(root, 'third_party/npm-notices.json'), JSON.stringify({ 'attributed@1.0.0': notice }))
  const report = await copyRuntimeLicenses(root, join(root, 'first-output'))
  assert.deepEqual(report.missingNotices, [])
  assert.equal(report.dependencies[0].noticeBasis, notice.noticeBasis)
  await writeFile(join(directory, 'package.json'), JSON.stringify({ name: 'attributed', version: '1.0.0', author: '其他作者', license: 'MIT' }))
  await assert.rejects(copyRuntimeLicenses(root, join(root, 'second-output')), /作者或授权声明不符/)
})
