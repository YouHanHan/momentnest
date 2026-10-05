import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { canonicalUserDataDirectory, migrateUserDataDirectory, userDataDirectory } from '../src/main/data-directory.ts'
import { safePath } from '../src/service/files.ts'
import { Store } from '../src/service/store.ts'

test('开发、预览和不同版本正式包读取同一数据库，重启保留相册记录', async () => {
  const appData = join(process.cwd(), '.cache', 'tests', randomUUID())
  const home = join(appData, 'profile')
  const scenarios = [
    { name: '@jinchuan/desktop', packaged: false },
    { name: 'jinchuan', packaged: true },
    { name: 'Jinchuan-0.4.25', packaged: true },
    { name: '@shiguangbox/desktop', packaged: false },
    { name: 'ShiguangBox-0.4.33', packaged: true },
    { name: '@momentnest/desktop', packaged: false },
    { name: 'MomentNest-0.4.34', packaged: true },
    { name: '@jinchuan/desktop', packaged: false },
  ]
  const expected = join(home, '.jinchuan')
  await mkdir(join(expected, 'receiver'), { recursive: true })
  for (const [index, scenario] of scenarios.entries()) {
    const directory = userDataDirectory(appData, scenario.name, join(appData, scenario.name), scenario.packaged, home)
    assert.equal(directory, expected)
    const store = new Store(join(directory, 'receiver', 'receiver.sqlite'))
    try {
      if (index === 0) store.put('familyBaby', { id: 'synthetic-baby', name: '合成档案' })
      assert.equal(store.get<{ name: string }>('familyBaby', 'synthetic-baby')?.name, '合成档案')
    } finally { store.close() }
  }
})

test('验收脚本的独立目录不接触日常数据库', () => {
  const appData = join(process.cwd(), '.cache', 'synthetic-app-data')
  const isolated = join(process.cwd(), '.cache', 'synthetic-verification')
  assert.equal(userDataDirectory(appData, 'Electron', isolated, false, process.cwd()), isolated)
  assert.notEqual(isolated, join(appData, 'jinchuan'))
})

test('正式包不因外部旧目录配置切换相册', () => {
  const appData = join(process.cwd(), '.cache', 'synthetic-app-data')
  const legacy = join(process.cwd(), '.cache', 'desktop-smoke')
  assert.equal(userDataDirectory(appData, 'jinchuan', legacy, true, process.cwd()), join(process.cwd(), '.jinchuan'))
})

test('同一用户在不同启动环境使用固定目录，物理目录可通过缓存安全校验', async () => {
  const home = join(process.cwd(), '.cache', 'tests', randomUUID())
  const ordinary = join(home, 'AppData', 'Roaming'), redirected = join(home, 'package-cache', 'Roaming')
  const expected = join(home, '.jinchuan')
  for (const appData of [ordinary, redirected]) assert.equal(userDataDirectory(appData, 'jinchuan', join(appData, 'jinchuan'), true, home), expected)
  const canonical = canonicalUserDataDirectory(expected)
  assert.equal(await safePath(canonical, 'receiver/family-cache/thumbs/synthetic.jpg'), join(canonical, 'receiver', 'family-cache', 'thumbs', 'synthetic.jpg'))
})

test('迁移包含 WAL 中已提交记录和生成缓存，修正内部路径并保留原数据库', async () => {
  const directory = join(process.cwd(), '.cache', 'tests', randomUUID())
  const appData = join(directory, 'legacy-app-data'), legacy = join(appData, 'jinchuan', 'receiver')
  const current = canonicalUserDataDirectory(join(directory, 'profile', '.jinchuan')), target = join(current, 'receiver')
  await mkdir(join(legacy, 'family-cache', 'thumbs'), { recursive: true })
  await mkdir(join(legacy, 'face-index-backups'), { recursive: true })
  const thumbnail = join(legacy, 'family-cache', 'thumbs', 'synthetic.jpg'), backup = join(legacy, 'face-index-backups', 'synthetic.sqlite')
  await writeFile(thumbnail, '合成缩略图'); await writeFile(backup, '合成备份')
  const original = new Store(join(legacy, 'receiver.sqlite'))
  try {
    original.put('familyBaby', { id: 'baby', name: '合成宝宝' })
    original.put('familyAsset', { id: 'asset', thumbnailPath: thumbnail, favorite: true, faceFrames: [join(legacy, 'family-cache', 'frames', 'synthetic.jpg')] })
    original.put('familyRebuild', { id: 'library', backupPath: backup })
    original.put('library', { id: 'library', path: join(directory, 'original-photos'), enabled: true })
    assert.equal(migrateUserDataDirectory(appData, current), true)
    const restored = new Store(join(target, 'receiver.sqlite'))
    try {
      assert.equal(restored.get<{ name: string }>('familyBaby', 'baby')?.name, '合成宝宝')
      assert.deepEqual(restored.get('familyAsset', 'asset'), { id: 'asset', thumbnailPath: join(target, 'family-cache', 'thumbs', 'synthetic.jpg'), favorite: true, faceFrames: [join(target, 'family-cache', 'frames', 'synthetic.jpg')] })
      assert.deepEqual(restored.get('familyRebuild', 'library'), { id: 'library', backupPath: join(target, 'face-index-backups', 'synthetic.sqlite') })
      assert.equal(await readFile(join(target, 'family-cache', 'thumbs', 'synthetic.jpg'), 'utf8'), '合成缩略图')
      assert.equal(restored.get<{ path: string }>('library', 'library')?.path, join(directory, 'original-photos'))
      restored.put('familyBaby', { id: 'baby', name: '新版档案' })
    } finally { restored.close() }
    assert.equal(migrateUserDataDirectory(appData, current), false, '再次启动不得用旧备份覆盖新版记录')
    assert.equal(original.get<{ name: string }>('familyBaby', 'baby')?.name, '合成宝宝')
    assert.equal(original.get<{ thumbnailPath: string }>('familyAsset', 'asset')?.thumbnailPath, thumbnail)
    assert.ok(existsSync(join(legacy, 'receiver.sqlite')))
    assert.equal(await readFile(thumbnail, 'utf8'), '合成缩略图')
  } finally { original.close() }
})
