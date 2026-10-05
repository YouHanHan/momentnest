import { test } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { join, basename } from 'node:path'
import { tmpdir } from 'node:os'
import sharp from 'sharp'
import { matchingPerson, representativeFaces } from '../src/service/face-grouping.ts'
import type { PersonFaceGroup } from '../src/service/face-grouping.ts'
import { MediaCatalog, faceSimilarity } from '../src/service/media-catalog.ts'
import { Store } from '../src/service/store.ts'
import type { BabyProfile, FamilyJob, MediaAsset } from '../src/shared/family.ts'

const vector = (degrees: number) => [Math.cos(degrees * Math.PI / 180), Math.sin(degrees * Math.PI / 180)]
const face = (id: string, angle: number, assetId = id) => ({ id, assetId, embedding: vector(angle) })
const detected = (embedding: number[], x = 0.1) => ({ x, y: 0.1, width: 0.2, height: 0.3, score: 0.95, embedding })

/** 等待真实后台任务，不以固定延时假定识别结束。 */
async function waitJobs(store: Store): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt++) {
    if (!store.list<FamilyJob>('familyJob').some(job => job.state === 'running')) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('人物测试任务未完成。')
}

test('多场景参考通过强匹配连接，候选接近或缺少组内支持时不强行归组', () => {
  assert.equal(faceSimilarity([NaN, 1], [1, 0]), -1); assert.equal(faceSimilarity([Infinity, 0], [1, 0]), -1)
  const group = { id: 'person', embedding: vector(0), samples: [face('daylight', 0), face('indoors', 40)] }
  assert.ok(faceSimilarity(vector(0), vector(65)) < 0.5)
  assert.deepEqual(matchingPerson(vector(65), [group], new Set(), faceSimilarity), { kind: 'matched', personId: 'person' })
  group.samples.push(face('side', 65))
  for (const angle of [100, 101, 145]) assert.deepEqual(matchingPerson(vector(angle), [group], new Set(), faceSimilarity), { kind: angle === 145 ? 'new' : 'ambiguous' }, '没有可信锚点支持时不能靠自动样本连续扩散')
  group.samples.push(face('legacy-backlight', 100), face('legacy-backlight-second', 101))
  assert.deepEqual(matchingPerson(vector(145), [group], new Set(), faceSimilarity), { kind: 'ambiguous' }, '已有两个相似自动样本也不能绕过原始锚点支持')
  assert.deepEqual(matchingPerson(vector(65), [group], new Set(['person']), faceSimilarity), { kind: 'new' }, '同照片或同帧已经出现的人物不能分配给另一张脸')
  const ambiguous = [{ id: 'left', embedding: vector(-40), samples: [] }, { id: 'right', embedding: vector(40), samples: [] }]
  assert.deepEqual(matchingPerson(vector(0), ambiguous, new Set(), faceSimilarity), { kind: 'ambiguous' }, '两个人物相似度接近时不自动选最近的一个')
  const repeatedFrame = { id: 'video', embedding: vector(0), samples: [face('frame1', 90, 'one-video'), face('frame2', 95, 'one-video')] }
  assert.deepEqual(matchingPerson(vector(100), [repeatedFrame], new Set(), faceSimilarity), { kind: 'ambiguous' }, '同一视频的多个帧不能冒充两个独立媒体支持')
})

test('同一人物跨场景后连续一千张相同人脸不会因候选歧义膨胀为新人物', () => {
  const groups: PersonFaceGroup[] = [], counts = { matched: 0, new: 0, ambiguous: 0 }
  const angles = [0, 65, 40, 30, 10, ...Array<number>(1000).fill(0)]
  for (const [index, angle] of angles.entries()) {
    const current = face(`face-${index}`, angle, `photo-${index}`), decision = matchingPerson(current.embedding, groups, new Set(), faceSimilarity)
    counts[decision.kind]++
    if (decision.kind === 'ambiguous') continue
    let group: PersonFaceGroup
    if (decision.kind === 'new') {
      group = { id: `person-${groups.length}`, embedding: current.embedding, samples: [] }; groups.push(group)
    } else group = groups.find(candidate => candidate.id === decision.personId)!
    group.samples = representativeFaces([...group.samples, current], group.embedding, faceSimilarity)
  }
  assert.equal(angles.length, 1005)
  assert.equal(groups.length, 1, '场景分裂不能让后续完全相同的人脸每张都创建新人物')
  assert.deepEqual(counts, { matched: 1003, new: 1, ambiguous: 1 }, '候选差距不足保留待确认，后续明确命中继续复用分组')
  assert.ok(groups.every(group => group.samples.length <= 8))
})

test('没有可信锚点支持的历史候选不挤掉有效分组，强自动样本单独出现仍待确认', () => {
  const supported: PersonFaceGroup = { id: 'supported', embedding: vector(0), samples: [face('valid-scene', 40)] }
  const unsupported: PersonFaceGroup = { id: 'unsupported', embedding: vector(145), samples: [face('legacy-scene', 65)] }
  const incoming = vector(65)
  assert.ok(faceSimilarity(unsupported.embedding, incoming) < 0.363)
  assert.ok(faceSimilarity(unsupported.samples[0].embedding, incoming) > faceSimilarity(supported.samples[0].embedding, incoming))
  for (const groups of [[supported, unsupported], [unsupported, supported]]) assert.deepEqual(matchingPerson(incoming, groups, new Set(), faceSimilarity), { kind: 'matched', personId: supported.id }, '不合资格的历史最高分不能阻挡有效候选')
  assert.deepEqual(matchingPerson(incoming, [unsupported], new Set(), faceSimilarity), { kind: 'ambiguous' }, '强自动样本缺少可信锚点时既不能加入，也不能当成完全陌生的人')
  assert.deepEqual(matchingPerson(incoming, [unsupported], new Set([unsupported.id]), faceSimilarity), { kind: 'new' }, '同图排他先移除候选，不得被其强相似样本阻止建立独立人物')
  assert.deepEqual(matchingPerson(vector(0), [{ id: 'unrelated', embedding: vector(90), samples: [] }], new Set(), faceSimilarity), { kind: 'new' })
})

test('代表样本数量有界且优先保留独立照片和互补场景', () => {
  const frames = Array.from({ length: 20 }, (_, index) => face(`frame${index}`, 30 + index, 'video'))
  const photos = Array.from({ length: 9 }, (_, index) => face(`photo${index}`, index * 6))
  const selected = representativeFaces([...frames, ...photos], vector(0), faceSimilarity)
  assert.equal(selected.length, 8)
  assert.ok(new Set(selected.map(item => item.assetId)).size >= 7)
  assert.deepEqual(representativeFaces([...photos, ...frames], vector(0), faceSimilarity), selected, '样本选择不随数据库遍历顺序变化')
})

test('新增照片识别复用重启前的多场景样本，合照中的相近人脸保持不同人物', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-person-scenes-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library)
  const store = new Store(join(data, 'family.sqlite')), calls: string[] = []
  store.put('library', { id: libraryId, path: library, name: '合成测试库', enabled: true })
  const embeddings: Record<string, number[]> = { 'a.jpg': vector(0), 'b.jpg': vector(40), 'c.jpg': vector(65) }
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { const name = basename(path); calls.push(name); return name === 'group.jpg' ? [detected(vector(0)), detected(vector(20), 0.6)] : [detected(embeddings[name])] } }
  let catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  const add = async (name: string, color: string) => {
    await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toFile(join(library, name))
    catalog.scanMedia(libraryId); await waitJobs(store); catalog.analyzeFaces(libraryId); await waitJobs(store)
  }
  try {
    await add('a.jpg', '#224466'); await add('b.jpg', '#446688')
    const originalPersonId = catalog.queryMedia({ libraryId, search: 'a.jpg' }).items[0].faces[0].personId
    await catalog.close(); catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
    await add('c.jpg', '#6688aa')
    assert.equal(catalog.queryMedia({ libraryId, search: 'c.jpg' }).items[0].faces[0].personId, originalPersonId)
    assert.equal((await catalog.familyState(libraryId)).people.length, 1)
    await add('group.jpg', '#8866aa')
    const faces = catalog.queryMedia({ libraryId, search: 'group.jpg' }).items[0].faces
    assert.equal(faces.length, 2); assert.notEqual(faces[0].personId, faces[1].personId)
    assert.deepEqual(calls, ['a.jpg', 'b.jpg', 'c.jpg', 'group.jpg'], '已完成照片只复用缓存')
  } finally { await catalog.close(); store.close() }
})

test('人工合并的不同场景锚点在重启后继续指导新增照片分组', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-person-trusted-scenes-')), data = join(directory, 'state'), library = join(directory, 'photos'), libraryId = randomUUID()
  await mkdir(data); await mkdir(library)
  const store = new Store(join(data, 'family.sqlite')), calls: string[] = []
  store.put('library', { id: libraryId, path: library, name: '合成测试库', enabled: true })
  const engine = { async ready() { return { ready: true, error: '' } }, async detect(path: string) { const name = basename(path); calls.push(name); return [detected(vector(name === 'target.jpg' ? 90 : 0))] } }
  let catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
  const add = async (name: string, color: string) => {
    await sharp({ create: { width: 80, height: 60, channels: 3, background: color } }).jpeg().toFile(join(library, name))
    catalog.scanMedia(libraryId); await waitJobs(store); catalog.analyzeFaces(libraryId); await waitJobs(store)
  }
  try {
    await add('source.jpg', '#224466'); await add('target.jpg', '#446688')
    const source = catalog.queryMedia({ libraryId, search: 'source.jpg' }).items[0].faces[0].personId!, target = catalog.queryMedia({ libraryId, search: 'target.jpg' }).items[0].faces[0].personId!
    assert.notEqual(source, target)
    catalog.mergePersons(source, target, libraryId)
    const oldFaces = store.list('familyFace')
    await catalog.close(); catalog = new MediaCatalog(store, data, 'receiver', undefined, engine)
    await add('new-source-scene.jpg', '#6688aa')
    assert.equal(catalog.queryMedia({ libraryId, search: 'new-source-scene.jpg' }).items[0].faces[0].personId, target, '人工确认的原分组锚点参与后续匹配，不只依赖目标首张脸')
    assert.equal((await catalog.familyState(libraryId)).people.length, 1)
    for (const prior of oldFaces as { id: string }[]) assert.deepEqual(store.get('familyFace', prior.id), prior)
    assert.deepEqual(calls, ['source.jpg', 'target.jpg', 'new-source-scene.jpg'])
  } finally { await catalog.close(); store.close() }
})

/** 构造独立领域记录，验证别名不会修改历史人脸、媒体或宝宝档案。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'jinchuan-person-alias-')), store = new Store(join(directory, 'family.sqlite'))
  const firstId = randomUUID(), secondId = randomUUID()
  for (const id of [firstId, secondId]) store.put('library', { id, path: directory, name: id === firstId ? '第一库' : '第二库', enabled: true })
  for (const [id, angle, name] of [['one', 0, '旧名字'], ['two', 20, '保留名字'], ['three', 40, '第三人']] as const) store.put('familyPerson', { id, name, embedding: vector(angle) })
  const addAsset = (letter: string, libraryIds: string[], persons: { id: string; frameTime?: number }[], kind: 'photo' | 'video' = 'photo') => {
    const hash = letter.repeat(64), id = `${hash}-1`
    const asset: MediaAsset = { id, hash, size: 1, filename: `${letter}.jpg`, kind, date: '2026-01-01', dateSource: 'capture', dateConfirmed: true, captureDate: '2026-01-01', creationDate: null, width: 80, height: 60, duration: kind === 'video' ? 8 : 0, available: true, locations: libraryIds.map(libraryId => ({ id: `${letter}:${libraryId}`, path: join(directory, `${letter}.jpg`), label: '测试', source: 'folder', libraryId, available: true })), babyIds: [], personIds: [], favorite: false, faces: [], faceState: 'done' }
    store.put('familyAsset', { ...asset, updatedAt: new Date().toISOString() })
    persons.forEach((person, index) => store.put('familyFace', { ...detected(vector(index * 20)), id: `${letter}:${index}`, assetId: id, personId: person.id, ...(person.frameTime !== undefined ? { frameTime: person.frameTime } : {}) }))
    return id
  }
  const makeCatalog = () => new MediaCatalog(store, directory, 'receiver', undefined, { async ready() { return { ready: true, error: '' } }, async detect() { throw new Error('只读别名验证不能启动检测。') } })
  return { store, firstId, secondId, addAsset, makeCatalog }
}

test('显式合并只写一个别名，各库人物计数、筛选和名称统一且旧脸与宝宝参考原样保留', async () => {
  const { store, firstId, secondId, addAsset, makeCatalog } = await fixture()
  const firstAsset = addAsset('a', [firstId, secondId], [{ id: 'one' }]), targetAsset = addAsset('b', [firstId], [{ id: 'two' }]); addAsset('c', [secondId], [{ id: 'one' }])
  const baby: BabyProfile = { id: randomUUID(), name: '宝宝', birthday: '2026-01-01', autoMatch: false, referenceFaces: [{ assetId: firstAsset, faceId: 'a:0' }], updatedAt: new Date().toISOString() }
  store.put('familyBaby', baby); store.put('familyDecision', { id: `${baby.id}:${targetAsset}`, babyId: baby.id, assetId: targetAsset, state: 'excluded', origin: 'manual', updatedAt: 'preserved' })
  const originals = ['familyFace', 'familyAsset', 'familyBaby', 'familyDecision'].map(kind => [kind, store.list(kind)] as const), catalog = makeCatalog()
  try {
    const changedBefore = Number(store.db.prepare('SELECT total_changes() AS count').get()!.count)
    catalog.mergePersons('one', 'two', firstId)
    assert.equal(Number(store.db.prepare('SELECT total_changes() AS count').get()!.count) - changedBefore, 1)
    assert.equal(store.get<{ mergedIntoId: string }>('familyPerson', 'one')?.mergedIntoId, 'two')
    for (const [kind, records] of originals) assert.deepEqual(store.list(kind), records)
    const state = await catalog.familyState(firstId), other = await catalog.familyState(secondId)
    assert.equal(state.people.length, 1); assert.equal(state.people[0].id, 'two'); assert.equal(state.people[0].name, '保留名字'); assert.equal(state.people[0].assetCount, 2)
    assert.equal(other.people.length, 1); assert.equal(other.people[0].assetCount, 2)
    assert.deepEqual(catalog.queryMedia({ libraryId: secondId, personId: 'one' }).items.map(asset => asset.id).sort(), catalog.queryMedia({ libraryId: secondId, personId: 'two' }).items.map(asset => asset.id).sort())
    const page = catalog.queryMedia({ libraryId: firstId, search: '保留名字' })
    assert.equal(page.total, 2); assert.ok(page.items.every(asset => asset.personIds.length === 1 && asset.personIds[0] === 'two'))
    assert.equal(state.people[0].reference?.face.personId, 'two')
    assert.ok(!JSON.stringify({ state, other, page }).includes('embedding')); assert.ok(!JSON.stringify({ state, other, page }).includes('mergedIntoId'))
    const beforeRepeat = store.db.prepare('SELECT total_changes() AS count').get()!.count
    catalog.mergePersons('one', 'two', firstId); catalog.mergePersons('two', 'one', firstId)
    assert.equal(store.db.prepare('SELECT total_changes() AS count').get()!.count, beforeRepeat, '已合并组再次同向或反向操作均不写循环别名')
    catalog.namePerson('one', '新名字')
    assert.equal((await catalog.familyState(firstId)).people[0].name, '新名字')
  } finally { await catalog.close(); store.close() }
})

test('跨组共现、库范围、活动任务与非法别名拒绝合并且不写入', async () => {
  const { store, firstId, secondId, addAsset, makeCatalog } = await fixture()
  addAsset('a', [firstId], [{ id: 'one' }]); addAsset('b', [firstId], [{ id: 'two' }]); addAsset('c', [secondId], [{ id: 'three' }]); addAsset('d', [secondId], [{ id: 'one' }, { id: 'two' }])
  const catalog = makeCatalog()
  const noWrite = (operation: () => void, expected: RegExp) => {
    const before = store.db.prepare('SELECT total_changes() AS count').get()!.count
    assert.throws(operation, expected)
    assert.equal(store.db.prepare('SELECT total_changes() AS count').get()!.count, before)
  }
  try {
    noWrite(() => catalog.mergePersons('one', 'two', firstId), /同时出现/)
    noWrite(() => catalog.mergePersons('one', 'three', firstId), /当前照片库/)
    noWrite(() => catalog.mergePersons('one', 'one', firstId), /不同的人物/)
    noWrite(() => catalog.mergePersons('missing', 'two', firstId), /不同的人物/)
    noWrite(() => catalog.mergePersons('one', 'two', 'missing-library'), /目录不存在/)
    store.put('familyJob', { id: 'active', kind: 'faces', state: 'running', processed: 0, total: 1, label: '合成任务', error: '', libraryId: secondId })
    noWrite(() => catalog.mergePersons('one', 'two', firstId), /分析正在进行/)
    store.put('familyJob', { id: 'active', kind: 'faces', state: 'done', processed: 1, total: 1, label: '合成任务', error: '' })
    store.put('familyPerson', { id: 'one', name: '', embedding: vector(0), mergedIntoId: 'two' }); store.put('familyPerson', { id: 'two', name: '', embedding: vector(20), mergedIntoId: 'one' })
    noWrite(() => catalog.mergePersons('one', 'two', firstId), /循环/)
  } finally { await catalog.close(); store.close() }
})

test('视频跨帧可合并，同帧共现拒绝，连续别名始终解析到最后人物', async () => {
  for (const sameFrame of [false, true]) {
    const { store, firstId, addAsset, makeCatalog } = await fixture()
    addAsset('a', [firstId], [{ id: 'one', frameTime: 1 }, { id: 'two', frameTime: sameFrame ? 1 : 2 }], 'video'); addAsset('b', [firstId], [{ id: 'three' }])
    const catalog = makeCatalog()
    try {
      if (sameFrame) assert.throws(() => catalog.mergePersons('one', 'two', firstId), /同时出现/)
      else {
        catalog.mergePersons('one', 'two', firstId); catalog.mergePersons('two', 'three', firstId)
        const state = await catalog.familyState(firstId)
        assert.equal(state.people.length, 1); assert.equal(state.people[0].id, 'three'); assert.equal(state.people[0].faceCount, 3)
        assert.equal(catalog.queryMedia({ libraryId: firstId, personId: 'one' }).total, 2)
        assert.ok(catalog.queryMedia({ libraryId: firstId }).items.every(asset => asset.personIds[0] === 'three'))
      }
    } finally { await catalog.close(); store.close() }
  }
})
