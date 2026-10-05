import { after, before, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'
import type { Browser, Locator, Page } from 'playwright'
import { reactive } from 'vue'
import ffmpegPath from 'ffmpeg-static'
import { plainData } from '../src/renderer/src/family-ui.ts'

const executable = [process.env.JINCHUAN_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find((path): path is string => Boolean(path && existsSync(path)))
let server: Awaited<ReturnType<typeof createServer>> | undefined, browser: Browser | undefined, base = ''
const rendererRoot = fileURLToPath(new URL('../src/renderer/', import.meta.url))
const bootstrapPath = '/__family_test_bootstrap.js'
const bootstrapId = '\0family-test-bootstrap'
const bootstrap = 'import {createApp,h,reactive} from "vue";import Workspace from "/src/components/FamilyWorkspace.vue";import App from "/src/App.vue";import UiProvider from "/src/components/UiProvider.vue";import "/src/style.css";window.__testVue={createApp,h,reactive,UiProvider};const props=reactive({module:window.__fixtures.module,page:window.__fixtures.page,receiver:window.__fixtures.receiver,recordsOpen:false});window.__testProps=props;const app=createApp({render:()=>h(UiProvider,null,{default:()=>window.__fixtures.shell?h(App):h("div",{class:"page-content",style:{height:"100%",overflow:"auto"}},[h(Workspace,{...props,onChangePage:page=>props.page=page,onCloseRecords:()=>props.recordsOpen=false})])})});window.__testApp=app;app.mount("#app");'

// 仅用独立浏览器与合成数据验证 Vue 交互，不连接用户当前窗口或接收服务。
before(async () => {
  if (!executable) return
  server = await createServer({ configFile: false, root: rendererRoot, cacheDir: resolve(rendererRoot, '../../../..', '.cache/family-renderer-test-vite'), plugins: [vue(), {
    name: 'family-test-bootstrap',
    resolveId(id) { if (id === bootstrapPath) return bootstrapId },
    load(id) { if (id === bootstrapId) return bootstrap },
    configureServer(instance) {
      instance.middlewares.use((_request, response, next) => {
        if (_request.url !== '/__family_test') { next(); return }
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><div id="app"></div><script type="module" src="${bootstrapPath}"></script></body></html>`)
      })
    },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [resolve(rendererRoot, '../../../..')] } }, logLevel: 'error' })
  await server.listen()
  const address = server.httpServer!.address() as { port: number }; base = `http://127.0.0.1:${address.port}/__family_test`
  browser = await chromium.launch({ executablePath: executable, headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

const installMocks = (scenario: { module?: string; page?: string; count?: number; dates?: string[]; fail?: string[]; jobs?: any[]; faceRebuilds?: any[]; analysis?: any; modelReady?: boolean; noReferences?: boolean; autoMatch?: boolean; dateConfirmed?: boolean; currentLibraryId?: string | null; shell?: boolean; receiverPending?: boolean; clockTime?: string; assetOverrides?: { index: number; values: Record<string, unknown> }[]; ungrouped?: { faces: number; assets: number }; transfer?: { files?: any[]; sessions?: any[]; devices?: any[] } }) => {
  const today = new Date().toLocaleDateString('sv-SE'), birthday = '2024-01-31'
  const assetId = (index: number) => index.toString(16).padStart(64, '0') + '-1024'
  const babies = [{ id: 'baby-one', name: '大宝', birthday, autoMatch: false, referenceFaces: [{ assetId: assetId(1), faceId: 'face-one' }], updatedAt: new Date().toISOString() }, { id: 'baby-two', name: '小宝', birthday: today, autoMatch: false, referenceFaces: [], updatedAt: new Date().toISOString() }]
  const assets = Array.from({ length: scenario.count ?? 2 }, (_, index) => ({ id: assetId(index + 1), hash: (index + 1).toString(16).padStart(64, '0'), size: 1024, filename: `photo-${index + 1}.jpg`, kind: 'photo', date: '2024-03-10', dateSource: scenario.dateConfirmed === false ? 'creation' : 'capture', dateConfirmed: scenario.dateConfirmed !== false, captureDate: '2024-03-10', creationDate: today, width: 320, height: 240, duration: 0, available: true, locations: [{ id: `location-${index}`, source: 'folder', label: '合成数据', path: '', available: true }], babyIds: ['baby-one', 'baby-two'], personIds: ['person-one'], favorite: true, faces: [{ id: index === 0 ? 'face-one' : `face-${index + 1}`, x: 0.2, y: 0.2, width: 0.2, height: 0.3, score: 0.95, personId: 'person-one', personName: '家人' }], faceState: 'done' }))
  const fixtures: any = { module: scenario.module ?? 'baby', page: scenario.page ?? 'timeline', assets, family: { photoCount: assets.length, videoCount: 0, babies, people: [{ id: 'person-one', name: '家人', faceCount: assets.length, assetCount: assets.length }], jobs: [], modelReady: true, modelError: '', candidateCount: 0, importPlans: [] }, receiver: { receiverId: 'receiver', name: '合成测试', port: 0, addresses: [], accepting: false, scanning: false, savedCount: 0, libraries: [{ id: 'library-one', name: '合成归档', path: '合成归档目录', enabled: true }], roots: [{ id: 'root-one', path: '合成来源一', enabled: true, state: 'ready', count: 0, error: '', scannedAt: null }, { id: 'root-two', path: '合成来源二', enabled: true, state: 'ready', count: 0, error: '', scannedAt: null }], devices: [], sessions: [], files: [] }, calls: { queries: [], saved: [], exports: [] }, fail: scenario.fail ?? [], delays: {}, rawUrls: {} }
  Object.assign(fixtures.receiver, { currentLibraryId: scenario.currentLibraryId === undefined ? 'library-one' : scenario.currentLibraryId, currentLibraryAvailable: true })
  fixtures.family.jobs = scenario.jobs ?? []
  fixtures.family.faceRebuilds = structuredClone(scenario.faceRebuilds ?? [])
  if (scenario.analysis) fixtures.family.analysis = structuredClone(scenario.analysis)
  fixtures.family.modelReady = scenario.modelReady ?? true
  fixtures.family.browseRevision = 'fixture-0'
  fixtures.browseRevisionCount = 0
  if (scenario.ungrouped) fixtures.family.ungrouped = structuredClone(scenario.ungrouped)
  fixtures.family.babies[0].autoMatch = scenario.autoMatch ?? false
  if (scenario.noReferences) fixtures.family.babies[0].referenceFaces = []
  fixtures.shell = scenario.shell ?? false
  fixtures.receiverPending = scenario.receiverPending ?? false
  fixtures.pendingReceiverReads = []
  if (scenario.transfer) Object.assign(fixtures.receiver, scenario.transfer)
  for (const asset of fixtures.assets) for (const location of asset.locations) location.libraryId = 'library-one'
  for (let index = 0; index < fixtures.assets.length; index++) if (scenario.dates?.[index]) fixtures.assets[index].date = fixtures.assets[index].captureDate = scenario.dates[index]
  for (const override of scenario.assetOverrides ?? []) Object.assign(fixtures.assets[override.index], structuredClone(override.values))
  fixtures.queryDelays = {}
  fixtures.queryFailures = {}
  fixtures.familyByLibrary = {}
  fixtures.calls.completedQueries = []
  fixtures.calls.completedQueryItems = []
  fixtures.calls.similarQueries = []
  fixtures.calls.completedSimilarQueries = []
  fixtures.similarAssets = []
  fixtures.similarResults = {}
  fixtures.similarDelays = {}
  fixtures.calls.reveals = []
  fixtures.calls.references = fixtures.references = []
  fixtures.calls.referenceAttempts = []
  fixtures.calls.matches = []
  fixtures.calls.completedMatches = []
  fixtures.calls.supplements = []
  fixtures.calls.memberships = []
  fixtures.manualMemberships = {}
  fixtures.matchAssets = []
  fixtures.candidateMatchAssets = []
  fixtures.calls.namedPeople = []
  fixtures.calls.mergeAttempts = []
  fixtures.calls.merged = []
  fixtures.groupingPreviews = {}
  fixtures.groupingWait = false
  fixtures.pendingGrouping = []
  fixtures.calls.groupingPrepares = []
  fixtures.calls.completedGroupingPrepares = []
  fixtures.calls.groupingApplyAttempts = []
  fixtures.calls.groupingApplied = []
  fixtures.calls.groupingUndos = []
  fixtures.warningReports = {}
  fixtures.warningDelays = {}
  fixtures.calls.warningPages = []
  fixtures.calls.completedWarningPages = []
  fixtures.calls.saveAttempts = []
  fixtures.calls.saveScopes = []
  fixtures.calls.dateAttempts = []
  fixtures.calls.analyses = []
  fixtures.calls.rebuilds = []
  fixtures.calls.favoriteAttempts = []
  fixtures.calls.familyReadRevisions = []
  fixtures.calls.watermarkPreviews = []
  fixtures.calls.completedWatermarkPreviews = []
  fixtures.watermarkPreviewDelays = {}
  fixtures.watermarkPreviewUrls = {}
  fixtures.watermarkExportResults = {}
  fixtures.previewUrls = {}
  fixtures.previewFailures = {}
  fixtures.thumbnailFailures = {}
  fixtures.thumbUrls = {}
  fixtures.calls.completedMediaScopes = []
  if (fixtures.assets[0]) fixtures.family.people[0].reference = { assetId: fixtures.assets[0].id, face: fixtures.assets[0].faces[0], kind: 'photo' }
  const textUrl = (text: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="320" height="240"><rect width="320" height="240" fill="#e5eddc"/><text x="20" y="100">${text}</text></svg>`)}`
  const clone = (value: any) => structuredClone(value)
  const fail = (operation: string) => { if (fixtures.fail.includes(operation)) throw new Error(`模拟${operation}失败`) }
  // 成功改变媒体归属才更新浏览版本，重复读取状态不会让同库缓存失效。
  const reviseBrowse = () => { fixtures.family.browseRevision = `fixture-${++fixtures.browseRevisionCount}` }
  const decisionFor = (asset: any, babyId: string) => {
    const key = `${babyId}:${asset.id}`, manual = key in fixtures.manualMemberships
    const stored = asset.babyDecisions?.find((decision: any) => decision.babyId === babyId)
    if (!manual && stored) return { ...stored, state: stored.origin === 'recognition' && stored.state === 'excluded' ? 'unconfirmed' : stored.state }
    const state = manual ? fixtures.manualMemberships[key] ? 'included' : 'excluded' : asset.babyIds.includes(babyId) ? 'included' : asset.candidateBabyIds?.includes(babyId) ? 'candidate' : undefined
    return state ? { id: key, babyId, assetId: asset.id, state, origin: manual ? 'manual' : 'recognition', updatedAt: '合成保留记录' } : undefined
  }
  const matchesBaby = (asset: any, query: any) => {
    if (!query.babyId) return true
    const decision = decisionFor(asset, query.babyId)
    if (query.unconfirmed) return decision?.state !== 'included' && decision?.state !== 'candidate' && !(decision?.state === 'excluded' && decision.origin === 'manual')
    return (query.includeCandidates ? ['included', 'candidate'] : query.candidates ? ['candidate'] : ['included']).includes(decision?.state)
  }
  const reviewReason = (asset: any) => asset.babyReviewReason ?? (asset.faceState === 'pending' ? '尚未分析人脸' : asset.faceState === 'error' ? '人脸分析失败' : !asset.faces.length ? '未检测到可用人脸' : '人脸相似度不足，仍需人工核对')
  const api: any = {
    async getState() {
      fixtures.calls.receiverReads = (fixtures.calls.receiverReads ?? 0) + 1
      if (fixtures.receiverPending) await new Promise(resolve => fixtures.pendingReceiverReads.push(resolve))
      fail('getState'); return clone(fixtures.receiver)
    },
    async getAppInfo() { return { version: 'test', platform: 'win32' } },
    async previewFile(id: string) { (fixtures.calls.receiptPreviews ??= []).push(id); fail('previewFile'); return textUrl(`回执原图 ${id}`) },
    async revealFile(id: string) { (fixtures.calls.receiptReveals ??= []).push(id); fail('revealFile') },
    async setCurrentLibrary(id: string) { (fixtures.calls.libraryChanges ??= []).push(id); fixtures.receiver.currentLibraryId = id },
    async revokeDevice(id: string) { (fixtures.calls.revokedDevices ??= []).push(id); fixtures.receiver.devices.find((device: any) => device.id === id).revoked = true },
    async getFamilyState(libraryId?: string) { (fixtures.calls.familyScopes ??= []).push(libraryId); const family = fixtures.familyByLibrary[libraryId ?? ''] ?? fixtures.family; fixtures.calls.familyReadRevisions.push(family.browseRevision); return clone(family) },
    async getJobWarnings(jobId: string, page = 1, libraryId?: string) {
      const request = { jobId, page, libraryId }; fixtures.calls.warningPages.push(request)
      const warnings = fixtures.warningReports[jobId] ?? fixtures.family.jobs.find((job: any) => job.id === jobId)?.warnings ?? []
      const result = clone({ items: warnings.slice((page - 1) * 20, page * 20), total: warnings.length, page, limit: 20 })
      const delay = fixtures.warningDelays[`${jobId}:${page}`] ?? fixtures.delays.warnings
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      fail('warnings'); fixtures.calls.completedWarningPages.push(request)
      return result
    },
    async queryMedia(query: any) {
      const q = clone(query); fixtures.calls.queries.push(q)
      let items = fixtures.assets.filter((asset: any) => (q.scope !== 'all' || asset.locations.some((location: any) => location.available && fixtures.receiver.libraries.some((library: any) => library.id === location.libraryId && library.enabled))) && (!q.libraryId || asset.locations.some((location: any) => location.libraryId === q.libraryId)) && (!q.kind || asset.kind === q.kind) && (q.favorite === undefined || asset.favorite === q.favorite) && matchesBaby(asset, q) && (!q.personId || asset.personIds.includes(q.personId)) && (!q.ungroupedFaces || asset.faces.some((face: any) => !face.personId)) && (!q.from || asset.date >= q.from) && (!q.to || asset.date <= q.to) && (!q.source || asset.locations.some((location: any) => location.source === q.source)) && (!q.dateSource || asset.dateSource === q.dateSource) && (!q.search || asset.filename.includes(q.search) || asset.faces.some((face: any) => face.personName?.includes(q.search))))
      if (q.referenceBabyId) items = items.filter((asset: any) => fixtures.family.babies.find((baby: any) => baby.id === q.referenceBabyId)?.referenceFaces.some((reference: any) => reference.assetId === asset.id))
      items.sort((left: any, right: any) => !left.date && right.date ? 1 : left.date && !right.date ? -1 : (q.order === 'asc' ? (left.date ?? '').localeCompare(right.date ?? '') : (right.date ?? '').localeCompare(left.date ?? '')) || left.id.localeCompare(right.id))
      const total = items.length; items = items.slice((q.page - 1) * q.limit, q.page * q.limit)
      const result = clone({ items: items.map((asset: any) => ({ ...asset, babyDecisions: fixtures.family.babies.flatMap((baby: any) => {
        const decision = decisionFor(asset, baby.id)
        return decision ? [decision] : []
      }), ...(q.unconfirmed ? { babyReviewReason: reviewReason(asset) } : {}), babyReferenceIds: fixtures.family.babies.filter((baby: any) => baby.referenceFaces.some((reference: any) => reference.assetId === asset.id)).map((baby: any) => baby.id) })), total, page: q.page, limit: q.limit })
      const delay = fixtures.queryDelays[`${q.libraryId}:${q.kind ?? 'all'}:${q.babyId ?? 'all'}:${q.page}`] ?? fixtures.queryDelays[`${q.libraryId}:${q.kind ?? 'all'}:${q.page}`] ?? fixtures.delays[q.libraryId]
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      const failureKey = `${q.libraryId}:${q.kind ?? 'all'}:${q.page}`
      if (fixtures.queryFailures[failureKey] > 0) { fixtures.queryFailures[failureKey]--; throw new Error(`模拟第 ${q.page} 页加载失败`) }
      fixtures.calls.completedQueries.push(q)
      fixtures.calls.completedQueryItems.push({ query: q, ids: result.items.map((asset: any) => asset.id) })
      return result
    },
    async querySimilarFaces(query: any) {
      const q = clone(query); fixtures.calls.similarQueries.push(q)
      const scoped = fixtures.assets.filter((asset: any) => q.scope === 'all' || asset.locations.some((location: any) => location.libraryId === q.libraryId))
      const coverage = { total: scoped.length, done: scoped.filter((asset: any) => asset.faceState === 'done').length, pending: scoped.filter((asset: any) => asset.faceState === 'pending').length, error: scoped.filter((asset: any) => asset.faceState === 'error').length }
      const seed = fixtures.assets.find((asset: any) => asset.id === q.assetId)?.faces.find((face: any) => face.id === q.faceId)
      const matchIds = fixtures.similarResults[`${q.assetId}:${q.faceId}`] ?? (fixtures.similarAssets.length ? fixtures.similarAssets : fixtures.assets.filter((asset: any) => seed?.personId && asset.personIds.includes(seed.personId)).map((asset: any) => asset.id))
      let items = scoped.filter((asset: any) => matchIds.includes(asset.id) && (!q.kind || asset.kind === q.kind))
      items.sort((left: any, right: any) => !left.date && right.date ? 1 : left.date && !right.date ? -1 : (q.order === 'asc' ? (left.date ?? '').localeCompare(right.date ?? '') : (right.date ?? '').localeCompare(left.date ?? '')) || left.id.localeCompare(right.id))
      const page = q.page ?? 1, limit = q.limit ?? 50, total = items.length
      const result = clone({ items: items.slice((page - 1) * limit, page * limit).map((asset: any) => ({ ...asset, similarity: 0.72 })), total, page, limit, scope: q.scope, threshold: 0.4, coverage })
      const delay = fixtures.similarDelays[`${q.scope}:${q.libraryId ?? 'all'}:${q.kind ?? 'all'}:${page}`] ?? fixtures.delays.similar
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      fail('similar'); fixtures.calls.completedSimilarQueries.push(q)
      return result
    },
    async mediaUrl(id: string, thumbnail: boolean, libraryId?: string) { const request = { id, thumbnail, libraryId }; (fixtures.calls.mediaScopes ??= []).push(request); if (!thumbnail && fixtures.delays[id]) await new Promise(resolve => setTimeout(resolve, fixtures.delays[id])); fixtures.calls.completedMediaScopes.push(request); if (thumbnail && fixtures.thumbnailFailures[id]) throw new Error('模拟头像缩略图读取失败'); if (!thumbnail && fixtures.previewFailures[id] > 0) { fixtures.previewFailures[id]--; throw new Error('模拟原图读取失败') } const url = !thumbnail && fixtures.previewUrls[id] ? fixtures.previewUrls[id] : textUrl(thumbnail ? `缩略图 ${id}` : id); if (thumbnail) fixtures.thumbUrls[id] = url; else fixtures.rawUrls[id] = url; return url },
    async saveBaby(profile: any, matchScope?: 'library' | 'all') { if (matchScope !== undefined && matchScope !== 'library' && matchScope !== 'all') throw new Error('选项参数无效。'); const value = clone(profile); fixtures.calls.saveAttempts.push(value); fixtures.calls.saveScopes.push({ babyId: value.id, scope: matchScope }); if (fixtures.delays.saveBaby) await new Promise(resolve => setTimeout(resolve, fixtures.delays.saveBaby)); fail('saveBaby'); fixtures.calls.saved.push(value); fixtures.family.babies = [...fixtures.family.babies.filter((baby: any) => baby.id !== value.id), value] },
    async setBabyMembership(babyId: string, ids: string[], included: boolean) {
      const assetIds = clone(ids); fail('membership')
      const before = fixtures.family.browseRevision
      fixtures.calls.memberships.push({ babyId, ids: assetIds, included })
      for (const asset of fixtures.assets.filter((asset: any) => assetIds.includes(asset.id))) {
        asset.babyIds = asset.babyIds.filter((id: string) => id !== babyId)
        if (included) asset.babyIds.push(babyId)
        asset.candidateBabyIds = (asset.candidateBabyIds ?? []).filter((id: string) => id !== babyId)
        fixtures.manualMemberships[`${babyId}:${asset.id}`] = included
      }
      reviseBrowse()
      return { before, after: fixtures.family.browseRevision }
    },
    async setMediaDate(id: string, date: string) { fixtures.calls.dateAttempts.push({ id, date }); fail('date'); Object.assign(fixtures.assets.find((asset: any) => asset.id === id), { date, dateSource: 'manual', dateConfirmed: true }) },
    async setFavorite(id: string, favorite: boolean) { fixtures.calls.favoriteAttempts.push({ id, favorite }); if (fixtures.delays.favorite) await new Promise(resolve => setTimeout(resolve, fixtures.delays.favorite)); fail('favorite'); const before = fixtures.family.browseRevision; fixtures.assets.find((asset: any) => asset.id === id).favorite = favorite; reviseBrowse(); return { before, after: fixtures.family.browseRevision } },
    async namePerson(id: string, name: string) { fail('person'); fixtures.calls.namedPeople.push({ id, name }); fixtures.family.people.find((person: any) => person.id === id).name = name },
    async mergePersons(sourceId: string, targetId: string, libraryId: string) {
      const request = { sourceId, targetId, libraryId }; fixtures.calls.mergeAttempts.push(request)
      if (fixtures.delays.merge) await new Promise(resolve => setTimeout(resolve, fixtures.delays.merge))
      fail('merge')
      const source = fixtures.family.people.find((person: any) => person.id === sourceId), target = fixtures.family.people.find((person: any) => person.id === targetId)
      if (!source || !target || sourceId === targetId) throw new Error('合并人物不存在或相同')
      for (const asset of fixtures.assets) {
        asset.personIds = [...new Set(asset.personIds.map((id: string) => id === sourceId ? targetId : id))]
        for (const face of asset.faces) if (face.personId === sourceId) Object.assign(face, { personId: targetId, personName: target.name })
      }
      const related = fixtures.assets.filter((asset: any) => asset.personIds.includes(targetId) && asset.locations.some((location: any) => location.libraryId === libraryId))
      target.assetCount = related.length; target.faceCount = related.reduce((count: number, asset: any) => count + asset.faces.filter((face: any) => face.personId === targetId).length, 0)
      fixtures.family.people = fixtures.family.people.filter((person: any) => person.id !== sourceId)
      fixtures.calls.merged.push(request)
    },
    async setBabyReference(babyId: string, assetId: string, faceId: string) {
      fixtures.calls.referenceAttempts.push({ babyId, assetId, faceId })
      if (fixtures.delays.reference) await new Promise(resolve => setTimeout(resolve, fixtures.delays.reference))
      fail('reference')
      fixtures.references.push({ babyId, assetId, faceId })
      const profile = fixtures.family.babies.find((baby: any) => baby.id === babyId)
      if (!profile.referenceFaces.some((reference: any) => reference.assetId === assetId && reference.faceId === faceId)) profile.referenceFaces.push({ assetId, faceId })
      const asset = fixtures.assets.find((item: any) => item.id === assetId)
      asset.babyIds = [...new Set([...asset.babyIds, babyId])]; asset.candidateBabyIds = (asset.candidateBabyIds ?? []).filter((id: string) => id !== babyId)
      fixtures.manualMemberships[`${babyId}:${assetId}`] = true
      // 专门模拟保存参考触发的缓存匹配，普通选脸用例不凭空产生新结果。
      if (fixtures.referenceMatching) {
        fixtures.matchState = fixtures.referenceMatching
        await api.matchBaby(babyId, fixtures.receiver.currentLibraryId, 'library')
        reviseBrowse()
      }
    },
    async preparePersonGrouping(libraryId: string) {
      fixtures.calls.groupingPrepares.push({ libraryId })
      const preview = clone(fixtures.groupingPreviews[libraryId])
      if (fixtures.groupingWait) await new Promise<void>(resolve => fixtures.pendingGrouping.push({ libraryId, resolve }))
      fail('prepareGrouping')
      if (!preview) throw new Error('合成整理方案未设置')
      fixtures.calls.completedGroupingPrepares.push({ libraryId, id: preview.id })
      return preview
    },
    async applyPersonGrouping(planId: string, libraryId: string, sourceIds?: string[]) {
      const request = { planId, libraryId, sourceIds: clone(sourceIds) }
      fixtures.calls.groupingApplyAttempts.push(request)
      fail('applyGrouping')
      fixtures.calls.groupingApplied.push(request)
      const count = sourceIds?.length ?? fixtures.groupingPreviews[libraryId].merges.length
      if (count) fixtures.family.personGroupingUndo = { token: `undo-${planId}`, libraryId, count, expiresAt: Date.now() + 600000 }
      return count
    },
    async undoPersonGrouping(token: string, libraryId: string) { fixtures.calls.groupingUndos.push({ token, libraryId }); fail('undoGrouping'); const count = fixtures.family.personGroupingUndo?.count ?? 0; delete fixtures.family.personGroupingUndo; return count },
    async matchBaby(babyId: string, libraryId?: string, scope = 'library') {
      fixtures.calls.matches.push({ babyId, libraryId, scope })
      if (fixtures.delays.match) await new Promise(resolve => setTimeout(resolve, fixtures.delays.match))
      fail('match')
      const profile = fixtures.family.babies.find((baby: any) => baby.id === babyId)
      const scoped = fixtures.assets.filter((asset: any) => scope === 'all' || !libraryId || asset.locations.some((location: any) => location.libraryId === libraryId))
      for (const asset of scoped.filter((asset: any) => fixtures.matchAssets.includes(asset.id))) {
        if (`${babyId}:${asset.id}` in fixtures.manualMemberships) continue
        asset.babyIds = asset.babyIds.filter((id: string) => id !== babyId)
        asset.candidateBabyIds = (asset.candidateBabyIds ?? []).filter((id: string) => id !== babyId)
        const target = profile.autoMatch && !fixtures.candidateMatchAssets.includes(asset.id) ? asset.babyIds : (asset.candidateBabyIds ??= [])
        if (!target.includes(babyId)) target.push(babyId)
      }
      fixtures.family.candidateCount = fixtures.assets.reduce((count: number, asset: any) => count + (asset.candidateBabyIds?.length ?? 0), 0)
      fixtures.calls.completedMatches.push({ babyId, libraryId, scope })
      const included = scoped.filter((asset: any) => asset.babyIds.includes(babyId)).length, candidates = scoped.filter((asset: any) => asset.candidateBabyIds?.includes(babyId)).length
      const result = { babyId, libraryId, scope, state: fixtures.matchState ?? 'done', processed: fixtures.matchState === 'running' ? 0 : scoped.length, total: scoped.length, included, candidates, addedIncluded: included, addedCandidates: candidates, validReferences: profile.referenceFaces.length, invalidReferences: 0, coverage: { total: scoped.length, done: scoped.filter((asset: any) => asset.faceState === 'done').length, pending: scoped.filter((asset: any) => asset.faceState === 'pending').length, error: scoped.filter((asset: any) => asset.faceState === 'error').length, noFaces: scoped.filter((asset: any) => asset.faceState === 'done' && !asset.faces.length).length, supplementPending: scoped.filter((asset: any) => asset.faceState === 'done' && !asset.faces.length && !asset.supplementComplete).length } }
      fixtures.family.babyMatching = [{ ...result, ...(result.state === 'running' ? { jobId: 'synthetic-match-job' } : {}) }]
      return clone(result)
    },
    async supplementFaces(libraryId?: string) {
      fixtures.calls.supplements.push({ libraryId })
      if (fixtures.delays.supplement) await new Promise(resolve => setTimeout(resolve, fixtures.delays.supplement))
      fail('supplement')
    },
    async rebuildFaceIndex(libraryId: string) {
      fixtures.calls.rebuilds.push({ libraryId })
      if (fixtures.delays.rebuild) await new Promise(resolve => setTimeout(resolve, fixtures.delays.rebuild))
      fail('rebuild')
    },
    async analyzeFaces(libraryId?: string, retryOnlyFailed?: boolean) { fixtures.calls.analyses.push({ libraryId, retryOnlyFailed }) }, async scanMedia(libraryId?: string) { (fixtures.calls.scans ??= []).push(libraryId) }, async revealMedia(id: string, libraryId?: string) { fixtures.calls.reveals.push({ id, libraryId }) }, async addDirectories() { fixtures.calls.directoryChoices = (fixtures.calls.directoryChoices ?? 0) + 1 },
    async previewWatermark(assetId: string, options: any, libraryId?: string) {
      const request = { assetId, options: clone(options), libraryId }, key = `${assetId}:${options.growthMode ?? 'legacy'}:${options.position}`
      fixtures.calls.watermarkPreviews.push(request)
      const delay = fixtures.watermarkPreviewDelays[key] ?? fixtures.delays.watermarkPreview ?? 0
      if (delay) await new Promise(resolve => setTimeout(resolve, delay))
      fail('watermarkPreview')
      const dataUrl = textUrl(`成长水印 ${key}`)
      fixtures.watermarkPreviewUrls[key] = dataUrl; fixtures.calls.completedWatermarkPreviews.push(request)
      return { dataUrl, filename: fixtures.assets.find((asset: any) => asset.id === assetId)?.filename ?? '预览.jpg' }
    },
    async exportWatermark(ids: string[], options: any, libraryId?: string) {
      fixtures.calls.exports.push({ ids: clone(ids), options: clone(options), libraryId }); fail('export')
      return ids.map(id => clone(fixtures.watermarkExportResults[id] ?? { filename: `${id}.jpg`, path: '合成导出结果' }))
    },
    async prepareImport(rootId: string, mode: string, libraryId?: string) { const plan = { id: 'plan-one', rootId, mode, libraryId, state: 'ready', count: 1, bytes: 1024, unknownDates: 0, creationDates: 0, skipped: 1, warnings: ['empty.jpg：文件为空，已跳过'], preview: [{ filename: 'photo-1.jpg', date: '2024-03-10', dateSource: 'capture', relativePath: '2024-03-10/photo-1.jpg' }] }; fixtures.family.importPlans = [plan]; return clone(plan) },
    async executeImport() { fixtures.family.jobs.push({ id: 'job-one', kind: 'import', state: 'done', processed: 1, total: 2, skipped: 1, warnings: ['bad.jpg：文件损坏，已跳过'], label: '合成归档', error: '' }) },
  }
  Object.assign(window, { jinchuan: api, __fixtures: fixtures })
}
async function openPage(scenario: Parameters<typeof installMocks>[0] = {}): Promise<Page> {
  // 固定测试时区，覆盖本地日期与 UTC 跨日的记录标题。
  const page = await browser!.newPage({ timezoneId: 'Asia/Shanghai' })
  page.setDefaultTimeout(7000)
  page.on('pageerror', error => { console.error(`独立界面测试脚本错误：${error.message}`) })
  page.on('requestfailed', request => { console.error(`独立界面请求失败：${request.url()} ${request.failure()?.errorText}`) })
  page.on('console', message => { if (message.type() === 'error') console.error(`独立界面控制台：${message.text()}`) })
  if (scenario.clockTime) await page.clock.install({ time: scenario.clockTime })
  await page.addInitScript(installMocks, scenario)
  await page.goto(base, { waitUntil: 'domcontentloaded', timeout: 30000 })
  if (scenario.shell && (scenario.receiverPending || scenario.fail?.includes('getState'))) {
    await page.waitForFunction(() => (window as any).__fixtures.calls.receiverReads > 0)
    return page
  }
  await page.locator(scenario.shell && scenario.currentLibraryId === null ? '.library-empty' : '.family-workspace').waitFor({ timeout: 10000 })
  await page.waitForFunction(() => (window as any).__fixtures.calls.queries.length > 0 || (window as any).__fixtures.module === 'import' || !(window as any).__fixtures.receiver.currentLibraryId)
  return page
}
const options = { skip: !executable, timeout: 30000 }

/** 识别明细从当前工具入口打开，测试与用户操作保持一致。 */
async function openRecognitionDetails(page: Page): Promise<void> {
  const trigger = page.getByRole('button', { name: '整理与识别详情', exact: true })
  await trigger.waitFor()
  if (await trigger.getAttribute('aria-expanded') !== 'true') await trigger.click()
  await page.locator('.ui-popover-content[aria-label="整理与识别详情"]').waitFor()
}

test('待核对入口保留无脸、低分、未分析、失败和无决定照片，人工确认才移出且不强制设参考', options, async () => {
  const page = await openPage({ count: 8, assetOverrides: [
    { index: 1, values: { babyIds: [], candidateBabyIds: ['baby-one'] } },
    { index: 2, values: { babyIds: [], faces: [], date: null, dateSource: 'unknown', dateConfirmed: false } },
    { index: 3, values: { babyIds: [], babyDecisions: [{ id: 'old-low-score', babyId: 'baby-one', state: 'excluded', origin: 'recognition', score: 0.12 }], babyReviewReason: '人脸相似度较低，尚不足以确认，仍需人工核对' } },
    { index: 4, values: { babyIds: [], faces: [], faceState: 'pending' } },
    { index: 5, values: { babyIds: [], faces: [], faceState: 'error', faceError: '合成读取失败' } },
    { index: 6, values: { babyIds: [] } },
    { index: 7, values: { babyIds: [], babyDecisions: [{ id: 'manual-no', babyId: 'baby-one', state: 'excluded', origin: 'manual' }] } },
  ] })
  try {
    await waitForIndexed(page, 2)
    const entry = page.locator('.baby-result-filter').getByRole('button', { name: '待核对 5', exact: true })
    await entry.waitFor()
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
    await entry.click()
    await waitForIndexed(page, 5)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-8.jpg', exact: true }).count(), 0, '人工排除不会进入待核对')
    assert.deepEqual(await page.locator('.media-candidate').allTextContents(), ['待核对', '待核对', '待核对', '待核对', '待核对'])
    await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-3.jpg', exact: true })
    assert.equal(await preview.getByRole('button', { name: '确认并设为参考', exact: true }).isDisabled(), true)
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    assert.match(await preview.locator('.detail-metadata').innerText(), /未检测到可用人脸/)
    await preview.getByRole('button', { name: '是宝宝', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 4', exact: true }).waitFor()
    assert.match(await preview.locator('.preview-baby-review').innerText(), /人工确认/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-4.jpg', exact: true }).click()
    const low = page.getByRole('dialog', { name: 'photo-4.jpg', exact: true })
    await low.getByRole('button', { name: '照片信息', exact: true }).click()
    assert.match(await low.locator('.detail-metadata').innerText(), /相似度较低.*仍需人工核对/)
    assert.match(await low.locator('.preview-baby-review').innerText(), /待核对/)
    await low.getByRole('button', { name: '不是宝宝', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 3', exact: true }).waitFor()
    assert.match(await low.locator('.preview-baby-review').innerText(), /人工排除/)
    await low.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '全部', exact: true }).click()
    await waitForIndexed(page, 3)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 8)
  } finally { await page.close() }
})

test('待核对无需人脸参考或模型，可从疑似页打开并直接确认无脸照片', options, async () => {
  const page = await openPage({ page: 'candidates', noReferences: true, modelReady: false, assetOverrides: [{ index: 0, values: { babyIds: [], faces: [], faceState: 'pending' } }] })
  try {
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 1', exact: true }).click()
    await waitForIndexed(page, 1)
    assert.match(await page.locator('.media-toolbar-heading').innerText(), /待核对照片与视频/)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(query.unconfirmed, true); assert.equal(query.candidates, undefined); assert.equal(query.includeCandidates, undefined)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    assert.match(await preview.locator('.detail-metadata').innerText(), /尚未分析人脸/)
    await preview.getByRole('button', { name: '是宝宝', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 0', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.matches), [])
  } finally { await page.close() }
})

test('待核对清除隐式成长日期限制，未知日期可见且保留明确搜索、类型和来源筛选', options, async () => {
  const page = await openPage({ count: 3, assetOverrides: [{ index: 1, values: { babyIds: [], faces: [], date: null, dateSource: 'unknown', dateConfirmed: false } }, { index: 2, values: { babyIds: [], faceState: 'error', babyReviewReason: '人脸分析失败：合成文件不可读' } }] })
  try {
    await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).fill('photo-')
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await openTools(page, '.growth-extra')
    await chooseSelect(page, selectControl(page, '成长月份'), '2')
    await page.keyboard.press('Escape')
    await openTools(page, '.advanced-filters')
    await chooseSelect(page, selectControl(page, '来源'), 'folder')
    await page.keyboard.press('Escape')
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true }).click()
    await waitForIndexed(page, 2)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(query.unconfirmed, true); assert.equal(query.from, undefined); assert.equal(query.to, undefined); assert.equal(query.datePending, undefined)
    assert.equal(query.search, 'photo-'); assert.equal(query.kind, 'photo'); assert.equal(query.source, 'folder')
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 1)
    await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).click()
    await page.getByRole('button', { name: '照片信息', exact: true }).click()
    assert.match(await page.locator('.media-dialog .detail-metadata').innerText(), /人脸分析失败：合成文件不可读/)
  } finally { await page.close() }
})

test('待核对按当前库或全部授权目录计数分页，切范围和宝宝不会混入旧未决结果', options, async () => {
  const count = 52
  const page = await openPage({ count, assetOverrides: Array.from({ length: count }, (_, index) => ({ index, values: { babyIds: [], faces: [], ...(index === count - 1 ? { locations: [{ id: 'external-unconfirmed', libraryId: 'library-two', source: 'folder', path: '', available: true }] } : {}) } })) })
  try {
    await page.evaluate(() => { (window as any).__fixtures.receiver.libraries.push({ id: 'library-two', name: '另一个合成库', path: '外部合成目录', enabled: true }) })
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 51', exact: true }).click()
    await waitForIndexed(page, 50)
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 51)
    await chooseSelect(page, selectControl(page, '宝宝查找范围'), 'all')
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 52', exact: true }).waitFor()
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(query.scope, 'all'); assert.equal(query.libraryId, undefined); assert.equal(query.unconfirmed, true)
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1).babyId === 'baby-two')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).babyId), 'baby-two')
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 52', exact: true }).count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
  } finally { await page.close() }
})

test('待核对同数量版本变化刷新未决照片，切模块返回保留范围、入口与待核对计数', options, async () => {
  const page = await openPage({ count: 4, assetOverrides: [{ index: 1, values: { babyIds: [], faces: [] } }, { index: 2, values: { babyIds: [], faceState: 'pending' } }] })
  try {
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true }).click()
    await waitForIndexed(page, 2)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.assets[1].babyIds = ['baby-one']; fixtures.assets[3].babyIds = []
      fixtures.family.browseRevision = `fixture-${++fixtures.browseRevisionCount}`
    })
    await page.getByRole('button', { name: '查看照片 photo-4.jpg', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 0)
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true }).count(), 1)
    await page.evaluate(() => { const props = (window as any).__testProps; props.module = 'library'; props.page = 'all' })
    await page.locator('.media-toolbar-heading').getByRole('heading', { name: '全部媒体', exact: true }).waitFor()
    await waitForIndexed(page, 4)
    await page.evaluate(() => { const props = (window as any).__testProps; props.module = 'baby'; props.page = 'timeline' })
    await waitForIndexed(page, 2)
    const entry = page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true })
    assert.equal(await entry.getAttribute('class'), 'selected')
    assert.equal(await selectValue(selectControl(page, '宝宝查找范围')), 'library')
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-4.jpg', exact: true }).count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
  } finally { await page.close() }
})

test('待核对确认首项、中间或末项后保留原图，上下项继续当前未决范围', options, async () => {
  for (const position of [0, 1, 2]) {
    const page = await openPage({ count: 3, assetOverrides: [0, 1, 2].map(index => ({ index, values: { babyIds: [], faces: [] } })) })
    try {
      await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 3', exact: true }).click()
      await waitForIndexed(page, 3)
      const name = `photo-${position + 1}.jpg`
      await page.getByRole('button', { name: `查看照片 ${name}`, exact: true }).click()
      await waitForPreviewImage(page)
      const preview = page.getByRole('dialog', { name, exact: true }), original = await preview.locator('.detail-media-stage img').getAttribute('src')
      await preview.getByRole('button', { name: position === 1 ? '不是宝宝' : '是宝宝', exact: true }).click()
      await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true }).waitFor()
      assert.equal(await preview.locator('.detail-media-stage img').getAttribute('src'), original)
      assert.equal(await preview.getByRole('button', { name: '上一项', exact: true }).isDisabled(), position === 0)
      assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), position === 2)
      if (position === 1) {
        // 原图解码失败后的原位重试仍需保留已确认项的邻项位置。
        await preview.locator('.detail-media-stage img').dispatchEvent('error')
        await preview.getByRole('button', { name: '重试预览', exact: true }).click()
        await waitForPreviewImage(page)
        assert.equal(await preview.getByRole('button', { name: '上一项', exact: true }).isDisabled(), false)
        assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), false)
      }
      await preview.getByRole('button', { name: position === 2 ? '上一项' : '下一项', exact: true }).click()
      const neighborName = position === 0 ? 'photo-2.jpg' : position === 1 ? 'photo-3.jpg' : 'photo-2.jpg'
      const neighbor = page.getByRole('dialog', { name: neighborName, exact: true })
      await neighbor.waitFor(); await waitForPreviewImage(page)
      if (position === 1) {
        await neighbor.getByRole('button', { name: '上一项', exact: true }).click()
        await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor()
      }
      assert.equal(await page.getByRole('dialog', { name, exact: true }).count(), 0, '继续核对时不重新带回已确认项目')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    } finally { await page.close() }
  }
})

test('待核对确认分页末项后补齐下一张，确认最终末项后仍能返回前项且不漏图', options, async () => {
  const count = 51
  const page = await openPage({ count, assetOverrides: Array.from({ length: count }, (_, index) => ({ index, values: { babyIds: [], faces: [] } })) })
  try {
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 51', exact: true }).click()
    await waitForIndexed(page, 50)
    await renderLastIndexedRow(page)
    await page.getByRole('button', { name: '查看照片 photo-50.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-50.jpg', exact: true })
    await preview.getByRole('button', { name: '不是宝宝', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 50', exact: true }).waitFor()
    assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), false)
    await preview.getByRole('button', { name: '下一项', exact: true }).click()
    const last = page.getByRole('dialog', { name: 'photo-51.jpg', exact: true })
    await last.waitFor(); await waitForPreviewImage(page)
    await last.getByRole('button', { name: '是宝宝', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 49', exact: true }).waitFor()
    assert.equal(await last.getByRole('button', { name: '下一项', exact: true }).isDisabled(), true)
    await last.getByRole('button', { name: '上一项', exact: true }).click()
    await page.getByRole('dialog', { name: 'photo-49.jpg', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 51)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
  } finally { await page.close() }
})

test('待核对明确设参考后保留当前照片，上下项继续未决范围且不重复保存参考', options, async () => {
  const page = await openPage({ count: 3, noReferences: true, assetOverrides: [0, 1, 2].map(index => ({ index, values: { babyIds: [] } })) })
  try {
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 3', exact: true }).click()
    await waitForIndexed(page, 3)
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await preview.getByRole('button', { name: '确认并设为参考', exact: true }).click()
    await preview.locator('.face-selector button').first().click()
    await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 2', exact: true }).waitFor()
    await preview.getByRole('button', { name: '选择宝宝人脸', exact: true }).waitFor()
    assert.equal(await preview.isVisible(), true)
    assert.equal(await preview.getByRole('button', { name: '上一项', exact: true }).isDisabled(), false)
    assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), false)
    await preview.getByRole('button', { name: '下一项', exact: true }).click()
    const next = page.getByRole('dialog', { name: 'photo-3.jpg', exact: true })
    await next.waitFor()
    await next.getByRole('button', { name: '上一项', exact: true }).click()
    await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.references.length), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
  } finally { await page.close() }
})

test('待核对后台分析完成同数量刷新移出当前照片，仍保留原图并继续相邻未决项目', options, async () => {
  const page = await openPage({ count: 4, autoMatch: true, jobs: [{ id: 'faces-running', kind: 'faces', state: 'running', processed: 0, total: 1, label: '合成本地分析', libraryId: 'library-one', error: '' }], assetOverrides: [
    { index: 0, values: { babyIds: [] } }, { index: 1, values: { babyIds: [], faceState: 'pending' } }, { index: 2, values: { babyIds: [] } },
  ] })
  try {
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 3', exact: true }).click()
    await waitForIndexed(page, 3)
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true }), original = await preview.locator('.detail-media-stage img').getAttribute('src')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      Object.assign(fixtures.assets[1], { candidateBabyIds: ['baby-one'], faceState: 'done' })
      fixtures.assets[3].babyIds = []
      Object.assign(fixtures.family.jobs[0], { state: 'done', processed: 1 })
      fixtures.family.browseRevision = `fixture-${++fixtures.browseRevisionCount}`
    })
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueryItems.some((result: any) => result.query.unconfirmed && result.query.limit === 50 && result.ids.includes((window as any).__fixtures.assets[3].id)))
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 3', exact: true }).count(), 1)
    assert.equal(await preview.locator('.detail-media-stage img').getAttribute('src'), original)
    assert.equal(await preview.getByRole('button', { name: '上一项', exact: true }).isDisabled(), false)
    assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), false)
    await preview.getByRole('button', { name: '下一项', exact: true }).click()
    const next = page.getByRole('dialog', { name: 'photo-3.jpg', exact: true })
    await next.waitFor(); await waitForPreviewImage(page)
    await next.getByRole('button', { name: '上一项', exact: true }).click()
    await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
  } finally { await page.close() }
})

test('补检漏识别：宝宝入口沿用当前库或全部目录范围，成功说明疑似需确认且不自动运行', options, async () => {
  const page = await openPage({ analysis: { pending: 0, done: 1, error: 0, faceCount: 0, noFaces: 1, supplementPending: 1 }, assetOverrides: [
    { index: 0, values: { faces: [] } },
    { index: 1, values: { faces: [], locations: [{ id: 'external-no-face', libraryId: 'library-two', source: 'folder', label: '外部合成目录', path: '', available: true }] } },
  ] })
  try {
    await openRecognitionDetails(page)
    const entry = page.locator('.ui-popover-content[aria-label="整理与识别详情"] .supplement-faces-button')
    await entry.waitFor()
    assert.match(await entry.getAttribute('title') ?? '', /当前照片库.*1 项/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements), [])
    await entry.click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.supplements.length === 1)
    await page.getByText(/已开始补检当前照片库中未发现人脸的项目/).waitFor()
    assert.match(await page.locator('.notice').innerText(), /疑似.*人工确认.*处理记录/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements.map((call: any) => call.libraryId ?? null)), ['library-one'])
    await chooseSelect(page, selectControl(page, '宝宝查找范围'), 'all')
    await page.locator('.baby-review-toolbar').getByRole('button', { name: '重新匹配', exact: true }).click()
    await openRecognitionDetails(page)
    const allEntry = page.locator('.baby-match-coverage .supplement-faces-button')
    await allEntry.waitFor()
    assert.match(await allEntry.innerText(), /全部已授权目录 2 项/)
    await allEntry.click()
    await page.getByText(/已开始补检全部已授权目录中未发现人脸的项目/).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements.map((call: any) => call.libraryId ?? null)), ['library-one', null])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('补检漏识别：人物和参考入口只补当前库，模型不可用、识别运行与提交期间禁止重复发起', options, async () => {
  for (const scenario of [
    { module: 'library', page: 'people', modelReady: false, jobs: [] },
    { module: 'baby', page: 'references', modelReady: true, jobs: [{ id: 'faces-running', kind: 'faces', state: 'running', processed: 0, total: 1, label: '合成本地分析', libraryId: 'library-one', error: '' }] },
    { module: 'baby', page: 'references', modelReady: true, jobs: [] },
    { module: 'library', page: 'people', modelReady: true, jobs: [] },
  ]) {
    const page = await openPage({ ...scenario, analysis: { pending: 0, done: 2, error: 0, faceCount: 0, noFaces: 2, supplementPending: 2 } })
    try {
      const entry = page.locator('.recognition-panel .supplement-faces-button')
      await entry.waitFor()
      assert.equal(await entry.isDisabled(), !scenario.modelReady || Boolean(scenario.jobs.length))
      if (scenario.modelReady && !scenario.jobs.length) {
        await page.evaluate(() => { (window as any).__fixtures.delays.supplement = 250 })
        await entry.click()
        assert.equal(await entry.isDisabled(), true)
        await page.getByText(/已开始补检当前照片库中未发现人脸的项目/).waitFor()
        assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements.map((call: any) => call.libraryId)), ['library-one'])
      } else assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements), [])
    } finally { await page.close() }
  }
})

test('补检漏识别：无脸项目已完成补检时保留覆盖说明，入口隐藏且不再发起补检', options, async () => {
  const page = await openPage({ analysis: { pending: 0, done: 2, error: 0, faceCount: 0, noFaces: 2, supplementPending: 0 }, assetOverrides: [{ index: 0, values: { faces: [], supplementComplete: true } }, { index: 1, values: { faces: [], supplementComplete: true } }] })
  try {
    assert.equal(await page.locator('.supplement-faces-button').count(), 0)
    await page.locator('.baby-review-toolbar').getByRole('button', { name: '重新匹配', exact: true }).click()
    await openRecognitionDetails(page)
    await page.locator('.baby-match-coverage').getByText(/未检测到人脸 2/).waitFor()
    assert.equal(await page.locator('.supplement-faces-button').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.supplements), [])
  } finally { await page.close() }
})

test('补检人脸仅在信息或明确选脸时标识，普通预览仍隐藏人脸框', options, async () => {
  const page = await openPage({ assetOverrides: [{ index: 0, values: { faces: [{ id: 'face-one', x: 0.2, y: 0.2, width: 0.2, height: 0.3, score: 0.95, reviewRequired: true }] } }] })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    assert.equal(await page.locator('.media-dialog .face-selector,.media-dialog .face-box').count(), 0)
    await page.getByRole('button', { name: '照片信息', exact: true }).click()
    await page.locator('.detail-metadata').getByText('补检人脸 · 宝宝匹配结果需人工确认', { exact: true }).waitFor()
    assert.equal(await page.locator('.media-dialog .face-selector,.media-dialog .face-box').count(), 0)
    await page.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    await page.locator('.media-dialog .face-selector button').first().click()
    await page.locator('.face-actions .supplement-face-label').getByText('补检人脸', { exact: true }).waitFor()
  } finally { await page.close() }
})

/** 通过照片预览的直接入口打开编辑，保持原相册查询和照片预览。 */
async function openGrowthWatermark(page: Page, filename = 'photo-1.jpg'): Promise<ReturnType<Page['getByRole']>> {
  const preview = page.getByRole('dialog', { name: filename, exact: true })
  if (!(await preview.count())) {
    await page.getByRole('button', { name: `查看照片 ${filename}`, exact: true }).click()
    await waitForPreviewImage(page)
  }
  await preview.getByRole('button', { name: '成长水印', exact: true }).click()
  const editor = page.getByRole('dialog', { name: '成长水印', exact: true })
  await editor.waitFor()
  return editor
}

/** 追加完成以已加载索引为准，可视卡片不代表整库条数。 */
async function waitForIndexed(page: Page, count: number): Promise<void> {
  await page.waitForFunction(expected => document.querySelector('.month-group-actions>span')?.textContent?.includes(`已加载 ${expected} 项`), count)
}

/** 虚拟列表保留完整索引数量和可视唯一性，卡片数量随视口而非总量增长。 */
async function assertVirtualIndex(page: Page, count: number): Promise<void> {
  await waitForIndexed(page, count)
  const names = await page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
  assert.ok(names.length > 0 && names.length < 100, '展开视口保留可操作照片且卡片数有界')
  assert.equal(new Set(names).size, names.length, '当前视口不重复创建同一媒体')
}

/** 使用实际滚动位置更新虚拟视口，不强行点击尚未创建的卡片。 */
async function scrollGallery(page: Page, position: 'top' | 'bottom'): Promise<void> {
  await page.locator('.page-content').evaluate((element, end) => { element.scrollTop = end ? element.scrollHeight - element.clientHeight : 0; element.dispatchEvent(new Event('scroll')) }, position === 'bottom')
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/** 让末行进入虚拟缓冲但不触发底部观察器，保持导航边界回归的加载次序。 */
async function renderLastIndexedRow(page: Page): Promise<void> {
  await page.locator('.page-content').evaluate(element => {
    const grids = [...element.querySelectorAll<HTMLElement>('.media-grid')].filter(grid => grid.getClientRects().length)
    const grid = grids.at(-1)
    if (!grid) throw new Error('当前索引尚未创建月份网格。')
    element.scrollTop = Math.max(0, grid.getBoundingClientRect().bottom - element.getBoundingClientRect().top + element.scrollTop - element.clientHeight - 280)
    element.dispatchEvent(new Event('scroll'))
  })
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

/** 等待下一次实际轮询，验证折叠选择在刷新后仍然保留。 */
async function waitForFamilyPoll(page: Page): Promise<void> {
  const count = await page.evaluate(() => (window as any).__fixtures.calls.familyScopes.length)
  await page.waitForFunction(previous => (window as any).__fixtures.calls.familyScopes.length > previous, count)
}

/** 按真实界面入口展开次要工具，避免直接操作折叠内容。 */
async function openTools(page: Page, selector: string): Promise<void> {
  if (selector === '.family-jobs') { await openRecords(page); return }
  const tools = page.locator(selector)
  if (await tools.getAttribute('data-open') !== 'true') await tools.locator('button[aria-expanded]').click()
}

/** 通过组件业务标识定位下拉框，选项必须由实际点击选中。 */
function selectControl(page: Page, label: string): Locator {
  return page.locator(`.ui-select[data-control-label=${JSON.stringify(label)}]`)
}

async function chooseSelect(page: Page, control: Locator, value: string): Promise<void> {
  await control.getByRole('combobox').click()
  await page.locator(`[role="option"][data-key=${JSON.stringify(value)}]:visible`).click()
}

/** 读取选择的业务值，避免将显示文案误当作接口参数。 */
async function selectValue(control: Locator): Promise<string | null> {
  return control.getAttribute('data-value')
}

/** 展开可见选项核对单选语义，Esc 只收起当前下拉层。 */
async function selectOptions(page: Page, control: Locator): Promise<string[]> {
  await control.getByRole('combobox').click()
  const values = await page.locator('[role="option"]:visible').evaluateAll(elements => elements.map(element => element.getAttribute('data-key')!))
  await page.keyboard.press('Escape')
  return values
}

async function selectedOptionCount(page: Page, control: Locator): Promise<number> {
  await control.getByRole('combobox').click()
  const count = await page.locator('[role="option"][aria-selected="true"]:visible').count()
  await page.keyboard.press('Escape')
  return count
}

/** 使用真实文本输入和键盘确认日期，保持组件校验与业务提交路径。 */
async function fillDate(control: Locator, value: string): Promise<void> {
  await control.fill(value)
  await control.press('Tab')
}

/** 真实点击父层可见空白，避免把被日历覆盖的字段冒充外部点击。 */
async function clickOutsideCalendar(page: Page, container: Locator): Promise<void> {
  const point = await container.evaluate(element => {
    const rect = element.getBoundingClientRect()
    return [{ x: rect.left + 3, y: rect.bottom - 3 }, { x: rect.left + 3, y: rect.top + 3 }, { x: rect.right - 18, y: rect.bottom - 3 }].find(point => {
      const target = document.elementFromPoint(point.x, point.y)
      return target && element.contains(target) && !target.closest('.ui-calendar-popover,.ui-date-picker,button,input,select,label,a')
    })
  })
  assert.ok(point, '父容器必须有位于日历外的真实可见空白')
  await page.mouse.click(point.x, point.y)
}

/** 显式打开处理记录，独立组件由宿主属性控制，整页从固定顶栏进入。 */
async function openRecords(page: Page): Promise<void> {
  if (await page.locator('.processing-records-dialog').count()) return
  if (await page.evaluate(() => (window as any).__fixtures.shell)) await page.locator('.topbar').getByRole('button', { name: /处理记录/ }).click()
  else await page.evaluate(() => { (window as any).__testProps.recordsOpen = true })
  await page.getByRole('dialog', { name: '本地处理记录', exact: true }).waitFor()
}

/** 等待原图解码完成，避免将缩略图或未加载的元素冒充可操作的预览。 */
async function waitForPreviewImage(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const image = document.querySelector('.media-dialog .detail-media-stage img') as HTMLImageElement | null
    // 解码完成后还需等待界面同步加载状态，避免过早读取残留的加载占位。
    const viewport = document.querySelector('.media-dialog .preview-viewport')
    return Boolean(image?.complete && image.naturalWidth > 0 && viewport?.getAttribute('aria-busy') === 'false' && !viewport.querySelector('.preview-placeholder'))
  })
}

/** 按生产界面的悬停交互显示照片选择与收藏按钮，再执行实际点击。 */
async function clickMediaCardControl(page: Page, name: string): Promise<void> {
  const button = page.getByRole('button', { name, exact: true })
  await button.locator('..').hover()
  await button.click()
}

/** 从宝宝相册顶部进入头像草稿，选择照片仍须保存档案后才生效。 */
async function openBabyAvatarPicker(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.locator('.baby-profile-banner').getByRole('button', { name: '更换宝宝头像', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
  await dialog.waitFor()
  if (!(await dialog.locator('.profile-avatar-picker').isVisible())) await dialog.getByRole('button', { name: '选择照片', exact: true }).click()
  await dialog.locator('.profile-avatar-picker').waitFor()
  return dialog
}

/** 从参考页的选择入口启动逐张选脸队列，验证封面点击切换为多选。 */
async function startReferencePicker(page: Page, filenames: string[]): Promise<void> {
  await page.getByRole('button', { name: '选择参考照片', exact: true }).click()
  for (const filename of filenames) await page.getByRole('button', { name: `查看照片 ${filename}`, exact: true }).click()
  await page.getByRole('button', { name: '逐张选择宝宝人脸', exact: true }).click()
  await page.locator('.reference-picker-progress').waitFor()
}

/** 将合成人物分为两个场景，再从卡片入口打开真实合并对话框。 */
async function openPersonMerge(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.evaluate(() => {
    const fixtures = (window as any).__fixtures
    for (const asset of fixtures.assets.slice(1)) { asset.personIds = ['person-two']; for (const face of asset.faces) Object.assign(face, { personId: 'person-two', personName: '另一个场景' }) }
    Object.assign(fixtures.family.people[0], { assetCount: 1, faceCount: 1 })
    const target = fixtures.assets[1]
    fixtures.family.people.push({ id: 'person-two', name: '另一个场景', assetCount: fixtures.assets.length - 1, faceCount: fixtures.assets.length - 1, reference: { assetId: target.id, face: target.faces[0], kind: 'photo' } })
  })
  await page.waitForFunction(() => document.querySelectorAll('.person-card').length === 2)
  await page.locator('.person-card[data-person-id="person-one"] .person-merge').click()
  const dialog = page.getByRole('dialog', { name: '合并人物', exact: true })
  await dialog.waitFor()
  return dialog
}

/** 提供固定审核 DTO，只验证界面流程，不在替身中实现人物整理算法。 */
async function installGroupingPreview(page: Page, count = 1): Promise<void> {
  await page.evaluate(merges => {
    const fixtures = (window as any).__fixtures, target = structuredClone(fixtures.family.people[0])
    const sources = fixtures.assets.slice(1, merges + 1).map((asset: any, index: number) => {
      const id = `fragment-${index + 1}`; asset.personIds = [id]; asset.faces[0].personId = id
      return { id, name: index ? `另一个场景 ${index + 1}` : '', faceCount: 1, assetCount: 1, reference: { assetId: asset.id, face: { ...asset.faces[0] }, kind: 'photo' } }
    })
    fixtures.groupingPreviews['library-one'] = { id: 'grouping-plan-one', libraryId: 'library-one', before: sources.length + 1, after: 1, merges: sources.map((source: any) => ({ source, target, similarity: 0.92 })), ambiguous: 3, conflicts: 2 }
  }, count)
}

/** 通过人物页的明确入口打开审核弹窗，等待比较由各测试控制。 */
async function openPersonGroupingDialog(page: Page): Promise<ReturnType<Page['getByRole']>> {
  await page.getByRole('button', { name: '整理已识别人脸', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '整理已识别人脸', exact: true })
  await dialog.waitFor()
  return dialog
}

/** 构造超过摘要上限的跳过任务，仅使用合成文件位置验证明细分页。 */
function warningJob(count = 47): any {
  const warnings = Array.from({ length: count }, (_, index) => `合成目录/照片-${index + 1}.jpg：文件无法读取，已跳过`)
  return { id: 'warning-job', libraryId: 'library-one', kind: 'import', state: 'done', processed: 2, total: count + 2, skipped: count, warningReportId: 'warning-job', warnings: warnings.slice(0, 20), label: '合成导入', error: '' }
}

test('嵌套响应式档案与水印 DTO 能通过 Electron 同等 structuredClone 边界', () => {
  const value = reactive({ name: '宝宝', referenceFaces: [{ assetId: 'asset', faceId: 'face' }], watermark: { color: '#ffffff' } })
  assert.throws(() => structuredClone({ ...value }))
  const plain = plainData(value)
  assert.deepEqual(structuredClone(plain), { name: '宝宝', referenceFaces: [{ assetId: 'asset', faceId: 'face' }], watermark: { color: '#ffffff' } })
  assert.equal(value.referenceFaces.length, 1)
})

test('旧失败明确作为历史记录，固定顶栏按需查看且进入页面、切页与轮询不强弹', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all', jobs: [
    { id: 'new-success', libraryId: 'library-one', kind: 'scan', state: 'done', processed: 9969, total: 9969, label: 'last-success.jpg', error: '' },
    { id: 'old-error', kind: 'scan', state: 'error', processed: 7005, total: 7005, label: 'IMG_20260624_175354.jpg', error: '媒体大小须在 1 字节到 2 GiB 之间。' },
  ] })
  try {
    const records = page.locator('.family-jobs')
    assert.equal(await records.count(), 0, '处理日志不占用照片滚动区域')
    assert.equal(await page.locator('.processing-records-dialog').count(), 0)
    const trigger = page.locator('.topbar').getByRole('button', { name: /处理记录/ })
    await trigger.waitFor()
    await openRecords(page)
    assert.match(await records.innerText(), /历史任务 · 未记录照片库范围/)
    assert.match(await records.innerText(), /最后进度：IMG_20260624_175354.jpg/)
    assert.match(await records.innerText(), /已完成 · 成功 9969 项/)
    assert.match(await records.innerText(), /已中断 · 成功 7005 项 · 剩余范围未核对/)
    await page.getByRole('dialog', { name: '本地处理记录', exact: true }).getByRole('button', { name: '关闭处理记录', exact: true }).click()
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await waitForFamilyPoll(page)
    assert.equal(await page.locator('.processing-records-dialog').count(), 0)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.family-workspace').waitFor()
    await waitForFamilyPoll(page)
    assert.equal(await page.locator('.processing-records-dialog').count(), 0)
    await openRecords(page)
    assert.equal(await records.locator('.error-text').count(), 1, '保留真实历史错误，不能清空或伪改成成功')
    assert.equal(await page.locator('.family-workspace > .family-jobs').count(), 0, '日志仅挂载于弹窗，不随照片出现在底部')
  } finally { await page.close() }
})

test('运行任务和新失败只更新顶栏状态，用户关闭后轮询不重新打开记录弹窗', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all', jobs: [
    { id: 'current-scan', libraryId: 'library-one', kind: 'scan', state: 'running', processed: 3, total: 10, label: 'current.jpg', error: '' },
  ] })
  try {
    const records = page.locator('.family-jobs')
    const trigger = page.locator('.topbar').getByRole('button', { name: /处理记录/ })
    await trigger.locator('.processing-records-badge').waitFor()
    assert.equal(await trigger.locator('.processing-records-badge').innerText(), '1')
    assert.equal(await records.count(), 0)
    await openRecords(page)
    await records.getByText('当前进度：current.jpg', { exact: true }).waitFor()
    await page.keyboard.press('Escape')
    await waitForFamilyPoll(page)
    assert.equal(await page.locator('.processing-records-dialog').count(), 0)
    await page.evaluate(() => { Object.assign((window as any).__fixtures.family.jobs[0], { state: 'error', error: '本次任务失败，请检查来源目录。' }) })
    await trigger.locator('.processing-records-unread').waitFor()
    assert.equal(await records.count(), 0, '新失败不能强行打断照片浏览')
    await openRecords(page)
    await records.locator('.error-text').waitFor({ state: 'visible' })
    await page.getByRole('dialog', { name: '本地处理记录', exact: true }).getByRole('button', { name: '关闭处理记录', exact: true }).click()
    await waitForFamilyPoll(page)
    assert.equal(await page.locator('.processing-records-dialog').count(), 0)
    await page.evaluate(() => { (window as any).__fixtures.family.jobs.unshift({ id: 'quick-failure', libraryId: 'library-one', kind: 'import', state: 'error', processed: 0, total: 0, label: '新导入', error: '无法访问本次归档目标。' }) })
    await trigger.locator('.processing-records-unread').waitFor()
    assert.equal(await records.count(), 0)
    await openRecords(page)
    await records.getByText('无法访问本次归档目标。', { exact: true }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await page.evaluate(() => { Object.assign((window as any).__fixtures.family.jobs[0], { state: 'done', error: '' }) })
    await waitForFamilyPoll(page)
    assert.equal(await page.locator('.processing-records-dialog').count(), 0, '成功结束也不能将历史失败强弹')
    await trigger.click()
    await records.getByText('已完成 · 成功 0 项', { exact: true }).waitFor({ state: 'attached' })
  } finally { await page.close() }
})

test('顶栏记录按钮支持空记录、关闭按钮、Escape 与遮罩，关闭后保留照片选择', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all' })
  try {
    const trigger = page.locator('.topbar').getByRole('button', { name: '处理记录', exact: true })
    await trigger.waitFor()
    assert.equal(await page.locator('.family-workspace > .family-jobs').count(), 0)
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '选择此页', exact: true }).click()
    const selected = await page.locator('.selection-toolbar').innerText()
    for (const close of ['button', 'escape', 'backdrop'] as const) {
      await trigger.click()
      const dialog = page.getByRole('dialog', { name: '本地处理记录', exact: true })
      await dialog.waitFor()
      assert.equal(await dialog.locator('.job-row').count(), 0, '没有记录时仍可查看空状态')
      assert.equal(await dialog.evaluate(element => element.getAttribute('aria-modal') === 'true' && element.getAttribute('role') === 'dialog'), true, '组件弹窗限制背景操作并提供焦点范围')
      if (close === 'button') await dialog.getByRole('button', { name: '关闭处理记录', exact: true }).click()
      else if (close === 'escape') await page.keyboard.press('Escape')
      else await page.mouse.click(5, 5)
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.selection-toolbar').innerText(), selected, '查看记录与关闭弹窗不能清空媒体选择')
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.warningPages.length), 0)
    }
  } finally { await page.close() }
})

test('当前库菜单内部点击不误关，点击外部与 Escape 关闭且恢复入口焦点', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all' })
  try {
    const trigger = page.locator('.library-toggle'), menu = page.locator('.library-menu')
    await trigger.click(); await menu.waitFor()
    await menu.click({ position: { x: 8, y: 3 } })
    assert.equal(await trigger.getAttribute('aria-expanded'), 'true', '菜单内部留白不是关闭遮罩')
    assert.equal(await menu.isVisible(), true)
    const reads = await page.evaluate(() => (window as any).__fixtures.calls.receiverReads)
    await page.waitForFunction(previous => (window as any).__fixtures.calls.receiverReads > previous, reads)
    assert.equal(await menu.isVisible(), true, '接收状态定时刷新为新快照不能自动关闭菜单')
    await page.locator('.header-brand strong').click()
    await menu.waitFor({ state: 'detached' })
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    await trigger.click(); await menu.waitFor()
    await menu.getByRole('button', { name: /合成归档/ }).focus()
    await page.keyboard.press('Escape')
    await menu.waitFor({ state: 'detached' })
    assert.equal(await trigger.evaluate(element => element === document.activeElement), true, 'Escape 将焦点交还当前库入口')
    await trigger.click(); await menu.waitFor()
    await trigger.click(); await menu.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.libraryChanges ?? []), [], '关闭菜单不能切库')
  } finally { await page.close() }
})

test('宝宝工具、成长月份与更多筛选互斥，内部编辑不误关且收起保留筛选', options, async () => {
  const page = await openPage()
  try {
    const babyTools = page.locator('.baby-tools'), growth = page.locator('.growth-extra'), filters = page.locator('.advanced-filters')
    const source = selectControl(page, '来源'), dateSource = selectControl(page, '日期来源')
    const person = selectControl(page, '人物'), from = page.getByLabel('从', { exact: true }), to = page.getByLabel('到', { exact: true })
    await openTools(page, '.baby-tools')
    await growth.locator('button[aria-expanded]').focus(); await page.keyboard.press('Enter')
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await chooseSelect(page, selectControl(page, '成长月份'), '1')
    assert.equal(await growth.evaluate(element => element.getAttribute('data-open') === 'true'), true, '选择成长月份仍保留当前工具面板')
    await filters.locator('button[aria-expanded]').focus(); await page.keyboard.press('Enter')
    assert.equal(await growth.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await chooseSelect(page, source, 'folder')
    await chooseSelect(page, dateSource, 'capture')
    await chooseSelect(page, person, 'person-one')
    await fillDate(from, '2024-03-01')
    await fillDate(to, '2024-03-31')
    await page.locator('.advanced-filter-fields').getByText('来源', { exact: true }).click()
    assert.equal(await filters.evaluate(element => element.getAttribute('data-open') === 'true'), true, '输入与标签点击不能被外部关闭监听误判')
    await page.locator('.media-toolbar-heading h1').click()
    assert.equal(await filters.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await openTools(page, '.advanced-filters')
    assert.equal(await selectValue(source), 'folder')
    assert.equal(await selectValue(dateSource), 'capture')
    assert.equal(await selectValue(person), 'person-one')
    assert.equal(await from.inputValue(), '2024-03-01')
    assert.equal(await to.inputValue(), '2024-03-31')
    await page.keyboard.press('Escape')
    assert.equal(await filters.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    assert.equal(await filters.locator('button[aria-expanded]').evaluate(element => element === document.activeElement), true)
    await openTools(page, '.baby-tools'); await page.keyboard.press('Escape')
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    assert.equal(await babyTools.locator('button[aria-expanded]').evaluate(element => element === document.activeElement), true)
    await openTools(page, '.growth-extra'); await page.keyboard.press('Escape')
    assert.equal(await growth.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    assert.equal(await growth.locator('button[aria-expanded]').evaluate(element => element === document.activeElement), true)
    await openTools(page, '.growth-extra')
    assert.equal(await selectValue(selectControl(page, '成长月份')), '1')
  } finally { await page.close() }
})

test('顶栏与相册菜单跨组件互斥，打开档案、处理记录或预览先收起旧菜单', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all' })
  try {
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.locator('.baby-profile-banner').waitFor()
    const libraryTrigger = page.locator('.library-toggle'), babyTools = page.locator('.baby-tools'), filters = page.locator('.advanced-filters')
    await libraryTrigger.click(); await page.locator('.library-menu').waitFor()
    await openTools(page, '.baby-tools')
    await page.locator('.library-menu').waitFor({ state: 'detached' })
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), true)
    await libraryTrigger.click(); await page.locator('.library-menu').waitFor()
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await openTools(page, '.baby-tools')
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    const profile = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await profile.waitFor()
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await page.keyboard.press('Escape'); await profile.waitFor({ state: 'detached' })
    assert.equal(await babyTools.evaluate(element => element.getAttribute('data-open') === 'true'), false, '关闭弹窗后不重开旧菜单')
    await openTools(page, '.advanced-filters')
    await openRecords(page)
    assert.equal(await filters.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: '本地处理记录', exact: true }).waitFor({ state: 'detached' })
    await libraryTrigger.click(); await page.locator('.library-menu').waitFor()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    assert.equal(await page.locator('.library-menu').count(), 0)
    await page.keyboard.press('Escape')
    await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.locator('.library-menu').count(), 0, '一次 Escape 关闭当前预览，不被残留菜单截走')
  } finally { await page.close() }
})

test('设备操作菜单彼此及当前库菜单互斥，外点与 Escape 关闭且不撤销设备', options, async () => {
  const devices = [{ id: 'device-one', name: '合成手机一', revoked: false }, { id: 'device-two', name: '合成手机二', revoked: false }]
  const page = await openPage({ shell: true, module: 'library', page: 'all', transfer: { devices } })
  try {
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    const menus = page.locator('.device-tools'), first = menus.nth(0), second = menus.nth(1)
    await first.locator('button[aria-expanded]').click()
    assert.equal(await page.locator('.device-menu:visible').getByRole('button', { name: '撤销授权', exact: true }).isVisible(), true)
    await second.locator('button[aria-expanded]').click()
    assert.equal(await first.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    assert.equal(await second.evaluate(element => element.getAttribute('data-open') === 'true'), true)
    await page.locator('.device-menu:visible').last().getByRole('button', { name: '撤销授权', exact: true }).focus()
    await page.keyboard.press('Escape')
    assert.equal(await second.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    assert.equal(await second.locator('button[aria-expanded]').evaluate(element => element === document.activeElement), true)
    await first.locator('button[aria-expanded]').click()
    await page.locator('.library-toggle').click(); await page.locator('.library-menu').waitFor()
    assert.equal(await first.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    await second.locator('button[aria-expanded]').click()
    await page.locator('.library-menu').waitFor({ state: 'detached' })
    await page.locator('.page-content h1').click()
    assert.equal(await second.evaluate(element => element.getAttribute('data-open') === 'true'), false)
    const help = page.locator('details').filter({ has: page.getByText('连接与归档说明', { exact: true }) })
    await help.locator('summary').click()
    await page.locator('.page-content h1').click()
    assert.equal(await help.evaluate((element: HTMLDetailsElement) => element.open), true, '内联说明不属于临时浮动菜单')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.revokedDevices ?? []), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.receiver.devices), devices)
  } finally { await page.close() }
})

test('宝宝档案内部留白与说明不取消草稿，关闭按钮、真实遮罩和 Escape 只关闭当前编辑', options, async () => {
  const page = await openPage()
  try {
    const original = await page.evaluate(() => structuredClone((window as any).__fixtures.family.babies[0]))
    for (const action of ['button', 'backdrop', 'escape'] as const) {
      const dialog = await openBabyAvatarPicker(page)
      await dialog.getByRole('button', { name: '使用 photo-2.jpg 作为头像', exact: true }).click()
      await dialog.getByLabel('宝宝昵称', { exact: true }).fill('未保存草稿')
      await dialog.click({ position: { x: 3, y: 3 } })
      assert.equal(await dialog.isVisible(), true, '对话框矩形内的空白不算遮罩')
      assert.equal(await dialog.getByLabel('宝宝昵称', { exact: true }).inputValue(), '未保存草稿')
      const help = dialog.locator('.compact-help')
      await help.locator('summary').click()
      await dialog.getByLabel('宝宝昵称', { exact: true }).click()
      assert.equal(await help.evaluate((element: HTMLDetailsElement) => element.open), true, '弹窗内部说明可持续展开')
      if (action === 'button') await dialog.getByRole('button', { name: '关闭宝宝档案', exact: true }).click()
      else if (action === 'backdrop') await page.mouse.click(5, 5)
      else await page.keyboard.press('Escape')
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.baby-profile-banner').isVisible(), true)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies[0]), original)
    }
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0)
  } finally { await page.close() }
})

test('切换照片库关闭处理记录，重新打开仅展示新库任务', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all', jobs: [warningJob(4)] })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.receiver.libraries.push({ id: 'library-two', name: '合成新库', path: '合成新目录', enabled: true })
      const nextFamily = structuredClone(fixtures.family)
      nextFamily.jobs = [{ id: 'new-library-scan', libraryId: 'library-two', kind: 'scan', state: 'done', processed: 1, total: 1, label: 'new-library.jpg', error: '' }]
      fixtures.familyByLibrary['library-two'] = nextFamily
    })
    await openRecords(page)
    await page.locator('.family-jobs').getByText('最后进度：合成导入', { exact: true }).waitFor()
    await page.evaluate(() => { (window as any).__fixtures.receiver.currentLibraryId = 'library-two' })
    await page.waitForFunction(() => (window as any).__fixtures.calls.familyScopes.includes('library-two'))
    assert.equal(await page.locator('.processing-records-dialog').count(), 0, '切库先关闭原库记录')
    await openRecords(page)
    const dialog = page.getByRole('dialog', { name: '本地处理记录', exact: true })
    await dialog.getByText('最后进度：new-library.jpg', { exact: true }).waitFor()
    assert.equal(await dialog.getByText('最后进度：合成导入', { exact: true }).count(), 0)
  } finally { await page.close() }
})

test('跳过原因默认只显示三条摘要，完整四十七条按二十条分页读取且范围固定', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', jobs: [warningJob()] })
  try {
    const warnings = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return fixtures.warningReports['warning-job'] = Array.from({ length: 47 }, (_, index) => `合成目录/照片-${index + 1}.jpg：文件无法读取，已跳过`)
    })
    await openTools(page, '.family-jobs')
    const report = page.locator('.family-jobs .processing-report')
    assert.equal(await report.locator('.processing-warnings li').count(), 3)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.warningPages.length), 0, '展开任务记录不会预先读取全部明细')
    await report.getByRole('button', { name: '查看全部跳过原因（47）', exact: true }).click()
    const collected: string[] = []
    for (let index = 0; index < 3; index++) {
      await report.locator('.warning-pages').getByText(`第 ${index + 1} / 3 页 · 共 47 条`, { exact: true }).waitFor()
      const items = await report.locator('.processing-warnings li').allInnerTexts()
      assert.equal(items.length, index === 2 ? 7 : 20)
      collected.push(...items)
      if (index < 2) await report.getByRole('button', { name: '下一页', exact: true }).click()
    }
    assert.deepEqual(collected, warnings, '所有位置与原因均可到达，不能截断为前二十条')
    assert.equal(await report.getByRole('button', { name: '下一页', exact: true }).isEnabled(), false)
    await report.getByRole('button', { name: '上一页', exact: true }).click()
    await report.locator('.warning-pages').getByText('第 2 / 3 页 · 共 47 条', { exact: true }).waitFor()
    assert.deepEqual(await report.locator('.processing-warnings li').allInnerTexts(), warnings.slice(20, 40))
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.warningPages), [1, 2, 3, 2].map(page => ({ jobId: 'warning-job', page, libraryId: 'library-one' })))
  } finally { await page.close() }
})

test('跳过详情读取失败保留摘要，原因在当前记录可见并可重试完整第一页', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', jobs: [warningJob()], fail: ['warnings'] })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.warningReports['warning-job'] = Array.from({ length: 47 }, (_, index) => `合成目录/照片-${index + 1}.jpg：文件无法读取，已跳过`)
    })
    await openTools(page, '.family-jobs')
    const report = page.locator('.family-jobs .processing-report')
    const summary = await report.locator('.processing-warnings li').allInnerTexts()
    await report.getByRole('button', { name: '查看全部跳过原因（47）', exact: true }).click()
    await report.getByRole('alert').filter({ hasText: '模拟warnings失败' }).waitFor({ state: 'visible' })
    assert.deepEqual(await report.locator('.processing-warnings li').allInnerTexts(), summary)
    assert.equal(await report.locator('.warning-pages').count(), 0, '读取失败不能显示伪造的完整页数')
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await report.getByRole('button', { name: '重试读取', exact: true }).click()
    await report.locator('.warning-pages').getByText('第 1 / 3 页 · 共 47 条', { exact: true }).waitFor()
    assert.equal(await report.getByRole('alert').count(), 0)
    assert.equal(await report.locator('.processing-warnings li').count(), 20)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.warningPages), [1, 1].map(page => ({ jobId: 'warning-job', page, libraryId: 'library-one' })))
  } finally { await page.close() }
})

test('收起详情、关闭记录或切换照片库后，迟到的旧记录页不覆盖摘要和新库原因', options, async () => {
  for (const action of ['collapse', 'close', 'library'] as const) {
    const page = await openPage({ module: 'library', page: 'all', jobs: [warningJob()] })
    try {
      await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        fixtures.warningReports['warning-job'] = Array.from({ length: 47 }, (_, index) => `合成目录/旧库-${index + 1}.jpg：旧库完整原因`)
        fixtures.delays.warnings = 1000
        const family = structuredClone(fixtures.family)
        family.jobs = [{ id: 'new-library-job', libraryId: 'library-two', kind: 'scan', state: 'done', processed: 1, total: 2, skipped: 1, warnings: ['合成新库/新库照片.jpg：新库跳过原因'], label: '合成新库', error: '' }]
        fixtures.familyByLibrary['library-two'] = family
      })
      await openTools(page, '.family-jobs')
      let report = page.locator('.family-jobs .processing-report')
      const original = await report.locator('.processing-warnings li').allInnerTexts()
      await report.getByRole('button', { name: '查看全部跳过原因（47）', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.warningPages.length === 1)
      if (action === 'library') {
        await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
        await page.waitForFunction(() => (window as any).__fixtures.calls.familyScopes.includes('library-two'))
        assert.equal(await page.locator('.processing-records-dialog').count(), 0, '切库不能继续展示原库记录')
        await openTools(page, '.family-jobs')
        report = page.locator('.family-jobs .processing-report')
        await report.getByText('合成新库/新库照片.jpg：新库跳过原因', { exact: true }).waitFor()
      } else if (action === 'close') await page.getByRole('dialog', { name: '本地处理记录', exact: true }).getByRole('button', { name: '关闭处理记录', exact: true }).click()
      else await report.getByRole('button', { name: '收起跳过详情', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.completedWarningPages.length === 1)
      if (action === 'close') {
        assert.equal(await page.locator('.processing-records-dialog').count(), 0, '关闭后迟到明细不能使弹窗重新出现')
        await waitForFamilyPoll(page)
        assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.warningPages.length), 1, '关闭后轮询不继续读取隐藏明细')
        await openRecords(page)
        report = page.locator('.family-jobs .processing-report')
      }
      assert.equal(await report.locator('.warning-pages').count(), 0)
      assert.equal(await report.getByText(/旧库完整原因/).count(), 0)
      assert.deepEqual(await report.locator('.processing-warnings li').allInnerTexts(), action === 'library' ? ['合成新库/新库照片.jpg：新库跳过原因'] : original)
    } finally { await page.close() }
  }
})

test('旧跳过任务只保存二十条时可展开历史样本，并明确其余原因无法补回', options, async () => {
  const legacy = warningJob(35); delete legacy.warningReportId
  const page = await openPage({ module: 'library', page: 'all', jobs: [legacy] })
  try {
    await openTools(page, '.family-jobs')
    const report = page.locator('.family-jobs .processing-report')
    await report.getByText('此历史任务只保留 20 条原因，缺失记录无法补回；重新扫描可生成完整记录。', { exact: true }).waitFor()
    assert.equal(await report.locator('.processing-warnings li').count(), 3)
    await report.getByRole('button', { name: '查看全部跳过原因（35）', exact: true }).click()
    assert.equal(await report.locator('.processing-warnings li').count(), 20, '允许查看已有历史原因，但不能伪造缺失的十五条')
    assert.deepEqual(await report.locator('.processing-warnings li').allInnerTexts(), legacy.warnings)
    assert.equal(await report.locator('.warning-pages').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.warningPages.length), 0, '缺失历史报告不能通过新 API 冒充可补回')
  } finally { await page.close() }
})

test('旧部分完成记录与新跳过仅更新顶栏提示，关闭弹窗后重复轮询不再打开', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all', jobs: [warningJob(4)] })
  try {
    const records = page.locator('.family-jobs')
    assert.equal(await records.count(), 0)
    await waitForFamilyPoll(page)
    assert.equal(await records.count(), 0, '升级前的部分完成记录不能被当作本次新失败强弹')
    assert.equal(await page.locator('.processing-records-unread').count(), 0, '已有历史跳过不冒充本次新提示')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.family.jobs.unshift({ id: 'new-partial', libraryId: 'library-one', kind: 'import', state: 'done', processed: 7, total: 9, skipped: 2, warnings: ['合成目录/新任务.jpg：权限不足'], label: '新任务', error: '' })
    })
    await page.locator('.processing-records-unread').waitFor()
    assert.equal(await records.count(), 0, '新跳过只提醒，不能直接显示日志')
    await openRecords(page)
    assert.equal(await page.locator('.processing-records-unread').count(), 0, '明确查看记录后清除本次未读提示')
    await records.getByText('部分完成 · 成功 7 项 · 跳过 2 项', { exact: true }).waitFor({ state: 'visible' })
    await page.keyboard.press('Escape')
    await waitForFamilyPoll(page)
    assert.equal(await records.count(), 0)
    await waitForFamilyPoll(page)
    assert.equal(await records.count(), 0, '同一部分完成结果不能在关闭后反复显示')
  } finally { await page.close() }
})

test('任务结果区分重复内容、跳过与中断未处理，未知扫描总量不显示百分比', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', jobs: [
    { id: 'scan-running', libraryId: 'library-one', kind: 'scan', state: 'running', processed: 5, total: 5, duplicates: 2, label: 'scan.jpg', error: '' },
    { id: 'import-interrupted', libraryId: 'library-one', kind: 'import', state: 'error', processed: 4, skipped: 2, total: 10, warnings: ['合成目录/跳过.jpg：文件无法读取'], label: 'import.jpg', error: '目标目录不再允许写入' },
    { id: 'legacy-faces', libraryId: 'library-one', kind: 'faces', state: 'error', processed: 6, skipped: 2, total: 10, warnings: ['合成目录/旧人脸.jpg：无法识别'], label: 'legacy-faces.jpg', error: '旧识别任务中断' },
    { id: 'stopped-faces', libraryId: 'library-one', kind: 'faces', state: 'done', processed: 2, total: 5, label: 'stopped-faces.jpg', error: '' },
  ] })
  try {
    const records = page.locator('.family-jobs')
    await openRecords(page)
    const running = records.locator('.job-row').filter({ hasText: 'scan.jpg' })
    assert.match(await running.innerText(), /正在扫描 · 成功 5 项/)
    assert.doesNotMatch(await running.innerText(), /100%|5\s*\/\s*5/)
    assert.equal(await running.locator('progress').getAttribute('value'), null, '边发现边扫描时使用未知总量的进度条')
    assert.match(await running.innerText(), /相同内容合并 2 项；文件已处理，图库按内容展示一次。/)
    const interrupted = records.locator('.job-row').filter({ hasText: 'import.jpg' })
    assert.match(await interrupted.innerText(), /已中断 · 成功 4 项 · 跳过 2 项 · 未处理 4 项/)
    assert.match(await interrupted.innerText(), /目标目录不再允许写入/)
    const legacy = records.locator('.job-row').filter({ hasText: 'legacy-faces.jpg' })
    assert.match(await legacy.innerText(), /已中断 · 成功 4 项 · 跳过 2 项 · 未处理 4 项/, '旧人脸任务的 processed 包含跳过，不能重复算为成功')
    const stopped = records.locator('.job-row').filter({ hasText: 'stopped-faces.jpg' })
    assert.match(await stopped.innerText(), /已停止 · 成功 2 项 · 未处理 3 项/)
    assert.doesNotMatch(await stopped.innerText(), /已完成|部分完成/, '自动整理提前结束不能冒充已处理整批')
  } finally { await page.close() }
})

test('扫描预计时间在图库与处理记录同步展示，统计和收尾保持真实状态', options, async () => {
  const current = Date.now(), startedAt = new Date(current - 90000).toISOString(), processingStartedAt = new Date(current - 30000).toISOString()
  const page = await openPage({ module: 'library', page: 'all', jobs: [{ id: 'timed-scan', libraryId: 'library-one', scanPurpose: 'library', kind: 'scan', state: 'running', processed: 10, total: 10, scanPhase: 'processing', scanTotal: 100, startedAt, processingStartedAt, label: 'sample.jpg', error: '' }] })
  try {
    await page.locator('.gallery-scan-status').getByText(/预计剩余约/).waitFor()
    assert.match(await page.locator('.gallery-scan-status').innerText(), /已处理 10 \/ 100 个文件.*已用时.*预计剩余约/)
    for (const viewport of [{ width: 820, height: 600 }, { width: 1180, height: 800 }]) {
      await page.setViewportSize(viewport)
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, '预计时间文案可换行，不造成页面横向溢出')
    }
    await page.screenshot({ path: resolve('.cache/scan-eta-preview.png') })
    await openRecords(page)
    const row = page.locator('.job-row').filter({ hasText: 'sample.jpg' })
    assert.match(await row.locator('.scan-timing').innerText(), /预计剩余约/)
    assert.equal(await row.locator('progress').getAttribute('max'), '100')
    assert.equal(await row.locator('progress').getAttribute('value'), '10')
    await page.screenshot({ path: resolve('.cache/scan-eta-records-preview.png') })
    await page.evaluate(() => { Object.assign((window as any).__fixtures.family.jobs[0], { scanPhase: 'counting', scanTotal: 40, processed: 0 }) })
    await row.getByText(/正在统计文件数量/).waitFor()
    assert.match(await row.locator('.scan-timing').innerText(), /正在估算剩余时间/)
    assert.equal(await row.locator('progress').getAttribute('value'), null)
    await page.evaluate(() => { Object.assign((window as any).__fixtures.family.jobs[0], { scanPhase: 'processing', scanTotal: 100, processed: 100 }) })
    await row.getByText(/正在收尾/).waitFor()
    assert.equal(await row.locator('progress').getAttribute('value'), '99')
    await page.evaluate(() => { (window as any).__fixtures.family.jobs[0].state = 'done' })
    await row.getByText(/已完成/).waitFor()
    assert.equal(await row.locator('.scan-timing').count(), 0)
  } finally { await page.close() }
})

test('扫描中首批新增照片逐步显示，选择中的图库不自动重载', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 2, jobs: [{ id: 'growing-scan', libraryId: 'library-one', scanPurpose: 'library', kind: 'scan', state: 'running', processed: 2, total: 2, label: 'sample.jpg', error: '' }] })
  try {
    await page.locator('.media-card').first().waitFor()
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, asset = structuredClone(fixtures.assets[0])
      asset.id = 'new-scanned-one'; asset.filename = 'new-scanned-one.jpg'
      fixtures.assets.push(asset); fixtures.family.photoCount = 3; fixtures.family.browseRevision = 'scan-progress-1'; fixtures.family.jobs[0].processed = 3
    })
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 3)
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '选择此页', exact: true }).click()
    const before = await page.evaluate(() => (window as any).__fixtures.calls.queries.length)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, asset = structuredClone(fixtures.assets[0])
      asset.id = 'new-scanned-two'; fixtures.assets.push(asset); fixtures.family.photoCount = 4; fixtures.family.browseRevision = 'scan-progress-2'; fixtures.family.jobs[0].processed = 4
    })
    await page.waitForFunction(() => document.querySelector('.gallery-scan-status')?.textContent?.includes('已处理 4'))
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), before)
    assert.equal(await page.locator('.media-card').count(), 3)
  } finally { await page.close() }
})

test('宝宝相册顶部直接编辑档案与更换头像，空档案仍能从顶部新建', options, async () => {
  const page = await openPage()
  try {
    const banner = page.locator('.baby-profile-banner')
    assert.equal(await banner.getByRole('button', { name: '编辑档案', exact: true }).isVisible(), true)
    assert.equal(await banner.getByRole('button', { name: '更换宝宝头像', exact: true }).isVisible(), true)
    assert.equal(await banner.getByRole('button', { name: '新建档案', exact: true }).isVisible(), true)
    await banner.getByRole('button', { name: '编辑档案', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    assert.equal(await dialog.locator('.profile-avatar-picker').count(), 0, '编辑姓名生日时不摊开照片选择区')
    assert.equal(await dialog.locator('#baby-profile-form input').first().inputValue(), '大宝')
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    await openBabyAvatarPicker(page)
    await page.getByRole('button', { name: '使用 photo-1.jpg 作为头像', exact: true }).waitFor()
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0, '打开与关闭档案不保存')
    await page.evaluate(() => { (window as any).__fixtures.family.babies = [] })
    await waitForFamilyPoll(page)
    await banner.getByRole('button', { name: '新建档案', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.locator('#baby-profile-form input').first().fill('新宝宝')
    await fillDate(dialog.getByLabel('出生日期', { exact: true }), '2024-04-01')
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const saved = await page.evaluate(() => (window as any).__fixtures.calls.saved[0])
    assert.equal(saved.name, '新宝宝'); assert.equal(saved.birthday, '2024-04-01')
    assert.deepEqual(saved.referenceFaces, [])
  } finally { await page.close() }
})

test('档案集中查看跨库参考原图，返回保留草稿，移除取消不生效且保存不改变头像与人工归属', options, async () => {
  const page = await openPage()
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.receiver.libraries.push({ id: 'library-two', name: '另一照片库', path: '合成目录二', enabled: true })
      fixtures.assets[1].locations[0].libraryId = 'library-two'
      fixtures.manualMemberships[`baby-one:${fixtures.assets[0].id}`] = false
      fixtures.family.babies[0].avatarAssetId = fixtures.assets[0].id
      fixtures.family.babies[0].referenceFaces.push({ assetId: fixtures.assets[1].id, faceId: fixtures.assets[1].faces[0].id })
    })
    await waitForFamilyPoll(page)
    await page.getByLabel('搜索照片、人物', { exact: true }).fill('不存在的照片')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.search === '不存在的照片' && query.limit === 50))
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    let dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.getByRole('button', { name: '查看参考照片 photo-2.jpg', exact: true }).waitFor()
    assert.match(await dialog.locator('.profile-reference-heading').innerText(), /2 \/ 20/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.referenceBabyId).at(-1)), { referenceBabyId: 'baby-one', scope: 'all', page: 1, limit: 20 })
    await page.screenshot({ path: resolve(rendererRoot, '../../../..', '.cache/baby-profile-references.png') })
    await dialog.locator('#baby-profile-form input').first().fill('未保存的昵称')
    await dialog.getByRole('button', { name: '查看参考照片 photo-2.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await preview.waitFor()
    await page.waitForFunction(() => { const image = document.querySelector('.media-preview-backdrop img[data-preview-asset]') as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth) })
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await preview.getByRole('button', { name: '确认并设为参考', exact: true }).count(), 0)
    assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isDisabled(), true)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => !request.thumbnail).at(-1).libraryId), undefined)
    assert.equal(await preview.locator('img[data-preview-asset]').getAttribute('src'), await page.evaluate(() => { const fixtures = (window as any).__fixtures; return fixtures.rawUrls[fixtures.assets[1].id] }))
    assert.match(await preview.getByRole('button', { name: '关闭预览', exact: true }).innerText(), /返回档案/)
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.locator('#baby-profile-form input').first().inputValue(), '未保存的昵称')
    await dialog.getByRole('button', { name: '移除参考 photo-1.jpg', exact: true }).click()
    assert.equal(await dialog.locator('.profile-reference-item').count(), 1)
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies.find((baby: any) => baby.id === 'baby-one').referenceFaces.length), 2)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0)
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.getByRole('button', { name: '移除参考 photo-1.jpg', exact: true }).click()
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const result = await page.evaluate(() => { const fixtures = (window as any).__fixtures; return { saved: fixtures.calls.saved.at(-1), assets: fixtures.assets.map((asset: any) => asset.id), manual: fixtures.manualMemberships, references: fixtures.calls.references, analyses: fixtures.calls.analyses } })
    assert.deepEqual(result.saved.referenceFaces, [{ assetId: result.assets[1], faceId: 'face-2' }])
    assert.equal(result.saved.avatarAssetId, result.assets[0]); assert.equal(result.saved.name, '大宝')
    assert.equal(result.manual[`baby-one:${result.assets[0]}`], false)
    assert.deepEqual(result.references, []); assert.deepEqual(result.analyses, [])
  } finally { await page.close() }
})

test('档案保存后添加参考复用逐张明确选脸，清除旧筛选并保留自动匹配与原参考', options, async () => {
  const page = await openPage({ count: 3 })
  try {
    await page.getByLabel('搜索照片、人物', { exact: true }).fill('不相关关键词')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.search === '不相关关键词' && query.limit === 50))
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.locator('#baby-profile-form input').first().fill('新的昵称')
    await dialog.getByRole('checkbox', { name: '自动匹配新照片', exact: true }).check()
    await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => (window as any).__testProps.page === 'references')
    assert.equal(await page.getByLabel('搜索照片、人物', { exact: true }).inputValue(), '')
    await startReferencePicker(page, ['photo-2.jpg'])
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    assert.equal(await preview.locator('.face-selector button[aria-pressed="true"]').count(), 0)
    await preview.locator('.face-selector button').first().click()
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, api = (window as any).jinchuan, readFamily = api.getFamilyState
      let hold = true
      api.getFamilyState = async (libraryId?: string) => {
        const snapshot = await readFamily(libraryId)
        if (hold) { hold = false; await new Promise<void>(resolve => { fixtures.releaseOldReferenceState = resolve }) }
        return snapshot
      }
    })
    await page.waitForFunction(() => Boolean((window as any).__fixtures.releaseOldReferenceState))
    await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    await page.evaluate(() => { (window as any).__fixtures.releaseOldReferenceState() })
    const result = await page.evaluate(() => { const fixtures = (window as any).__fixtures; return { profile: fixtures.family.babies.find((baby: any) => baby.id === 'baby-one'), references: fixtures.calls.references, ids: fixtures.assets.map((asset: any) => asset.id) } })
    assert.equal(result.profile.name, '新的昵称'); assert.equal(result.profile.autoMatch, true)
    assert.deepEqual(result.profile.referenceFaces, [{ assetId: result.ids[0], faceId: 'face-one' }, { assetId: result.ids[1], faceId: 'face-2' }])
    assert.deepEqual(result.references, [{ babyId: 'baby-one', assetId: result.ids[1], faceId: 'face-2' }])
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    await dialog.getByRole('button', { name: '查看参考照片 photo-2.jpg', exact: true }).waitFor()
    assert.equal(await dialog.locator('.profile-reference-item').count(), 2)
  } finally { await page.close() }
})

test('档案添加参考保存失败留在草稿重试，首次建档可保存后选脸', options, async () => {
  const page = await openPage({ fail: ['saveBaby'] })
  try {
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.locator('#baby-profile-form input').first().fill('待保存昵称')
    await dialog.getByRole('button', { name: '移除参考 photo-1.jpg', exact: true }).click()
    await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '模拟saveBaby失败' }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'timeline')
    assert.equal(await dialog.locator('#baby-profile-form input').first().inputValue(), '待保存昵称')
    assert.equal(await dialog.locator('.profile-reference-item').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces.length), 1)
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => (window as any).__testProps.page === 'references')
    await page.getByRole('button', { name: '新建档案', exact: true }).click()
    await dialog.waitFor()
    await dialog.locator('#baby-profile-form input').first().fill('新宝宝')
    await fillDate(dialog.getByLabel('出生日期', { exact: true }), '2024-05-01')
    await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const currentBaby = await page.evaluate(() => (window as any).__fixtures.calls.saved.at(-1))
    await startReferencePicker(page, ['photo-2.jpg'])
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await preview.locator('.face-selector button').first().click()
    await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.references.at(-1).babyId), currentBaby.id)
  } finally { await page.close() }
})

test('档案参考读取失败可重试，失效参考可移除，满二十个时限制添加且缩略图失败不阻止原图', options, async () => {
  const page = await openPage({ count: 20 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.family.babies[0].referenceFaces = fixtures.assets.map((asset: any, index: number) => ({ assetId: asset.id, faceId: index ? asset.faces[0].id : '失效人脸' }))
      fixtures.queryFailures['undefined:all:1'] = 1
      fixtures.thumbnailFailures[fixtures.assets[1].id] = true
    })
    await waitForFamilyPoll(page)
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.getByRole('button', { name: '重新读取参考', exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).isDisabled(), true)
    await dialog.getByRole('button', { name: '重新读取参考', exact: true }).click()
    await dialog.getByText('人脸参考已失效，请重新选脸', { exact: true }).waitFor()
    await dialog.getByText('缩略图不可用，仍可查看原图', { exact: true }).waitFor()
    await page.setViewportSize({ width: 700, height: 620 })
    const layout = await dialog.evaluate(element => {
      const footer = element.querySelector('.baby-profile-footer')!.getBoundingClientRect()
      return { overflow: element.scrollWidth > element.clientWidth, footerVisible: footer.bottom <= innerHeight && footer.top >= 0 }
    })
    assert.deepEqual(layout, { overflow: false, footerVisible: true })
    await page.screenshot({ path: resolve(rendererRoot, '../../../..', '.cache/baby-profile-references-compact.png') })
    await dialog.getByRole('button', { name: '查看参考照片 photo-2.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await dialog.waitFor({ state: 'visible' })
    await dialog.getByRole('button', { name: '移除参考 photo-1.jpg', exact: true }).click()
    assert.equal(await dialog.getByRole('button', { name: '保存并添加参考', exact: true }).isEnabled(), true)
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces.length), 20)
  } finally { await page.close() }
})

test('档案参考原图失败可重试，水印页返回保留草稿且缺失参考仍能移除', options, async () => {
  const page = await openPage({ page: 'watermark' })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.family.babies[0].referenceFaces.push({ assetId: 'missing-media', faceId: 'missing-face' })
      fixtures.previewFailures[fixtures.assets[0].id] = 1
    })
    await waitForFamilyPoll(page)
    await page.getByRole('button', { name: '编辑档案', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await dialog.getByText('原文件暂不可用，记录保留', { exact: true }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '查看参考照片 参考 2', exact: true }).isDisabled(), true)
    await dialog.locator('#baby-profile-form input').first().fill('保留的昵称')
    await dialog.getByRole('button', { name: '查看参考照片 photo-1.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await preview.getByRole('button', { name: '重试预览', exact: true }).click()
    await page.waitForFunction(() => { const image = document.querySelector('.media-preview-backdrop img[data-preview-asset]') as HTMLImageElement | null; return Boolean(image?.complete && image.naturalWidth) })
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'visible' })
    assert.equal(await dialog.locator('#baby-profile-form input').first().inputValue(), '保留的昵称')
    await dialog.getByRole('button', { name: '移除参考 参考 2', exact: true }).click()
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.at(-1).referenceFaces.length), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.exports.length), 0)
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'watermark')
  } finally { await page.close() }
})

test('从当前图库选头像只修改档案草稿，保存后显示新头像并完整保留参考与自动匹配配置', options, async () => {
  const page = await openPage()
  try {
    const original = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.assets[1].babyIds = ['baby-two']
      fixtures.manualMemberships['baby-one:synthetic'] = false
      return { profile: structuredClone(fixtures.family.babies[0]), decisions: structuredClone(fixtures.manualMemberships) }
    })
    const previousAvatar = await page.locator('.baby-profile-banner img').elementHandle()
    assert.ok(previousAvatar)
    let dialog = await openBabyAvatarPicker(page)
    const option = dialog.getByRole('button', { name: '使用 photo-2.jpg 作为头像', exact: true })
    await option.click()
    assert.equal(await option.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies[0].avatarAssetId), undefined)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 24).at(-1)), { libraryId: 'library-one', kind: 'photo', page: 1, limit: 24, order: 'desc' }, '头像选择使用当前完整照片库，不继承宝宝相册筛选')
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const saved = await page.evaluate(() => (window as any).__fixtures.calls.saved.at(-1))
    assert.deepEqual({ id: saved.id, name: saved.name, birthday: saved.birthday, autoMatch: saved.autoMatch, referenceFaces: saved.referenceFaces }, { id: original.profile.id, name: original.profile.name, birthday: original.profile.birthday, autoMatch: original.profile.autoMatch, referenceFaces: original.profile.referenceFaces })
    assert.equal(saved.avatarAssetId, await page.evaluate(() => (window as any).__fixtures.assets[1].id))
    await page.waitForFunction(() => {
      const fixtures = (window as any).__fixtures, image = document.querySelector('.baby-profile-banner img') as HTMLImageElement | null
      return Boolean(image?.complete && image.naturalWidth && image.src === fixtures.thumbUrls[fixtures.assets[1].id])
    })
    await previousAvatar.dispatchEvent('error')
    assert.equal(await page.locator('.baby-profile-banner img').isVisible(), true, '被替换的旧头像迟到错误不能隐藏新头像')
    assert.equal(await page.locator('.baby-profile-banner img').getAttribute('src'), await page.evaluate(() => (window as any).__fixtures.thumbUrls[(window as any).__fixtures.assets[1].id]))
    assert.deepEqual(await page.evaluate(() => ({ decisions: (window as any).__fixtures.manualMemberships, references: (window as any).__fixtures.calls.references, memberships: (window as any).__fixtures.calls.memberships, analyses: (window as any).__fixtures.calls.analyses, scans: (window as any).__fixtures.calls.scans ?? [] })), { decisions: original.decisions, references: [], memberships: [], analyses: [], scans: [] })
    dialog = await openBabyAvatarPicker(page)
    assert.equal(await dialog.getByRole('button', { name: '使用 photo-2.jpg 作为头像', exact: true }).getAttribute('aria-pressed'), 'true', '重新编辑读取已保存的头像')
  } finally { await page.close() }
})

test('取消头像草稿保留原选择，使用默认头像仅清除显示头像并沿用现有参考', options, async () => {
  const page = await openPage()
  try {
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.family.babies[0].avatarAssetId = fixtures.assets[1].id })
    await waitForFamilyPoll(page)
    const original = await page.evaluate(() => structuredClone((window as any).__fixtures.family.babies[0]))
    let dialog = await openBabyAvatarPicker(page)
    await dialog.getByRole('button', { name: '使用 photo-1.jpg 作为头像', exact: true }).click()
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies.find((baby: any) => baby.id === 'baby-one')), original)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0)
    dialog = await openBabyAvatarPicker(page)
    await dialog.getByRole('button', { name: '使用默认头像', exact: true }).click()
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const saved = await page.evaluate(() => (window as any).__fixtures.calls.saved[0])
    assert.equal(saved.avatarAssetId, undefined)
    assert.deepEqual(saved.referenceFaces, original.referenceFaces)
    assert.equal(saved.name, original.name); assert.equal(saved.birthday, original.birthday); assert.equal(saved.autoMatch, original.autoMatch)
    await page.waitForFunction(() => {
      const fixtures = (window as any).__fixtures, image = document.querySelector('.baby-profile-banner img') as HTMLImageElement | null
      return Boolean(image?.complete && image.naturalWidth && image.src === fixtures.thumbUrls[fixtures.assets[0].id])
    })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.references.length), 0)
  } finally { await page.close() }
})

test('头像保存失败在档案弹窗显示原因并保留草稿，明确重试成功后才替换头像', options, async () => {
  const page = await openPage({ fail: ['saveBaby'] })
  try {
    const original = await page.evaluate(() => structuredClone((window as any).__fixtures.family.babies[0]))
    const dialog = await openBabyAvatarPicker(page)
    const option = dialog.getByRole('button', { name: '使用 photo-2.jpg 作为头像', exact: true })
    await option.click()
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '模拟saveBaby失败' }).waitFor({ state: 'visible' })
    assert.equal(await option.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies[0]), original)
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    const attempts = await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts)
    assert.equal(attempts.length, 2)
    assert.ok(attempts.every((profile: any) => profile.id === original.id && profile.avatarAssetId === attempts[0].avatarAssetId))
    assert.deepEqual(attempts[1].referenceFaces, original.referenceFaces)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 1)
  } finally { await page.close() }
})

test('头像照片按当前库分页与搜索，视频、其他库和不可用缩略图不能成为头像', options, async () => {
  const page = await openPage({ count: 30 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      Object.assign(fixtures.assets[26], { kind: 'video', filename: 'avatar-video.mp4' })
      fixtures.assets[24].available = false
      fixtures.thumbnailFailures[fixtures.assets[23].id] = true
      for (const asset of fixtures.assets.slice(27)) asset.locations[0].libraryId = 'library-two'
    })
    const dialog = await openBabyAvatarPicker(page), grid = dialog.locator('.profile-avatar-grid')
    await page.waitForFunction(() => document.querySelectorAll('.profile-avatar-grid button').length === 24)
    assert.equal(await dialog.getByRole('button', { name: '使用 avatar-video.mp4 作为头像', exact: true }).count(), 0)
    assert.equal(await dialog.getByRole('button', { name: '使用 photo-28.jpg 作为头像', exact: true }).count(), 0)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedMediaScopes.some((request: any) => request.thumbnail && request.id === (window as any).__fixtures.assets[23].id))
    assert.equal(await dialog.getByRole('button', { name: '使用 photo-24.jpg 作为头像', exact: true }).isDisabled(), true)
    await dialog.getByRole('button', { name: '加载更多照片', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.profile-avatar-grid button').length === 26)
    assert.equal(await dialog.getByRole('button', { name: '使用 photo-25.jpg 作为头像', exact: true }).isDisabled(), true)
    assert.ok(await page.evaluate(() => (window as any).__fixtures.calls.queries.some((query: any) => query.libraryId === 'library-one' && query.kind === 'photo' && query.page === 2 && query.limit === 24)))
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryAvailable = false })
    await dialog.getByRole('status').filter({ hasText: '当前照片库暂不可用，请连接原目录后选择头像。' }).waitFor()
    assert.equal(await grid.locator('button').evaluateAll(buttons => buttons.every(button => (button as HTMLButtonElement).disabled)), true, '照片库暂不可用时已缓存的头像选项也禁止选择')
    const search = dialog.getByRole('searchbox', { name: '搜索头像照片', exact: true })
    assert.equal(await search.isDisabled(), true)
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryAvailable = true })
    const usable = dialog.getByRole('button', { name: '使用 photo-26.jpg 作为头像', exact: true })
    await usable.click()
    assert.equal(await usable.getAttribute('aria-pressed'), 'true', '恢复当前照片库后缓存照片重新可选')
    await page.evaluate(() => { (window as any).__fixtures.queryDelays['library-one:photo:1'] = 400 })
    await search.fill('photo-26.jpg'); await search.press('Enter')
    await page.waitForFunction(() => document.querySelectorAll('.profile-avatar-grid button').length === 1 && (window as any).__fixtures.calls.completedQueries.some((query: any) => query.limit === 24 && query.search === 'photo-26.jpg'))
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 24 && query.search === 'photo-26.jpg').length), 1, 'Enter 提交后超过防抖间隔仍只读取一次搜索结果')
    assert.equal(await grid.getByRole('button', { name: '使用 photo-26.jpg 作为头像', exact: true }).count(), 1)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 24).at(-1))
    assert.equal(query.libraryId, 'library-one'); assert.equal(query.kind, 'photo'); assert.equal(query.page, 1); assert.equal(query.babyId, undefined)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0)
  } finally { await page.close() }
})

test('切换照片库关闭头像草稿，迟到旧查询不重开弹窗，新库只展示自己的照片', options, async () => {
  const page = await openPage()
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.queryDelays['library-one:photo:1'] = 850
      const other = structuredClone(fixtures.assets[0]); other.id = 'new-avatar-asset'; other.filename = 'new-avatar.jpg'; other.locations[0].libraryId = 'library-two'
      fixtures.assets.push(other)
      ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新头像照片库', path: 'C:/SyntheticAvatar', enabled: true })
    })
    let dialog = await openBabyAvatarPicker(page)
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.libraryId === 'library-one' && query.kind === 'photo' && query.limit === 24))
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    await dialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.libraryId === 'library-one' && query.kind === 'photo' && query.limit === 24))
    assert.equal(await page.getByRole('dialog', { name: '宝宝档案', exact: true }).count(), 0, '迟到结果不能重新打开旧库的草稿')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0)
    dialog = await openBabyAvatarPicker(page)
    await dialog.getByRole('button', { name: '使用 new-avatar.jpg 作为头像', exact: true }).waitFor()
    assert.equal(await dialog.locator('.profile-avatar-grid button').count(), 1)
    assert.equal(await dialog.getByRole('button', { name: '使用 photo-1.jpg 作为头像', exact: true }).count(), 0)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 24).at(-1))
    assert.equal(query.libraryId, 'library-two')
    await dialog.getByRole('button', { name: '使用 new-avatar.jpg 作为头像', exact: true }).click()
    assert.ok(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => request.id === 'new-avatar-asset').every((request: any) => request.libraryId === 'library-two')))
    await page.keyboard.press('Escape'); await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved.length), 0)
  } finally { await page.close() }
})

test('编辑与移除宝宝参考传入普通数据，后端失败保留批量选择', options, async () => {
  const page = await openPage({ page: 'references', fail: ['membership'] })
  try {
    await page.getByRole('button', { name: '移除参考', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.saved.length === 1)
    assert.equal(await page.locator('.reference-item').count(), 0)
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    await page.locator('#baby-profile-form input').first().fill('大宝改名')
    await page.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.saved.length === 2)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.saveScopes), [{ babyId: 'baby-one', scope: 'library' }, { babyId: 'baby-one', scope: 'library' }], '档案编辑与移除参考沿用用户选中的宝宝查找范围')
    await page.evaluate(() => { const props = (window as any).__testProps; props.module = 'library'; props.page = 'all' })
    await page.locator('.media-card').first().waitFor()
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '选择此页', exact: true }).click()
    await chooseSelect(page, selectControl(page, '加入的宝宝相册'), 'baby-one')
    await page.getByRole('button', { name: '加入宝宝相册', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '模拟membership失败' }).waitFor()
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 2 项/)
  } finally { await page.close() }
})

test('拍摄日期保存失败不伪装已确认，人物命名失败保留编辑对话框', options, async () => {
  const page = await openPage({ module: 'baby', page: 'references', fail: ['date', 'person'], dateConfirmed: false })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    await page.getByRole('button', { name: '照片信息', exact: true }).click()
    await fillDate(page.locator('.media-dialog').getByLabel('确认或修正实际拍摄日期', { exact: true }), '2024-03-12')
    await page.getByRole('button', { name: '保存确认日期', exact: true }).click()
    await page.locator('.media-dialog .preview-information').getByRole('alert').filter({ hasText: '模拟date失败' }).waitFor({ state: 'visible' })
    assert.match(await page.locator('.detail-metadata').innerText(), /2024-03-10 · 文件创建日期/)
    assert.doesNotMatch(await page.locator('.detail-metadata').innerText(), /手动确认日期/)
    await page.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    await page.getByRole('button', { name: /选择人脸 1/ }).click()
    await page.getByRole('button', { name: '给人物命名', exact: true }).click()
    const personDialog = page.getByRole('dialog', { name: '人物名称', exact: true })
    const firstControl = personDialog.getByRole('button', { name: '关闭', exact: true }), lastControl = personDialog.getByRole('button', { name: '保存名称', exact: true })
    await lastControl.click()
    await personDialog.getByRole('alert').filter({ hasText: '模拟person失败' }).waitFor({ state: 'visible' })
    assert.equal(await personDialog.count(), 1)
    await lastControl.focus(); await page.keyboard.press('Tab')
    assert.equal(await firstControl.evaluate(element => element === document.activeElement), true, '人物名称末项 Tab 回到首个控件')
    await page.keyboard.press('Shift+Tab')
    assert.equal(await lastControl.evaluate(element => element === document.activeElement), true, '人物名称首项 Shift+Tab 回到末个控件')
    for (let index = 0; index < 6; index++) {
      await page.keyboard.press('Tab')
      assert.equal(await personDialog.evaluate(element => element.contains(document.activeElement)), true, '命名期间焦点不落入后面的照片预览或图库')
    }
    await page.keyboard.press('Escape')
    await personDialog.waitFor({ state: 'detached' })
    await page.waitForFunction(() => Boolean(document.querySelector('.media-dialog')?.contains(document.activeElement)))
    assert.equal(await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).count(), 1, 'Escape 只关闭命名，照片预览继续保留')
    assert.equal(await page.locator('.detail-media-stage img').isVisible(), true)
  } finally { await page.close() }
})

test('水印页退出恢复视频筛选，切换宝宝重置不适用的成长月份', options, async () => {
  const page = await openPage()
  try {
    await page.locator('.media-kind-filter').getByRole('button', { name: '视频', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1).kind === 'video')
    await page.evaluate(() => { (window as any).__testProps.page = 'watermark' })
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).kind === 'photo')
    const watermarkQueries = await page.evaluate(() => (window as any).__fixtures.calls.queries.length)
    await page.evaluate(() => { (window as any).__testProps.page = 'timeline' })
    await page.waitForFunction(() => document.querySelector('.media-kind-filter button:last-child')?.classList.contains('selected') && !document.querySelector('.watermark-layout'))
    assert.equal(await page.locator('.media-card').count(), 0, '返回水印前的视频筛选和空结果，而不是沿用水印照片')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), watermarkQueries, '返回同库已有索引直接恢复缓存，不重复查询')
    await page.locator('.media-kind-filter').getByRole('button', { name: '全部', exact: true }).click()
    await openTools(page, '.growth-extra')
    await chooseSelect(page, selectControl(page, '成长月份'), '2')
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).babyId === 'baby-two')
    await openTools(page, '.growth-extra')
    assert.equal(await selectValue(selectControl(page, '成长月份')), 'all')
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(query.from, undefined); assert.equal(query.to, undefined)
  } finally { await page.close() }
})

test('取消连续加载后的末项收藏更新列表，迟到的详情请求不覆盖新照片', options, async () => {
  const page = await openPage({ module: 'library', page: 'favorites', count: 51 })
  try {
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 51 项'))
    await scrollGallery(page, 'bottom')
    const queryCount = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await clickMediaCardControl(page, '取消收藏 photo-51.jpg')
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queryCount, '取消收藏只更新当前索引，不重读已加载的所有页面')
    assert.equal(await page.getByRole('button', { name: '取消收藏 photo-51.jpg', exact: true }).count(), 0)
    await scrollGallery(page, 'top')
    const ids = await page.evaluate(() => (window as any).__fixtures.assets.slice(0, 2).map((asset: any) => asset.id))
    await page.evaluate(([first, second]) => { const fixtures = (window as any).__fixtures; fixtures.delays[first] = 800; fixtures.delays[second] = 10 }, ids)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await page.getByRole('dialog').getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    await page.locator('.detail-media-stage img').waitFor()
    await page.waitForTimeout(1000)
    const source = await page.locator('.detail-media-stage img').getAttribute('src')
    assert.equal(source, await page.evaluate(id => (window as any).__fixtures.rawUrls[id], ids[1]))
  } finally { await page.close() }
})

test('导入参数改变使旧计划失效，预扫描与完成任务展示跳过原因', options, async () => {
  const page = await openPage({ module: 'import', page: 'folder' })
  try {
    await chooseSelect(page, selectControl(page, '来源文件夹'), 'root-one')
    await page.getByRole('button', { name: '预览导入计划', exact: true }).click()
    await page.getByText('本次预扫描跳过 1 项，来源文件保留。', { exact: true }).waitFor()
    assert.match(await page.locator('.processing-warnings').innerText(), /empty.jpg/)
    await chooseSelect(page, selectControl(page, '来源文件夹'), 'root-two')
    assert.equal(await page.getByRole('button', { name: '确认复制归档', exact: true }).count(), 0)
    await page.getByRole('button', { name: '预览导入计划', exact: true }).click()
    await page.getByRole('button', { name: '确认复制归档', exact: true }).click()
    await openTools(page, '.family-jobs')
    await page.getByText('已跳过 1 项，请检查下方原因；来源文件保留。', { exact: true }).waitFor()
    assert.match(await page.locator('.family-jobs .processing-warnings').innerText(), /bad.jpg/)
  } finally { await page.close() }
})

test('复制归档固定当前库，同目录和父子目录拒绝准备且切库使界面计划失效', options, async () => {
  const page = await openPage({ module: 'import', page: 'folder' })
  try {
    await page.evaluate(() => {
      const receiver = (window as any).__testProps.receiver
      receiver.roots = [{ id: 'root-one', path: 'C:/Photos', enabled: true }, { id: 'root-two', path: 'C:/Photos2', enabled: true }]
      receiver.libraries = [{ id: 'same', path: 'c:\\photos\\', enabled: true }, { id: 'child', path: 'C:/Photos/archive', enabled: true }, { id: 'parent', path: 'C:/', enabled: true }, { id: 'sibling', path: 'C:/Photos2', enabled: true }]
      receiver.currentLibraryId = 'same'
    })
    await chooseSelect(page, selectControl(page, '来源文件夹'), 'root-one')
    assert.equal(await page.locator('.target-picker [role="combobox"]').count(), 0)
    for (const id of ['same', 'child', 'parent']) {
      await page.evaluate(value => { (window as any).__testProps.receiver.currentLibraryId = value }, id)
      await page.waitForFunction(() => Boolean((document.querySelector('.family-workspace .primary-button') as HTMLButtonElement)?.disabled))
      assert.equal(await page.getByRole('button', { name: '预览导入计划', exact: true }).isDisabled(), true, `当前库 ${id} 应拒绝复制`)
    }
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'sibling' })
    await page.getByRole('button', { name: '预览导入计划', exact: true }).click()
    await page.getByRole('button', { name: '确认复制归档', exact: true }).waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.importPlans[0].libraryId), 'sibling')
    await chooseSelect(page, selectControl(page, '来源文件夹'), 'root-two')
    assert.equal(await page.getByRole('button', { name: '确认复制归档', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '预览导入计划', exact: true }).isDisabled(), true)
    assert.match(await page.getByRole('status').innerText(), /不能是同一个目录/)
    await openRecords(page)
    await page.getByText('原文件保留规则', { exact: true }).click()
    assert.match(await page.locator('.media-preservation-tip').innerText(), /不删除文件/)
  } finally { await page.close() }
})

test('启动读取尚未完成时不提示重新选目录，读完直接恢复已有图库且不扫描', options, async () => {
  const page = await openPage({ shell: true, receiverPending: true })
  try {
    assert.equal(await page.getByRole('heading', { name: '选择照片库文件夹', exact: true }).count(), 0)
    assert.match(await page.getByRole('status').innerText(), /正在读取照片库/)
    assert.equal(await page.getByRole('button', { name: '当前照片库', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('button', { name: '切换照片库', exact: true }).isDisabled(), true)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.receiverPending = false
      for (const resolve of fixtures.pendingReceiverReads.splice(0)) resolve()
    })
    await page.locator('.media-card').first().waitFor()
    assert.match(await page.locator('.library-toggle').innerText(), /合成归档/)
    const calls = await page.evaluate(() => (window as any).__fixtures.calls)
    assert.equal(calls.directoryChoices ?? 0, 0)
    assert.deepEqual(calls.scans ?? [], [])
    assert.ok(calls.queries.every((query: any) => query.libraryId === 'library-one'))
  } finally { await page.close() }
})

test('启动读取失败明确报错，重试恢复原库且不重新选目录或扫描', options, async () => {
  const page = await openPage({ shell: true, fail: ['getState'] })
  try {
    await page.getByRole('heading', { name: '读取照片库失败', exact: true }).waitFor()
    assert.equal(await page.getByRole('heading', { name: '选择照片库文件夹', exact: true }).count(), 0)
    assert.match(await page.locator('.receiver-startup').innerText(), /模拟getState失败/)
    assert.equal(await page.locator('.library-toggle').isDisabled(), true)
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await page.getByRole('button', { name: '重新读取照片库', exact: true }).click()
    await page.locator('.media-card').first().waitFor()
    assert.match(await page.locator('.library-toggle').innerText(), /合成归档/)
    const calls = await page.evaluate(() => (window as any).__fixtures.calls)
    assert.equal(calls.directoryChoices ?? 0, 0)
    assert.deepEqual(calls.scans ?? [], [])
  } finally { await page.close() }
})

test('首次读取成功确认没有当前库后才提供目录选择', options, async () => {
  const page = await openPage({ shell: true, receiverPending: true, currentLibraryId: null })
  try {
    assert.equal(await page.locator('.library-empty').count(), 0)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.receiverPending = false
      for (const resolve of fixtures.pendingReceiverReads.splice(0)) resolve()
    })
    await page.getByRole('heading', { name: '选择照片库文件夹', exact: true }).waitFor()
    assert.equal(await page.locator('.library-toggle').isDisabled(), false)
    await page.getByRole('button', { name: '选择照片库文件夹', exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.directoryChoices), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), 0)
  } finally { await page.close() }
})

test('没有当前库时不读取全局媒体，选择后切换模块仍使用同一库', options, async () => {
  const page = await openPage({ shell: true, currentLibraryId: null, module: 'library', page: 'all' })
  try {
    assert.equal(await page.locator('.media-card').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), 0)
    await page.locator('.library-toggle').click()
    await page.locator('.library-menu').getByRole('button', { name: /合成归档/ }).click()
    await page.locator('.media-card').first().waitFor()
    for (const module of ['宝宝相册', '导入与归档', '照片与视频']) {
      await page.locator('.module-navigation').getByRole('button', { name: module, exact: true }).click()
      assert.match(await page.locator('.library-toggle').innerText(), /合成归档/)
    }
    const calls = await page.evaluate(() => (window as any).__fixtures.calls)
    assert.deepEqual(calls.libraryChanges, ['library-one'])
    assert.ok(calls.queries.length > 0 && calls.queries.every((query: any) => query.libraryId === 'library-one'))
  } finally { await page.close() }
})

test('切换当前库清除选择和详情，媒体与预览调用限定当前库', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '选择此页', exact: true }).click()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.at(-1).libraryId), 'library-one')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      const other = structuredClone(fixtures.assets[1]); other.id = 'other-asset'; other.filename = 'other-library.jpg'; other.locations[0].libraryId = 'library-two'
      fixtures.assets.push(other)
      const receiver = (window as any).__testProps.receiver
      receiver.libraries.push({ id: 'library-two', name: '其他库', path: 'C:/Other', enabled: true })
      receiver.currentLibraryId = 'library-two'
    })
    await page.getByRole('button', { name: '查看照片 other-library.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.media-dialog').count(), 0)
    assert.equal(await page.locator('.selection-toolbar').count(), 0)
    assert.equal(await page.locator('.media-card').count(), 1)
    const calls = await page.evaluate(() => (window as any).__fixtures.calls)
    assert.equal(calls.queries.filter((query: any) => query.limit === 50).at(-1).libraryId, 'library-two')
    assert.equal(calls.familyScopes.at(-1), 'library-two')
    assert.equal(calls.mediaScopes.at(-1).libraryId, 'library-two')
    await page.getByRole('button', { name: '查看照片 other-library.jpg', exact: true }).click()
    await page.locator('.detail-media-stage img').waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.at(-1).libraryId), 'library-two')
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-one' })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.media-dialog').count(), 0)
  } finally { await page.close() }
})

test('切库前迟到的查询不能覆盖新库照片', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.delays['library-one'] = 850
      const other = structuredClone(fixtures.assets[0]); other.id = 'other-asset'; other.filename = 'new-library.jpg'; other.locations[0].libraryId = 'library-two'
      fixtures.assets.push(other)
      ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新库', path: 'C:/New', enabled: true })
    })
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).kind === 'photo')
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    await page.getByRole('button', { name: '查看照片 new-library.jpg', exact: true }).waitFor()
    await page.waitForTimeout(1000)
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 0)
  } finally { await page.close() }
})

test('日期默认倒序，可切正序且同日媒体保持稳定顺序', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 3, dates: ['2024-03-10', '2024-03-10', '2024-03-11'] })
  try {
    const sorting = selectControl(page, '日期排序')
    const names = () => page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    await page.locator('.media-card').first().waitFor()
    assert.equal(await selectValue(sorting), 'desc')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).order), 'desc')
    assert.deepEqual(await names(), ['查看照片 photo-3.jpg', '查看照片 photo-1.jpg', '查看照片 photo-2.jpg'])
    await chooseSelect(page, sorting, 'asc')
    await page.waitForFunction(() => document.querySelector('.media-cover')?.getAttribute('aria-label') === '查看照片 photo-1.jpg')
    assert.deepEqual(await names(), ['查看照片 photo-1.jpg', '查看照片 photo-2.jpg', '查看照片 photo-3.jpg'])
    await chooseSelect(page, sorting, 'desc')
    await page.waitForFunction(() => document.querySelector('.media-cover')?.getAttribute('aria-label') === '查看照片 photo-3.jpg')
    assert.deepEqual(await names(), ['查看照片 photo-3.jpg', '查看照片 photo-1.jpg', '查看照片 photo-2.jpg'])
  } finally { await page.close() }
})

test('滚动连续追加下一批，保留前批照片与跨批选择，不显示分页跳转', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 75 })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0)
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 75 项'))
    await scrollGallery(page, 'bottom')
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-75.jpg', exact: true }).count(), 1)
    await scrollGallery(page, 'top')
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    await scrollGallery(page, 'bottom')
    await clickMediaCardControl(page, '选择 photo-75.jpg')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 2 项/)
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries)
    assert.ok(queries.some((query: any) => query.page === 2 && query.limit === 50 && query.libraryId === 'library-one'))
    const displayed = await page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    assert.equal(new Set(displayed).size, displayed.length, '虚拟视口内的追加媒体不能重复')
    assert.ok(displayed.length < 50, '追加索引不同时创建所有媒体卡片')
    assert.equal(await page.evaluate(() => new Set((window as any).__fixtures.calls.completedQueryItems.filter((result: any) => result.query.limit === 50).flatMap((result: any) => result.ids)).size), 75, '两页索引覆盖全部媒体且没有漏项')
  } finally { await page.close() }
})

test('追加请求迟到时，切类型或照片库均丢弃旧批次，不混入新结果', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 81 })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      Object.assign(fixtures.assets[80], { kind: 'video', filename: 'only-video.mp4', duration: 20 })
      fixtures.queryDelays['library-one:all:2'] = 850
      fixtures.queryDelays['library-one:photo:2'] = 850
      const other = structuredClone(fixtures.assets[0]); other.id = 'new-library-asset'; other.filename = 'new-library-only.jpg'; other.locations[0].libraryId = 'library-two'
      fixtures.assets.push(other)
      ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新库', path: 'C:/New', enabled: true })
    })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.page === 2 && !query.kind))
    await page.locator('.media-kind-filter').getByRole('button', { name: '视频', exact: true }).click()
    await page.getByRole('button', { name: '查看视频 only-video.mp4', exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.page === 2 && !query.kind))
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-51.jpg', exact: true }).count(), 0)
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.page === 2 && query.kind === 'photo'))
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    await page.getByRole('button', { name: '查看照片 new-library-only.jpg', exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.page === 2 && query.kind === 'photo'))
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-51.jpg', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).libraryId), 'library-two')
  } finally { await page.close() }
})

test('切换宝宝立即清除旧照片与选择，迟到的上一宝宝追加结果不混入新相册', options, async () => {
  const page = await openPage({ count: 81 })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.babyIds = ['baby-one']
      Object.assign(fixtures.assets[80], { babyIds: ['baby-two'], filename: 'new-baby-only.jpg' })
      fixtures.queryDelays['library-one:all:baby-one:2'] = 1200
      fixtures.queryDelays['library-one:all:baby-two:1'] = 650
    })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.babyId === 'baby-one' && query.page === 2))
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await page.waitForFunction(() => {
      const calls = (window as any).__fixtures.calls
      return calls.queries.some((query: any) => query.babyId === 'baby-two' && query.page === 1) && !calls.completedQueries.some((query: any) => query.babyId === 'baby-two')
    })
    assert.equal(await page.locator('.media-card').count(), 0, '新宝宝首批仍在加载时，旧宝宝照片立即退出视图')
    assert.equal(await page.locator('.selection-toolbar').count(), 0, '其他宝宝的批量选择立即清除')
    await page.getByRole('button', { name: '查看照片 new-baby-only.jpg', exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.babyId === 'baby-one' && query.page === 2))
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-51.jpg', exact: true }).count(), 0)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(query.babyId, 'baby-two'); assert.equal(query.page, 1)
    assert.equal(query.from, undefined); assert.equal(query.to, undefined, '保持全部月份，避免月份变化掩盖切换宝宝时的重置问题')
  } finally { await page.close() }
})

test('完整窗口中的预览避开原生标题区，信息和返回相册可按真实坐标点击且保留图库', options, async () => {
  const page = await openPage({ shell: true, module: 'library', page: 'all' })
  try {
    for (const viewport of [{ width: 820, height: 600 }, { width: 1180, height: 800 }]) {
      await page.setViewportSize(viewport)
      const mediaCount = await page.locator('.media-card').count()
      await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
      await waitForPreviewImage(page)
      // 预览打开后通过背景选择事件构造已选状态，避免选中模式把封面点击变为取消选择。
      await page.evaluate(() => { (document.querySelector('.media-select[aria-label="选择 photo-1.jpg"]') as HTMLButtonElement).click() })
      const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
      const information = dialog.getByRole('button', { name: '照片信息', exact: true })
      const close = dialog.getByRole('button', { name: '关闭预览', exact: true })
      assert.equal((await information.innerText()).trim(), '照片信息', '信息入口保留可见文字，不能只靠图标提示')
      assert.match(await close.innerText(), /返回相册/)
      const titlebar = await page.locator('.topbar').boundingBox()
      assert.ok(titlebar)
      const titlebarBottom = titlebar.y + titlebar.height
      const headerControls = await dialog.locator('.preview-heading button').evaluateAll(elements => elements.map(element => {
        const rect = element.getBoundingClientRect()
        return { label: element.getAttribute('aria-label') ?? element.textContent, top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left }
      }))
      for (const control of headerControls) {
        assert.ok(control.top >= titlebarBottom && control.bottom <= viewport.height && control.left >= 0 && control.right <= viewport.width, `${viewport.width}×${viewport.height} 的预览操作 ${control.label} 避开原生标题区且完整可见`)
      }
      const infoBounds = await information.boundingBox()
      assert.ok(infoBounds)
      await page.mouse.click(infoBounds.x + infoBounds.width / 2, infoBounds.y + infoBounds.height / 2)
      await dialog.locator('.detail-metadata').waitFor()
      assert.match(await dialog.locator('.detail-metadata').innerText(), /文件信息.*拍摄与归档日期.*原文件保存位置/s)
      const closeBounds = await close.boundingBox()
      assert.ok(closeBounds && closeBounds.y >= titlebarBottom)
      await page.mouse.click(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2)
      await dialog.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.app-shell').count(), 1, '返回相册只关闭预览，保留整个应用界面')
      assert.match(await page.locator('.library-toggle').innerText(), /合成归档/)
      assert.equal(await page.locator('.media-card').count(), mediaCount)
      assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true', '关闭预览保留已有照片选择')
      await clickMediaCardControl(page, '选择 photo-1.jpg')
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('放大预览默认以照片为主，按需打开信息、确认日期与定位文件，不改写原图', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', dateConfirmed: false })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await waitForPreviewImage(page)
    assert.equal(await dialog.locator('.detail-metadata').count(), 0, '普通预览不预先渲染整块媒体说明')
    assert.equal(await dialog.locator('.face-layer,.face-selector').count(), 0)
    const information = dialog.getByRole('button', { name: '照片信息', exact: true })
    assert.equal(await information.getAttribute('aria-expanded'), 'false')
    for (const name of ['上一项', '下一项', '缩小', '放大', '适应窗口', '实际大小', '向右旋转', '全屏预览', '关闭预览']) assert.equal(await dialog.getByRole('button', { name, exact: true }).count(), 1)
    await information.click()
    assert.equal(await information.getAttribute('aria-expanded'), 'true')
    assert.match(await dialog.locator('.detail-metadata').innerText(), /文件创建日期/)
    await fillDate(dialog.getByLabel('确认或修正实际拍摄日期', { exact: true }), '2024-03-12')
    await dialog.getByRole('button', { name: '保存确认日期', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.assets[0].dateSource === 'manual')
    assert.match(await dialog.locator('.detail-metadata').innerText(), /2024-03-12.*手动确认日期/)
    await dialog.getByRole('button', { name: '打开原文件位置', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.reveals.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.reveals), [{ id: await page.evaluate(() => (window as any).__fixtures.assets[0].id), libraryId: 'library-one' }])
    await dialog.getByRole('button', { name: '关闭照片信息', exact: true }).click()
    assert.equal(await dialog.locator('.detail-metadata').count(), 0)
    assert.equal(await dialog.locator('.detail-media-stage img').count(), 1)
    assert.deepEqual(await page.evaluate(() => ({ size: (window as any).__fixtures.assets[0].size, hash: (window as any).__fixtures.assets[0].hash, exports: (window as any).__fixtures.calls.exports, scans: (window as any).__fixtures.calls.scans ?? [] })), { size: 1024, hash: '1'.padStart(64, '0'), exports: [], scans: [] })
  } finally { await page.close() }
})

test('日期与收藏保存后原图继续可见且缩放可用，收藏失败直接在预览内提示并保留状态', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', dateConfirmed: false })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await waitForPreviewImage(page)
    const originalSource = await dialog.locator('.detail-media-stage img').getAttribute('src')
    await dialog.getByRole('button', { name: '照片信息', exact: true }).click()
    await fillDate(dialog.getByLabel('确认或修正实际拍摄日期', { exact: true }), '2024-03-12')
    await dialog.getByRole('button', { name: '保存确认日期', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.detail-metadata')?.textContent?.includes('2024-03-12 · 手动确认日期'))
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true, '保存日期重新读取同一项记录时不能隐藏已解码的原图')
    assert.equal(await dialog.getByRole('button', { name: '放大', exact: true }).isDisabled(), false)
    await dialog.getByRole('button', { name: '关闭照片信息', exact: true }).click()
    await dialog.getByRole('button', { name: '取消收藏', exact: true }).click()
    await dialog.getByRole('button', { name: '收藏照片', exact: true }).waitFor()
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true, '收藏更新不能使当前预览停留在加载状态')
    assert.equal(await dialog.getByRole('button', { name: '实际大小', exact: true }).isDisabled(), false)
    await dialog.getByRole('button', { name: '放大', exact: true }).click()
    assert.ok(Number.parseInt(await dialog.locator('.preview-zoom-value').innerText(), 10) > 100)
    await page.evaluate(() => { (window as any).__fixtures.fail.push('favorite') })
    await dialog.getByRole('button', { name: '收藏照片', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '模拟favorite失败' }).waitFor({ state: 'visible' })
    assert.equal(await dialog.getByRole('button', { name: '收藏照片', exact: true }).count(), 1, '失败不伪装收藏成功')
    assert.equal(await dialog.locator('.detail-media-stage img').getAttribute('src'), originalSource)
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true)
    assert.equal(await dialog.getByRole('button', { name: '放大', exact: true }).isDisabled(), false)
    assert.deepEqual(await page.evaluate(() => ({ scans: (window as any).__fixtures.calls.scans ?? [], exports: (window as any).__fixtures.calls.exports })), { scans: [], exports: [] })
  } finally { await page.close() }
})

test('自动刷新加载期间分页末项不能前进，刷新完成后恢复下一项并保持原图可用', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 51, jobs: [{ id: 'preview-refresh', libraryId: 'library-one', kind: 'faces', state: 'running', processed: 0, total: 1, label: '合成分析任务', warnings: [], error: '' }] })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await renderLastIndexedRow(page)
    await page.evaluate(() => { (document.querySelector('.media-cover[aria-label="查看照片 photo-50.jpg"]') as HTMLButtonElement).click() })
    await waitForPreviewImage(page)
    const dialog = page.getByRole('dialog', { name: 'photo-50.jpg', exact: true }), next = dialog.getByRole('button', { name: '下一项', exact: true })
    assert.equal(await next.isDisabled(), false)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.queryDelays['library-one:all:1'] = 900
      Object.assign(fixtures.family.jobs[0], { state: 'done', processed: 1 })
    })
    await page.locator('.loading-status').filter({ hasText: '正在读取照片' }).waitFor()
    assert.equal(await next.isDisabled(), true, '末项等待整页刷新完成后才允许追加，不让导航使用旧查询批次')
    await page.keyboard.press('ArrowRight')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 0)
    await page.locator('.loading-status').waitFor({ state: 'detached' })
    assert.equal(await next.isDisabled(), false)
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true)
    assert.equal(await dialog.getByRole('button', { name: '放大', exact: true }).isDisabled(), false)
    await next.click()
    await page.getByRole('dialog', { name: 'photo-51.jpg', exact: true }).waitFor()
    await waitForPreviewImage(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('真实浏览器全屏通过预览按钮进入和退出，画布保持正常尺寸及可见原图', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await dialog.getByRole('button', { name: '全屏预览', exact: true }).click()
    await page.waitForFunction(() => document.fullscreenElement?.matches('.media-dialog') === true)
    const fullscreen = await page.evaluate(() => {
      const viewer = document.querySelector('.media-dialog')!.getBoundingClientRect(), canvas = document.querySelector('.preview-viewport')!.getBoundingClientRect()
      return { width: viewer.width, height: viewer.height, innerWidth, innerHeight, canvasWidth: canvas.width, canvasHeight: canvas.height }
    })
    assert.ok(Math.abs(fullscreen.width - fullscreen.innerWidth) < 2 && Math.abs(fullscreen.height - fullscreen.innerHeight) < 2, '全屏容器使用真实视口大小')
    assert.ok(fullscreen.canvasWidth > 300 && fullscreen.canvasHeight > 300, '全屏的图片区保留可用尺寸')
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true)
    await dialog.getByRole('button', { name: '退出全屏', exact: true }).click()
    await page.waitForFunction(() => document.fullscreenElement === null)
    await dialog.getByRole('button', { name: '全屏预览', exact: true }).waitFor()
    assert.equal(await dialog.locator('.detail-media-stage img').isVisible(), true)
    assert.equal(await dialog.getByRole('button', { name: '放大', exact: true }).isDisabled(), false)
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.fullscreenElement), null)
  } finally { await page.close() }
})

test('预览前后切换遵循当前查询，末项继续加载下一批，关闭保留图库滚动、选择与月份折叠', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 51, shell: true, dates: ['2024-04-01'] })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.locator('.month-group-toggle').filter({ hasText: '2024年4月' }).click()
    await renderLastIndexedRow(page)
    await page.evaluate(() => {
      ;(document.querySelector('.media-cover[aria-label="查看照片 photo-50.jpg"]') as HTMLButtonElement).click()
    })
    await waitForPreviewImage(page)
    // 通过真实选择事件构造已选状态，预览交互不得清空已有批量选择。
    await page.evaluate(() => { (document.querySelector('.media-select[aria-label="选择 photo-49.jpg"]') as HTMLButtonElement).click() })
    const scrollTop = await page.locator('.page-content').evaluate(element => element.scrollTop)
    const last = page.getByRole('dialog', { name: 'photo-50.jpg', exact: true })
    await last.getByRole('button', { name: '下一项', exact: true }).click()
    const next = page.getByRole('dialog', { name: 'photo-51.jpg', exact: true })
    await next.waitFor(); await waitForPreviewImage(page)
    assert.equal(await next.getByRole('button', { name: '下一项', exact: true }).isDisabled(), true)
    await page.keyboard.press('ArrowLeft')
    await last.waitFor(); await waitForPreviewImage(page)
    await page.keyboard.press('ArrowRight')
    await next.waitFor(); await waitForPreviewImage(page)
    await next.getByRole('button', { name: '关闭预览', exact: true }).click()
    await next.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.month-group-toggle').filter({ hasText: '2024年4月' }).getAttribute('aria-expanded'), 'false')
    assert.equal(await page.getByRole('button', { name: '选择 photo-49.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.locator('.page-content').evaluate(element => element.scrollTop), scrollTop)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 1, '边界加载完成后，前后切换复用已加载项目')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('预览翻页加载失败保留当前照片，手动重试后推进，不重复扫描或自动重跑', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 51 })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await renderLastIndexedRow(page)
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.queryFailures['library-one:all:2'] = 1; (document.querySelector('.media-cover[aria-label="查看照片 photo-50.jpg"]') as HTMLButtonElement).click() })
    await waitForPreviewImage(page)
    await page.getByRole('dialog', { name: 'photo-50.jpg', exact: true }).getByRole('button', { name: '下一项', exact: true }).click()
    const retry = page.getByRole('dialog', { name: 'photo-50.jpg', exact: true }).getByRole('button', { name: '重试切换', exact: true })
    await retry.waitFor()
    assert.equal(await page.getByRole('dialog', { name: 'photo-51.jpg', exact: true }).count(), 0)
    assert.equal(await page.locator('.detail-media-stage img').getAttribute('alt'), 'photo-50.jpg')
    await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 1, '失败翻页只能由用户明确重试')
    await retry.click()
    await page.getByRole('dialog', { name: 'photo-51.jpg', exact: true }).waitFor()
    await waitForPreviewImage(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 2)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('关闭、切库或改筛选后，迟到的预览翻页不重新打开旧照片', options, async () => {
  for (const action of ['close', 'library', 'filter']) {
    const page = await openPage({ module: 'library', page: 'all', count: 51 })
    try {
      await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
      await renderLastIndexedRow(page)
      await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        fixtures.queryDelays['library-one:all:2'] = 850
        ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '合成空库', path: 'C:/SyntheticEmpty', enabled: true })
        ;(document.querySelector('.media-cover[aria-label="查看照片 photo-50.jpg"]') as HTMLButtonElement).click()
      })
      await waitForPreviewImage(page)
      await page.getByRole('dialog', { name: 'photo-50.jpg', exact: true }).getByRole('button', { name: '下一项', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.page === 2))
      if (action === 'close') await page.getByRole('button', { name: '关闭预览', exact: true }).click()
      else if (action === 'library') await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
      else await page.evaluate(() => { (document.querySelector('.media-kind-filter button:last-child') as HTMLButtonElement).click() })
      await page.locator('.media-dialog').waitFor({ state: 'detached' })
      await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.libraryId === 'library-one' && query.page === 2))
      await page.waitForTimeout(50)
      assert.equal(await page.locator('.media-dialog').count(), 0, `${action} 后旧翻页不能重新打开预览`)
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => !request.thumbnail && request.id === (window as any).__fixtures.assets[50].id).length), 0, '被取消的导航不读取下一张原图')
    } finally { await page.close() }
  }
})

test('切换中的旧原图在关闭后迟到不替换新照片，新预览不继承详细信息与人脸选择', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 3 })
  try {
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.delays[fixtures.assets[1].id] = 850 })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    await page.getByRole('button', { name: '照片信息', exact: true }).click()
    await page.getByRole('button', { name: '下一项', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.mediaScopes.some((request: any) => !request.thumbnail && request.id === (window as any).__fixtures.assets[1].id))
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).click()
    await page.getByRole('dialog', { name: 'photo-3.jpg', exact: true }).waitFor()
    await waitForPreviewImage(page)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedMediaScopes.some((request: any) => !request.thumbnail && request.id === (window as any).__fixtures.assets[1].id))
    assert.equal(await page.locator('.detail-media-stage img').getAttribute('src'), await page.evaluate(() => (window as any).__fixtures.rawUrls[(window as any).__fixtures.assets[2].id]))
    assert.equal(await page.locator('.detail-metadata').count(), 0, '换图关闭上一张的详细信息')
    assert.equal(await page.locator('.face-layer,.face-selector').count(), 0)
  } finally { await page.close() }
})

test('照片支持真实尺寸、滚轮缩放、拖动和旋转，适应窗口恢复完整画面且仅改变显示', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.previewUrls[fixtures.assets[0].id] = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1920" height="1440"><rect width="1920" height="1440" fill="#dde8e0"/></svg>')}`
    })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const stage = page.locator('.detail-media-stage'), viewport = page.locator('.preview-viewport'), zoom = page.locator('.preview-zoom-value')
    const fitZoom = Number.parseInt(await zoom.innerText(), 10)
    assert.ok(fitZoom > 0 && fitZoom < 100)
    await page.getByRole('button', { name: '实际大小', exact: true }).click()
    assert.match(await zoom.innerText(), /100%/)
    const full = await stage.boundingBox()
    assert.ok(full && Math.abs(full.width - 1920) < 2 && Math.abs(full.height - 1440) < 2, '100% 以解码后的原图像素为准，不使用索引缩略图尺寸')
    const canvas = await viewport.boundingBox()
    assert.ok(canvas)
    await page.mouse.move(canvas!.x + canvas!.width / 2, canvas!.y + canvas!.height / 2)
    await page.mouse.down(); await page.mouse.move(canvas!.x + canvas!.width / 2 + 80, canvas!.y + canvas!.height / 2 + 40, { steps: 4 }); await page.mouse.up()
    const dragged = await stage.boundingBox()
    assert.ok(dragged && Math.abs(dragged.x - full!.x) > 20, '放大后可拖动查看照片边缘')
    await page.mouse.wheel(0, -300)
    await page.waitForFunction(() => Number.parseInt(document.querySelector('.preview-zoom-value')?.textContent ?? '0', 10) > 100)
    await page.getByRole('button', { name: '适应窗口', exact: true }).click()
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    const rotated = await stage.boundingBox()
    assert.ok(rotated && rotated.height > rotated.width, '显示旋转后画面方向随之改变')
    await page.keyboard.press('1')
    assert.match(await zoom.innerText(), /100%/)
    await page.keyboard.press('0')
    assert.ok(Number.parseInt(await zoom.innerText(), 10) < 100)
    await viewport.dblclick()
    assert.match(await zoom.innerText(), /100%/)
    await viewport.dblclick()
    assert.ok(Number.parseInt(await zoom.innerText(), 10) < 100)
    assert.deepEqual(await page.evaluate(() => ({ exports: (window as any).__fixtures.calls.exports, scans: (window as any).__fixtures.calls.scans ?? [], size: (window as any).__fixtures.assets[0].size })), { exports: [], scans: [], size: 1024 })
  } finally { await page.close() }
})

test('原图读取与解码错误可原位重试，照片和视频可直接切换且视频保留播放控件', options, async () => {
  assert.ok(ffmpegPath && existsSync(ffmpegPath), '合成视频使用项目已有的本地媒体工具')
  // 明确请求多张变化画面，避免无自动刷新频率的离屏画布生成空视频。
  const videoBuffer = await new Promise<Buffer>((resolve, reject) => execFile(ffmpegPath!, [
    '-v', 'error', '-nostdin', '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=10:duration=1',
    '-an', '-pix_fmt', 'yuv420p', '-c:v', 'libvpx', '-threads', '1', '-f', 'webm', 'pipe:1',
  ], { encoding: 'buffer', windowsHide: true, timeout: 10000, maxBuffer: 1024 ** 2 }, (error, stdout, stderr) => {
    if (error) reject(new Error(`合成测试视频生成失败：${stderr.toString()}`, { cause: error }))
    else resolve(stdout)
  }))
  assert.ok(videoBuffer.length > 0, '合成视频必须包含非空媒体内容')
  assert.equal(videoBuffer.subarray(0, 4).toString('hex'), '1a45dfa3', '合成视频具有有效的 WebM 容器头')
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.evaluate(videoUrl => {
      const fixtures = (window as any).__fixtures
      fixtures.previewFailures[fixtures.assets[0].id] = 1
      Object.assign(fixtures.assets[1], { kind: 'video', filename: 'synthetic-video.webm', duration: 1 })
      fixtures.previewUrls[fixtures.assets[1].id] = videoUrl
    }, `data:video/webm;base64,${videoBuffer.toString('base64')}`)
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.locator('.media-kind-filter').getByRole('button', { name: '全部', exact: true }).click()
    await page.getByRole('button', { name: '查看视频 synthetic-video.webm', exact: true }).waitFor()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const retry = page.getByRole('button', { name: '重试预览', exact: true })
    await retry.waitFor()
    assert.equal(await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).count(), 1)
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.previewUrls[fixtures.assets[0].id] = 'data:image/png;base64,invalid-image' })
    await retry.click()
    await retry.waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => !request.thumbnail).length), 2)
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; delete fixtures.previewUrls[fixtures.assets[0].id] })
    await retry.click()
    await waitForPreviewImage(page)
    assert.equal(await retry.count(), 0)
    await page.getByRole('button', { name: '下一项', exact: true }).click()
    const videoDialog = page.getByRole('dialog', { name: 'synthetic-video.webm', exact: true })
    await videoDialog.locator('video[controls]').waitFor()
    await page.waitForFunction(() => Boolean((document.querySelector('.media-dialog video') as HTMLVideoElement | null)?.readyState))
    assert.deepEqual(await videoDialog.locator('video').evaluate((video: HTMLVideoElement) => ({ width: video.videoWidth, height: video.videoHeight, error: video.error?.code ?? null })), { width: 320, height: 240, error: null })
    assert.equal(await videoDialog.getByRole('button', { name: '向右旋转', exact: true }).count(), 0)
    assert.equal(await videoDialog.getByRole('button', { name: '放大', exact: true }).count(), 0)
    await page.keyboard.press('ArrowLeft')
    await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor()
    await waitForPreviewImage(page)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('预览键盘焦点停留在弹窗，编辑输入不触发换图，Escape 依次退出全屏、收起信息和关闭', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    for (let index = 0; index < 18; index++) {
      await page.keyboard.press('Tab')
      assert.equal(await page.evaluate(() => Boolean(document.querySelector('.media-dialog')?.contains(document.activeElement))), true, 'Tab 不将焦点移到遮罩后的图库')
    }
    await dialog.getByRole('button', { name: '照片信息', exact: true }).click()
    const date = dialog.getByLabel('确认或修正实际拍摄日期', { exact: true })
    await date.focus(); await page.keyboard.press('ArrowRight'); await page.keyboard.press('1')
    assert.equal(await dialog.count(), 1, '编辑日期时箭头和数字保留输入原有行为')
    await page.evaluate(() => {
      let fullscreen: Element | null = null
      Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => fullscreen })
      const viewer = document.querySelector('.media-dialog') as HTMLElement
      viewer.requestFullscreen = async () => { fullscreen = viewer; document.dispatchEvent(new Event('fullscreenchange')) }
      document.exitFullscreen = async () => { fullscreen = null; document.dispatchEvent(new Event('fullscreenchange')) }
    })
    await dialog.getByRole('button', { name: '全屏预览', exact: true }).click()
    await dialog.getByRole('button', { name: '退出全屏', exact: true }).waitFor()
    await dialog.getByRole('button', { name: '照片信息', exact: true }).click()
    await page.keyboard.press('Escape')
    await dialog.getByRole('button', { name: '全屏预览', exact: true }).waitFor()
    assert.equal(await dialog.locator('.detail-metadata').count(), 1)
    await page.keyboard.press('Escape')
    assert.equal(await dialog.locator('.detail-metadata').count(), 0)
    assert.equal(await dialog.count(), 1)
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '查看照片 photo-1.jpg', '关闭后焦点回到原照片入口')
  } finally { await page.close() }
})

test('普通预览隐藏人脸标记，明确进入选脸后头像与图上人脸框一致并保存正确参考', options, async () => {
  const page = await openPage({ module: 'baby', page: 'references' })
  try {
    await page.evaluate(() => {
      const asset = (window as any).__fixtures.assets[0]
      asset.faces.push({ id: 'face-second', x: 0.6, y: 0.15, width: 0.2, height: 0.3, score: 0.9, personId: 'person-two', personName: '妈妈' })
      asset.personIds.push('person-two')
    })
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1).kind === 'photo')
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    assert.equal(await page.locator('.media-dialog .face-selector,.media-dialog .face-box').count(), 0)
    await page.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    const selector = page.locator('.media-dialog .face-selector')
    await selector.locator('button').nth(1).waitFor()
    assert.equal(await selector.locator('button').count(), 2)
    assert.equal(await page.getByRole('button', { name: '向右旋转', exact: true }).isDisabled(), true, '选脸时保持原图方向，避免人脸框与图像错位')
    await selector.locator('button').nth(1).click()
    assert.equal(await selector.locator('button').nth(1).getAttribute('aria-pressed'), 'true')
    assert.equal(await selector.locator('button').first().getAttribute('aria-pressed'), 'false')
    assert.match(await page.locator('.face-layer .face-box.chosen').getAttribute('aria-label') ?? '', /选择人脸 2 妈妈/)
    await chooseSelect(page, selectControl(page, '此人脸对应的宝宝'), 'baby-one')
    await page.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.references.length === 1)
    const reference = await page.evaluate(() => (window as any).__fixtures.calls.references[0])
    assert.equal(reference.faceId, 'face-second')
    assert.equal(reference.babyId, 'baby-one')
    assert.equal(reference.assetId, await page.evaluate(() => (window as any).__fixtures.assets[0].id))
    await page.getByRole('button', { name: '选择宝宝人脸', exact: true }).waitFor()
    assert.equal(await page.locator('.media-dialog .face-selector,.media-dialog .face-box').count(), 0)
    assert.equal(await page.getByRole('button', { name: '向右旋转', exact: true }).isDisabled(), false)
    await page.getByRole('dialog').getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    assert.equal(await page.locator('.media-dialog .face-selector,.media-dialog .face-box').count(), 0, '下一张普通照片不继承选脸模式')
  } finally { await page.close() }
})

test('三张参考照片按选择顺序逐张明确选脸，保存到正确宝宝并保留已有参考', options, async () => {
  const page = await openPage({ page: 'references', count: 3 })
  try {
    await page.evaluate(() => {
      for (const [index, asset] of (window as any).__fixtures.assets.entries()) asset.faces.push({ id: `reference-face-${index + 1}`, x: 0.6, y: 0.2, width: 0.2, height: 0.3, score: 0.95, personId: 'person-two', personName: '宝宝候选' })
    })
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1).kind === 'photo')
    const order = [3, 1, 2]
    await startReferencePicker(page, order.map(number => `photo-${number}.jpg`))
    for (const [index, number] of order.entries()) {
      const dialog = page.getByRole('dialog', { name: `photo-${number}.jpg`, exact: true })
      await dialog.waitFor()
      assert.match(await page.locator('.reference-picker-progress').innerText(), new RegExp(`${index + 1}\\s*/\\s*3`))
      assert.equal(await dialog.getByRole('button', { name: '照片信息', exact: true }).count(), 0, '参考队列只显示逐张选脸所需控件')
      assert.equal(await dialog.getByRole('button', { name: '上一项', exact: true }).count(), 0)
      assert.equal(await dialog.getByRole('button', { name: '下一项', exact: true }).count(), 0)
      assert.equal(await dialog.locator('.face-selector button[aria-pressed="true"]').count(), 0, '每张照片都需要用户明确选择人脸')
      assert.equal(await page.evaluate(() => (window as any).__fixtures.references.length), index)
      await dialog.locator('.face-selector button').nth(1).click()
      await dialog.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
      await page.waitForFunction(expected => (window as any).__fixtures.references.length === expected, index + 1)
    }
    await page.locator('.media-dialog').waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'references')
    assert.equal(await page.locator('.reference-picker-progress').count(), 0)
    await page.waitForFunction(() => document.querySelectorAll('.reference-item').length === 4)
    const saved = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { references: fixtures.references, ids: fixtures.assets.map((asset: any) => asset.id), baby: fixtures.family.babies[0] }
    })
    assert.deepEqual(saved.references, order.map(number => ({ babyId: 'baby-one', assetId: saved.ids[number - 1], faceId: `reference-face-${number}` })))
    assert.ok(saved.baby.referenceFaces.some((reference: any) => reference.assetId === saved.ids[0] && reference.faceId === 'face-one'), '原来的人脸参考继续保留')
  } finally { await page.close() }
})

test('参考选脸保存失败不推进，成功重试后可跳过下一张且不保存其参考', options, async () => {
  const page = await openPage({ page: 'references', count: 2, fail: ['reference'] })
  try {
    await startReferencePicker(page, ['photo-1.jpg', 'photo-2.jpg'])
    const first = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await first.locator('.face-selector button').first().click()
    await first.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await page.getByRole('status').filter({ hasText: '模拟reference失败' }).waitFor()
    await first.getByRole('alert').filter({ hasText: '模拟reference失败' }).waitFor({ state: 'visible' })
    assert.equal(await first.count(), 1)
    assert.match(await page.locator('.reference-picker-progress').innerText(), /1\s*\/\s*2/)
    assert.equal(await first.locator('.face-selector button[aria-pressed="true"]').count(), 1, '失败后保留已明确选中的脸便于重试')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.references.length), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces.length), 1, '失败不能修改已有参考记录')
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await first.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    const second = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await second.waitFor()
    assert.match(await page.locator('.reference-picker-progress').innerText(), /2\s*\/\s*2/)
    assert.equal(await second.locator('.face-selector button[aria-pressed="true"]').count(), 0)
    await second.getByRole('button', { name: '跳过这张照片', exact: true }).click()
    await page.locator('.media-dialog').waitFor({ state: 'detached' })
    const calls = await page.evaluate(() => (window as any).__fixtures.calls)
    assert.equal(calls.referenceAttempts.length, 2, '失败与重试都只保存第一张照片的人脸')
    assert.equal(calls.references.length, 1, '跳过照片不生成参考保存调用')
    assert.equal(calls.references[0].faceId, 'face-one')
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'references')
  } finally { await page.close() }
})

test('保存参考期间关闭队列或卸载页面，迟到成功保留参考且不读取下一张原图', options, async () => {
  for (const unmount of [false, true]) {
    const page = await openPage({ page: 'references', count: 2 })
    try {
      await page.evaluate(() => { (window as any).__fixtures.delays.reference = 1000 })
      await startReferencePicker(page, ['photo-1.jpg', 'photo-2.jpg'])
      const first = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
      await first.locator('.face-selector button').first().click()
      await first.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.referenceAttempts.length === 1)
      if (unmount) await page.evaluate(() => { (window as any).__testApp.unmount() })
      else await first.getByRole('button', { name: '关闭预览', exact: true }).click()
      await page.locator('.media-dialog').waitFor({ state: 'detached' })
      await page.waitForFunction(() => (window as any).__fixtures.calls.references.length === 1)
      if (!unmount) await page.getByRole('status').filter({ hasText: '已确认并设为参考。' }).waitFor()
      assert.equal(await page.locator('.media-dialog').count(), 0, '关闭队列或卸载页面后，保存回执不能重新打开第二张照片')
      assert.equal(await page.locator('.reference-picker-progress').count(), 0)
      const saved = await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        return { references: fixtures.calls.references, ids: fixtures.assets.map((asset: any) => asset.id), baby: fixtures.family.babies[0], scopes: fixtures.calls.mediaScopes }
      })
      assert.deepEqual(saved.references, [{ babyId: 'baby-one', assetId: saved.ids[0], faceId: 'face-one' }])
      assert.equal(saved.baby.referenceFaces.length, 1, '已经发出的保存继续完成，已有同一参考不重复追加')
      assert.equal(saved.scopes.filter((request: any) => request.id === saved.ids[1] && !request.thumbnail).length, 0, '卸载后不能偷偷读取队列中下一张原图')
      assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'references')
    } finally { await page.close() }
  }
})

test('已有二十张参考时拒绝新增，选脸对话框提示上限并完整保留旧参考', options, async () => {
  const page = await openPage({ page: 'references', count: 2 })
  try {
    const original = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, profile = fixtures.family.babies[0]
      for (let index = 1; index < 20; index++) profile.referenceFaces.push({ assetId: fixtures.assets[0].id, faceId: `existing-face-${index}` })
      return structuredClone(profile.referenceFaces)
    })
    await page.waitForFunction(() => document.querySelectorAll('.reference-item').length === 20)
    await startReferencePicker(page, ['photo-2.jpg'])
    const dialog = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await dialog.locator('.face-selector button').first().click()
    await dialog.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '最多保留 20 张参考人脸' }).waitFor({ state: 'visible' })
    assert.match(await dialog.locator('.reference-picker-progress').innerText(), /1\s*\/\s*1/)
    assert.equal(await dialog.locator('.face-selector button[aria-pressed="true"]').count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.referenceAttempts.length), 0, '界面不能调用会挤掉旧参考的新增操作')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces), original)
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.evaluate(() => { Object.assign((window as any).__testProps, { module: 'baby', page: 'timeline' }) })
    await openTools(page, '.advanced-filters')
    await page.getByRole('button', { name: '结束选择', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    assert.equal(await preview.locator('.reference-picker-progress').count(), 0, '普通预览不进入批量队列')
    await preview.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    await preview.locator('.face-selector button').first().click()
    await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
    await preview.getByRole('alert').filter({ hasText: '最多保留 20 张参考人脸' }).waitFor({ state: 'visible' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.referenceAttempts.length), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces), original, '普通预览添加也不能挤掉旧参考')
  } finally { await page.close() }
})

test('宝宝查找统一展示已加入与全部候选，关闭自动匹配时强匹配仍待确认且不提前加入', options, async () => {
  for (const autoMatch of [false, true]) {
    const page = await openPage({ page: 'references', count: 3, autoMatch })
    try {
      await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        for (const asset of fixtures.assets) asset.babyIds = []
        fixtures.assets[0].babyIds = ['baby-one']
        fixtures.matchAssets = [fixtures.assets[1].id, fixtures.assets[2].id]
        fixtures.candidateMatchAssets = [fixtures.assets[2].id]
      })
      await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
      await openTools(page, '.baby-tools')
      await page.getByRole('button', { name: '全部匹配结果', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'matches' && document.querySelectorAll('.media-card').length === 3)
      const included = autoMatch ? 2 : 1, candidates = autoMatch ? 1 : 2
      assert.match(await page.locator('.baby-match-context').innerText(), /全部匹配 3 项/)
      assert.match(await page.locator('.baby-match-context').innerText(), new RegExp(`已加入 ${included} 项`))
      assert.match(await page.locator('.baby-match-context').innerText(), new RegExp(`待确认 ${candidates} 项`))
      assert.equal(await page.locator('.media-candidate').filter({ hasText: /^疑似$/ }).count(), candidates)
      for (const filename of ['photo-1.jpg', 'photo-2.jpg', 'photo-3.jpg']) assert.equal(await page.getByRole('button', { name: `查看照片 ${filename}`, exact: true }).count(), 1)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.matches), [{ babyId: 'baby-one', libraryId: 'library-one', scope: 'library' }])
      const result = await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        return { query: fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1), assets: fixtures.assets, memberships: fixtures.calls.memberships }
      })
      assert.deepEqual(result.query, { page: 1, limit: 50, libraryId: 'library-one', order: 'desc', babyId: 'baby-one', includeCandidates: true })
      assert.deepEqual(result.memberships, [], '浏览统一结果不能提前发出人工加入请求')
      assert.deepEqual(result.assets[2].babyIds, [], '弱候选仍未加入成长相册')
      assert.deepEqual(result.assets[2].candidateBabyIds, ['baby-one'])
      if (!autoMatch) { assert.deepEqual(result.assets[1].babyIds, []); assert.deepEqual(result.assets[1].candidateBabyIds, ['baby-one']) }
      await page.locator('.baby-match-context').getByRole('button', { name: `已加入 ${included} 项`, exact: true }).click()
      await page.waitForFunction(count => (window as any).__testProps.page === 'matches' && document.querySelectorAll('.media-card').length === count, included)
      assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 0, '待确认可以在统一结果浏览，但不能冒充已加入成长相册')
    } finally { await page.close() }
  }
})

test('外部库参考的弱候选进入当前库统一结果，查找清除人物、类型、搜索和日期等旧筛选', options, async () => {
  const page = await openPage({ page: 'references', count: 2, autoMatch: true })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.babyIds = []
      fixtures.assets[0].locations[0].libraryId = 'library-two'
      fixtures.matchAssets = fixtures.candidateMatchAssets = [fixtures.assets[1].id]
    })
    await page.locator('.media-kind-filter').getByRole('button', { name: '视频', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).fill('不相关关键词')
    await openTools(page, '.advanced-filters')
    const fields = page.locator('.advanced-filter-fields')
    await chooseSelect(page, selectControl(page, '来源'), 'phone')
    await chooseSelect(page, selectControl(page, '日期来源'), 'unknown')
    await chooseSelect(page, selectControl(page, '人物'), 'person-one')
    await fillDate(page.getByLabel('从', { exact: true }), '2025-01-01')
    await fillDate(page.getByLabel('到', { exact: true }), '2025-01-31')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.limit === 50 && query.kind === 'video' && query.search === '不相关关键词' && query.to === '2025-01-31'))
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
      await openTools(page, '.baby-tools')
      await page.getByRole('button', { name: '全部匹配结果', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'matches')
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 0, '外部库参考可以参与查找，但不能出现在当前库结果中')
    const result = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { query: fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1), references: fixtures.family.babies[0].referenceFaces, asset: fixtures.assets[1] }
    })
    assert.deepEqual(result.query, { libraryId: 'library-one', babyId: 'baby-one', page: 1, limit: 50, order: 'desc', includeCandidates: true }, '统一结果清除会隐藏匹配照片的全部旧筛选')
    assert.deepEqual(result.references, [{ assetId: await page.evaluate(() => (window as any).__fixtures.assets[0].id), faceId: 'face-one' }], '无需重新选择同库参考')
    assert.deepEqual(result.asset.babyIds, [], '弱相似结果不能被自动确认')
    assert.deepEqual(result.asset.candidateBabyIds, ['baby-one'])
    assert.equal(await page.locator('.media-card .media-candidate').innerText(), '疑似')
    assert.match(await page.locator('.baby-match-context').innerText(), /已加入 0 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /待确认 1 项/)
  } finally { await page.close() }
})

test('统一匹配结果中的候选须明确确认，确认加入与不是宝宝只改变对应记录并更新数量', options, async () => {
  const page = await openPage({ page: 'references', count: 3, autoMatch: false })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.babyIds = []
      fixtures.matchAssets = [fixtures.assets[1].id, fixtures.assets[2].id]
    })
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
      await openTools(page, '.baby-tools')
      await page.getByRole('button', { name: '全部匹配结果', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'matches' && document.querySelectorAll('.media-card').length === 2)
    assert.equal(await page.locator('.media-candidate').filter({ hasText: /^疑似$/ }).count(), 2)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
    await clickMediaCardControl(page, '选择 photo-2.jpg')
    assert.equal(await page.locator('.selection-toolbar').getByRole('button', { name: '确认不是宝宝', exact: true }).count(), 1)
    await page.locator('.selection-toolbar').getByRole('button', { name: '确认加入宝宝相册', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.media-candidate')].filter(element => element.textContent === '疑似').length === 1 && !document.querySelector('.selection-toolbar'))
    assert.match(await page.locator('.baby-match-context').innerText(), /全部匹配 2 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /已加入 1 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /待确认 1 项/)
    await clickMediaCardControl(page, '选择 photo-3.jpg')
    await page.locator('.selection-toolbar').getByRole('button', { name: '确认不是宝宝', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 1 && !document.querySelector('.selection-toolbar'))
    const result = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { memberships: fixtures.calls.memberships, assets: fixtures.assets }
    })
    assert.deepEqual(result.memberships, [{ babyId: 'baby-one', ids: [result.assets[1].id], included: true }, { babyId: 'baby-one', ids: [result.assets[2].id], included: false }])
    assert.deepEqual(result.assets[1].babyIds, ['baby-one']); assert.deepEqual(result.assets[1].candidateBabyIds, [])
    assert.deepEqual(result.assets[2].babyIds, []); assert.deepEqual(result.assets[2].candidateBabyIds, [])
    assert.equal(result.assets.length, 3, '确认不是宝宝只修改关联，原媒体记录继续保留')
    assert.match(await page.locator('.baby-match-context').innerText(), /全部匹配 1 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /待确认 0 项/)
    assert.equal(await page.locator('.media-candidate').filter({ hasText: /^疑似$/ }).count(), 0)
  } finally { await page.close() }
})

test('统一宝宝结果超过五十项继续分页，包含候选且不混入其他宝宝或未匹配照片', options, async () => {
  const page = await openPage({ page: 'references', count: 76, autoMatch: true })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.babyIds = []
      fixtures.matchAssets = fixtures.assets.slice(0, 75).map((asset: any) => asset.id)
      fixtures.candidateMatchAssets = fixtures.assets.slice(0, 75).filter((_asset: any, index: number) => index % 2 === 1).map((asset: any) => asset.id)
      fixtures.assets[75].candidateBabyIds = ['baby-two']
      fixtures.family.candidateCount = 900
    })
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
      await openTools(page, '.baby-tools')
      await page.getByRole('button', { name: '全部匹配结果', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'matches' && document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    assert.match(await page.locator('.baby-match-context').innerText(), /全部匹配 75 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /已加入 38 项/)
    assert.match(await page.locator('.baby-match-context').innerText(), /待确认 37 项/)
    await openTools(page, '.baby-tools')
    assert.equal(await page.getByRole('button', { name: '人物待确认 · 37', exact: true }).count(), 1, '菜单仅显示当前宝宝候选，不能使用跨宝宝的全局计数')
    await page.locator('.baby-tools button[aria-expanded]').click()
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 75 项'))
    await scrollGallery(page, 'bottom')
    assert.ok(await page.locator('.media-candidate').filter({ hasText: /^疑似$/ }).count() > 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.filter((asset: any) => asset.candidateBabyIds?.includes('baby-one')).length), 37)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-75.jpg', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-76.jpg', exact: true }).count(), 0)
    await scrollGallery(page, 'top')
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.includeCandidates))
    assert.ok(queries.some((query: any) => query.page === 2 && query.limit === 50 && query.babyId === 'baby-one' && query.libraryId === 'library-one'))
    assert.ok(queries.every((query: any) => !query.candidates), '联合查询使用独立标志，不伪装为仅待确认页')
    const displayed = await page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    assert.equal(new Set(displayed).size, displayed.length)
    assert.ok(displayed.length < 100)
    assert.equal(await page.evaluate(() => new Set((window as any).__fixtures.calls.completedQueryItems.filter((result: any) => result.query.includeCandidates && result.query.limit === 50).flatMap((result: any) => result.ids)).size), 75)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [], '分页浏览不生成相册确认')
  } finally { await page.close() }
})

test('统一宝宝结果追加迟到时切宝宝或切库，旧批次、选择和统计不会覆盖新结果', options, async () => {
  for (const switchLibrary of [false, true]) {
    const page = await openPage({ page: 'references', count: 81, autoMatch: true })
    try {
      await page.evaluate(switchLibrary => {
        const fixtures = (window as any).__fixtures
        for (const asset of fixtures.assets) asset.babyIds = []
        fixtures.matchAssets = fixtures.assets.slice(0, 80).map((asset: any) => asset.id)
        fixtures.candidateMatchAssets = fixtures.matchAssets
        fixtures.queryDelays['library-one:all:baby-one:2'] = 900
        Object.assign(fixtures.assets[80], { filename: 'new-match-only.jpg', candidateBabyIds: [switchLibrary ? 'baby-one' : 'baby-two'] })
        if (switchLibrary) {
          fixtures.assets[80].locations[0].libraryId = 'library-two'
          ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新库', path: 'C:/New', enabled: true })
        }
      }, switchLibrary)
      await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
      await openTools(page, '.baby-tools')
      await page.getByRole('button', { name: '全部匹配结果', exact: true }).click()
      await page.waitForFunction(() => (window as any).__testProps.page === 'matches' && document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
      await clickMediaCardControl(page, '选择 photo-1.jpg')
      await page.locator('.media-load-more').scrollIntoViewIfNeeded()
      await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.includeCandidates && query.page === 2))
      if (switchLibrary) await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
      else await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
      await page.getByRole('button', { name: '查看照片 new-match-only.jpg', exact: true }).waitFor()
      await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.includeCandidates && query.libraryId === 'library-one' && query.babyId === 'baby-one' && query.page === 2))
      assert.equal(await page.locator('.media-card').count(), 1)
      assert.equal(await page.getByRole('button', { name: '查看照片 photo-51.jpg', exact: true }).count(), 0)
      assert.equal(await page.locator('.selection-toolbar').count(), 0)
      assert.match(await page.locator('.baby-match-context').innerText(), /全部匹配 1 项/)
      assert.match(await page.locator('.baby-match-context').innerText(), /已加入 0 项/)
      assert.match(await page.locator('.baby-match-context').innerText(), /待确认 1 项/)
    } finally { await page.close() }
  }
})

test('宝宝查找操作迟到时切换宝宝，保留新宝宝页面且不自动跳到旧宝宝统一结果', options, async () => {
  const page = await openPage({ page: 'references', count: 2, autoMatch: true })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.babyIds = []
      fixtures.matchAssets = [fixtures.assets[1].id]; fixtures.delays.match = 700
    })
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.matches.length === 1)
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedMatches.length === 1 && !(document.querySelector('.recognition-panel .secondary-button') as HTMLButtonElement)?.disabled)
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'references')
    assert.equal(await selectValue(selectControl(page, '当前宝宝')), 'baby-two')
    assert.equal(await page.locator('.baby-match-context').count(), 0)
    assert.equal(await page.locator('.reference-item').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.assets[1].babyIds), ['baby-one'], '已发出的旧宝宝匹配可以完成保存，但迟到回执不能改变当前查看对象')
  } finally { await page.close() }
})

test('查找没有已加入或候选结果时明确展示零匹配覆盖，原参考保持不变', options, async () => {
  const page = await openPage({ page: 'references', count: 2, autoMatch: true })
  try {
    await page.evaluate(() => { for (const asset of (window as any).__fixtures.assets) asset.babyIds = [] })
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
    await openRecognitionDetails(page)
    await page.locator('.baby-match-coverage').filter({ hasText: /已分析 2.*2 项/ }).waitFor({ state: 'visible' })
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 0', exact: true }).count(), 1)
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 0', exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces.length), 1)
    assert.equal(await page.locator('.media-card').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.matches), [{ babyId: 'baby-one', libraryId: 'library-one', scope: 'library' }])
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.babyId === 'baby-one' && query.limit === 1))
    assert.ok(queries.some((query: any) => !query.candidates) && queries.some((query: any) => query.candidates), '以当前库的两种真实归属计数判断空结果')
  } finally { await page.close() }
})

test('人物页以头像分组，点头像使用人脸相似查询，独立入口修改名称', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, other = fixtures.assets[2]
      other.personIds = ['person-two']; Object.assign(other.faces[0], { personId: 'person-two', personName: '妈妈' })
      Object.assign(fixtures.family.people[0], { assetCount: 2, faceCount: 2 })
      fixtures.family.people.push({ id: 'person-two', name: '妈妈', assetCount: 1, faceCount: 1, reference: { assetId: other.id, face: other.faces[0], kind: 'photo' } })
    })
    await page.waitForFunction(() => document.querySelectorAll('.person-card').length === 2)
    assert.equal(await page.locator('.media-card').count(), 0, '全部人物视图以头像为主，不同时摊开全库媒体')
    const familyCard = page.locator('.person-card').filter({ hasText: '家人' })
    await familyCard.locator('.face-avatar img').waitFor({ state: 'attached' })
    await familyCard.locator('.person-open').click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 2)
    assert.equal(await page.getByRole('dialog', { name: '人物名称', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1)), { assetId: await page.evaluate(() => (window as any).__fixtures.assets[0].id), faceId: 'face-one', scope: 'all', page: 1, limit: 50, order: 'desc' })
    await page.locator('.similar-face-context').getByRole('button', { name: '← 返回', exact: true }).click()
    await page.locator('.person-card').filter({ hasText: '家人' }).locator('.person-rename').click()
    const dialog = page.getByRole('dialog', { name: '人物名称', exact: true })
    await dialog.getByLabel('给这个人物一个名字', { exact: true }).fill('家人改名')
    await dialog.getByRole('button', { name: '保存名称', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.namedPeople.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.namedPeople[0]), { id: 'person-one', name: '家人改名' })
  } finally { await page.close() }
})


test('旧分组整理：比较等待中可取消或 Escape，迟到回复不重开弹窗或自动应用', options, async () => {
  for (const action of ['cancel', 'escape'] as const) {
    const page = await openPage({ module: 'library', page: 'people' })
    try {
      await installGroupingPreview(page)
      await page.evaluate(() => { (window as any).__fixtures.groupingWait = true })
      const dialog = await openPersonGroupingDialog(page)
      await dialog.getByRole('status').filter({ hasText: '正在比较已有特征…' }).waitFor()
      assert.equal(await dialog.getByRole('button', { name: '确认应用 0 组合并', exact: true }).isDisabled(), true)
      assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isEnabled(), true)
      if (action === 'escape') await page.keyboard.press('Escape')
      else await dialog.getByRole('button', { name: '取消', exact: true }).click()
      await dialog.waitFor({ state: 'detached' })
      await page.evaluate(() => { (window as any).__fixtures.pendingGrouping.shift().resolve() })
      await page.waitForFunction(() => (window as any).__fixtures.calls.completedGroupingPrepares.length === 1)
      assert.equal(await dialog.count(), 0)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingPrepares), [{ libraryId: 'library-one' }])
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [], '比较已有特征不能调用人脸检测')
    } finally { await page.close() }
  }
})

test('旧分组整理：切库关闭等待方案，旧库迟到回复不覆盖新库人物', options, async () => {
  const page = await openPage({ module: 'library', page: 'people' })
  try {
    await installGroupingPreview(page)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.groupingWait = true
      const family = structuredClone(fixtures.family)
      family.people = [{ id: 'new-library-person', name: '新库人物', faceCount: 1, assetCount: 1 }]
      fixtures.familyByLibrary['library-two'] = family
    })
    const dialog = await openPersonGroupingDialog(page)
    await dialog.locator('.grouping-loading').waitFor()
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    await dialog.waitFor({ state: 'detached' })
    await page.locator('.person-card[data-person-id="new-library-person"]').waitFor()
    await page.evaluate(() => { (window as any).__fixtures.pendingGrouping.shift().resolve() })
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedGroupingPrepares.length === 1)
    assert.equal(await dialog.count(), 0)
    assert.equal(await page.locator('.person-card').count(), 1)
    assert.match(await page.locator('.person-card').innerText(), /新库人物/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
  } finally { await page.close() }
})

test('旧分组整理：方案分页只供审核，内部空白保留方案，取消和真实遮罩不应用', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 14 })
  try {
    await installGroupingPreview(page, 13)
    let dialog = await openPersonGroupingDialog(page)
    await dialog.locator('.grouping-summary').waitFor()
    assert.deepEqual(await dialog.locator('.grouping-summary strong').allTextContents(), ['14', '14'])
    assert.equal(await dialog.getByRole('checkbox').count(), 12)
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0, '审核默认不接受任何合并候选')
    assert.equal(await dialog.getByRole('button', { name: '确认应用 0 组合并', exact: true }).isDisabled(), true)
    assert.equal(await dialog.locator('.grouping-candidate').count(), 12)
    assert.equal(await dialog.locator('.face-avatar').count(), 24)
    assert.match(await dialog.locator('.grouping-exclusions').innerText(), /3 组证据不足/)
    assert.match(await dialog.locator('.grouping-exclusions').innerText(), /2 组存在同图或同帧冲突/)
    assert.match(await dialog.locator('.grouping-preservation').innerText(), /原记录、宝宝参考和相册归属保留/)
    assert.equal(await dialog.locator('.grouping-candidate-list').evaluate(element => element.scrollHeight > element.clientHeight), true)
    await dialog.locator('.grouping-body').click({ position: { x: 2, y: 2 } })
    assert.equal(await dialog.isVisible(), true)
    const bounds = await dialog.boundingBox()
    assert.ok(bounds)
    await dialog.dispatchEvent('click', { clientX: bounds.x + 2, clientY: bounds.y + 2 })
    assert.equal(await dialog.isVisible(), true, '目标为原生 dialog 的内部坐标也不能误当遮罩')
    await dialog.getByRole('button', { name: '加载更多候选', exact: true }).click()
    assert.equal(await dialog.locator('.grouping-candidate').count(), 13)
    await dialog.getByRole('checkbox', { name: '接受第 2 组合并', exact: true }).check()
    assert.deepEqual(await dialog.locator('.grouping-summary strong').allTextContents(), ['14', '13'])
    await dialog.getByRole('button', { name: '全选本批', exact: true }).click()
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 13)
    await dialog.getByRole('button', { name: '清空选择', exact: true }).click()
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0)
    for (const viewport of [{ width: 390, height: 600 }, { width: 820, height: 600 }, { width: 1180, height: 800 }]) {
      await page.setViewportSize(viewport)
      const layout = await dialog.evaluate(element => {
        const rect = element.getBoundingClientRect(), footer = element.querySelector('.grouping-footer')!.getBoundingClientRect()
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, footerTop: footer.top, footerBottom: footer.bottom, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }
      })
      assert.ok(layout.left >= 0 && layout.right <= viewport.width && layout.top >= 0 && layout.bottom <= viewport.height, `审核弹窗在 ${viewport.width}×${viewport.height} 内可达`)
      assert.ok(layout.footerTop >= layout.top && layout.footerBottom <= layout.bottom, '固定取消与确认操作不能被滚动内容挤出弹窗')
      assert.ok(layout.documentWidth <= layout.viewportWidth + 1 && layout.documentHeight <= layout.viewportHeight + 1, '候选列表应内部滚动，不能撑大页面')
      await page.mouse.click(layout.left + 2, layout.top + 5)
      assert.equal(await dialog.isVisible(), true, '真实内部空白点击保留审核方案')
    }
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    dialog = await openPersonGroupingDialog(page)
    await dialog.locator('.grouping-summary').waitFor()
    assert.equal(await dialog.locator('.grouping-candidate').count(), 12, '重新打开从首批候选开始')
    await page.mouse.click(1, 1)
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
  } finally { await page.close() }
})

test('旧分组整理：比较及应用失败都可重新比较，只有明确确认才提交当前方案', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', fail: ['prepareGrouping'] })
  try {
    await installGroupingPreview(page)
    const original = await page.evaluate(() => ({ babies: structuredClone((window as any).__fixtures.family.babies), memberships: (window as any).__fixtures.assets.map((asset: any) => [...asset.babyIds]) }))
    const dialog = await openPersonGroupingDialog(page)
    await dialog.getByRole('alert').filter({ hasText: '模拟prepareGrouping失败' }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
    await page.evaluate(() => { (window as any).__fixtures.fail = ['applyGrouping'] })
    await dialog.getByRole('button', { name: '重新比较', exact: true }).click()
    await dialog.locator('.grouping-summary').waitFor()
    await dialog.getByRole('checkbox', { name: '接受第 1 组合并', exact: true }).check()
    assert.equal(await dialog.getByRole('button', { name: '确认应用 1 组合并', exact: true }).isEnabled(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
    await dialog.getByRole('button', { name: '确认应用 1 组合并', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '模拟applyGrouping失败' }).waitFor()
    assert.equal(await dialog.getByRole('button', { name: '确认应用 1 组合并', exact: true }).isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplied), [])
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.fail = []; fixtures.groupingPreviews['library-one'].id = 'grouping-plan-retry'
    })
    await dialog.getByRole('button', { name: '重新比较', exact: true }).click()
    await dialog.locator('.grouping-summary').waitFor()
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts.length), 1, '重新比较不应隐式重试应用')
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0, '新方案必须重新核对，不能沿用旧方案勾选')
    await dialog.getByRole('checkbox', { name: '接受第 1 组合并', exact: true }).check()
    await dialog.getByRole('button', { name: '确认应用 1 组合并', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [{ planId: 'grouping-plan-one', libraryId: 'library-one', sourceIds: ['fragment-1'] }, { planId: 'grouping-plan-retry', libraryId: 'library-one', sourceIds: ['fragment-1'] }])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplied), [{ planId: 'grouping-plan-retry', libraryId: 'library-one', sourceIds: ['fragment-1'] }])
    assert.deepEqual(await page.evaluate(() => ({ babies: (window as any).__fixtures.family.babies, memberships: (window as any).__fixtures.assets.map((asset: any) => asset.babyIds) })), original)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('旧分组整理：待归组入口仅筛选未分组人脸，全部媒体清除该条件和人物筛选', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3, ungrouped: { faces: 1, assets: 1 } })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, asset = fixtures.assets[0]
      asset.personIds = []; delete asset.faces[0].personId; delete asset.faces[0].personName
      fixtures.similarResults[`${asset.id}:${asset.faces[0].id}`] = fixtures.assets.map((item: any) => item.id)
    })
    await page.getByRole('button', { name: '待归组 · 1 张照片与视频', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.match(await page.locator('.person-context').innerText(), /待归组的人脸/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1)), { page: 1, limit: 50, libraryId: 'library-one', order: 'desc', ungroupedFaces: true })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await waitForPreviewImage(page)
    assert.equal(await preview.locator('.face-box,.face-selector').count(), 0, '待归组照片普通预览也不直接标记人脸')
    await preview.getByRole('button', { name: '选择人脸查找', exact: true }).click()
    await preview.locator('.face-selector button').click()
    assert.equal(await preview.locator('.face-selector button').getAttribute('aria-pressed'), 'true')
    assert.equal(await preview.getByRole('combobox', { name: '此人脸对应的宝宝', exact: true }).count(), 0)
    assert.equal(await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).count(), 0, '人物查找不混入宝宝参考操作')
    await preview.getByRole('button', { name: '查找相似照片', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    await page.locator('.similar-face-context').waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 3)
    const reference = await page.evaluate(() => ({ assetId: (window as any).__fixtures.assets[0].id, faceId: (window as any).__fixtures.assets[0].faces[0].id }))
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1)), { ...reference, scope: 'all', page: 1, limit: 50, order: 'desc' }, '未分组的清晰人脸也能全局查找，不携带旧人物和待归组条件')
    await page.locator('.similar-face-context').getByRole('button', { name: '全部媒体', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'all' && document.querySelectorAll('.media-card').length === 3)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1)), { page: 1, limit: 50, libraryId: 'library-one', order: 'desc' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
  } finally { await page.close() }
})

test('旧分组整理：候选头像共用六个并发名额，加载更多复用缓存且提交中阻止取消', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 14 })
  try {
    await installGroupingPreview(page, 13)
    await page.evaluate(async () => {
      const fixtures = (window as any).__fixtures, api = (window as any).jinchuan, original = api.mediaUrl
      ;(window as any).__testApp.unmount()
      fixtures.thumbStarted = []; fixtures.thumbCompleted = []; fixtures.thumbResolvers = []; fixtures.thumbActive = 0; fixtures.thumbPeak = 0
      api.mediaUrl = async (id: string, thumbnail: boolean, libraryId: string) => {
        fixtures.thumbStarted.push({ id, thumbnail, libraryId }); fixtures.thumbActive++; fixtures.thumbPeak = Math.max(fixtures.thumbPeak, fixtures.thumbActive)
        await new Promise<void>(resolve => fixtures.thumbResolvers.push(resolve))
        try { return await original(id, thumbnail, libraryId) }
        finally { fixtures.thumbActive--; fixtures.thumbCompleted.push(id) }
      }
      const componentUrl = '/src/components/PersonGroupingDialog.vue'
      const GroupingDialog = (await import(componentUrl)).default
      const { createApp, h, reactive, UiProvider } = (window as any).__testVue
      const props = reactive({ preview: fixtures.groupingPreviews['library-one'], loading: false, busy: false, error: '', libraryId: 'library-one' }), host = reactive({ open: true })
      ;(window as any).__groupingProps = props
      const app = createApp({ render: () => h(UiProvider, null, { default: () => host.open ? h(GroupingDialog, { ...props, onClose: () => { host.open = false } }) : null }) })
      ;(window as any).__testApp = app; app.mount('#app')
    })
    const dialog = page.getByRole('dialog', { name: '整理已识别人脸', exact: true })
    await dialog.waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.thumbStarted.length === 6)
    assert.equal(await dialog.locator('.grouping-candidate').count(), 12)
    await dialog.getByRole('button', { name: '加载更多候选', exact: true }).click()
    assert.equal(await dialog.locator('.grouping-candidate').count(), 13)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.thumbStarted.length), 6, '上一批未完成时不能再启动六个请求')
    for (const completed of [6, 12, 14]) {
      await page.evaluate(() => { (window as any).__fixtures.thumbResolvers.splice(0).forEach((resolve: () => void) => resolve()) })
      await page.waitForFunction(count => (window as any).__fixtures.thumbCompleted.length >= count, completed)
    }
    await page.waitForFunction(() => [...document.querySelectorAll('.person-grouping-dialog .face-avatar img')].length === 26 && [...document.querySelectorAll('.person-grouping-dialog .face-avatar img')].every(image => (image as HTMLImageElement).naturalWidth > 0))
    const thumbnailCalls = await page.evaluate(() => ({ starts: (window as any).__fixtures.thumbStarted, peak: (window as any).__fixtures.thumbPeak }))
    assert.equal(thumbnailCalls.peak, 6)
    assert.equal(thumbnailCalls.starts.length, 14)
    assert.equal(new Set(thumbnailCalls.starts.map((call: any) => call.id)).size, 14, '多个目标头像复用同一个媒体缩略图缓存')
    assert.ok(thumbnailCalls.starts.every((call: any) => call.thumbnail === true && call.libraryId === 'library-one'))
    await page.evaluate(() => { (window as any).__groupingProps.busy = true })
    assert.equal(await dialog.getByRole('button', { name: '正在应用…', exact: true }).isDisabled(), true)
    assert.equal(await dialog.getByRole('button', { name: '取消', exact: true }).isDisabled(), true)
    await page.keyboard.press('Escape')
    assert.equal(await dialog.isVisible(), true)
    await page.mouse.click(1, 1)
    assert.equal(await dialog.isVisible(), true, '应用中点击遮罩也不能关闭当前选择')
    await page.evaluate(() => { (window as any).__groupingProps.busy = false })
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
  } finally { await page.close() }
})

test('人物合并先点头像再明确确认，取消不发送请求，成功刷新合并计数和照片', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3 })
  try {
    let dialog = await openPersonMerge(page)
    assert.equal(await dialog.getByRole('button', { name: '确认合并', exact: true }).isEnabled(), false)
    assert.equal(await dialog.locator('.person-rename,.person-merge').count(), 0, '选择目标时不混入命名或再次合并入口')
    assert.equal(await dialog.locator('.person-card[data-person-id="person-one"]').count(), 0, '来源不能被选作合并目标')
    const target = dialog.locator('.person-card[data-person-id="person-two"] .person-open')
    await target.click()
    assert.equal(await target.getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mergeAttempts.length), 0, '点头像只选目标，尚未授权合并')
    await dialog.getByRole('button', { name: '取消', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mergeAttempts.length), 0)
    await page.locator('.person-card[data-person-id="person-one"] .person-merge').click()
    dialog = page.getByRole('dialog', { name: '合并人物', exact: true })
    await dialog.locator('.person-card[data-person-id="person-two"] .person-open').click()
    const original = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { babies: structuredClone(fixtures.family.babies), memberships: fixtures.assets.map((asset: any) => [...asset.babyIds]) }
    })
    await dialog.getByRole('button', { name: '确认合并', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.merged), [{ sourceId: 'person-one', targetId: 'person-two', libraryId: 'library-one' }])
    const merged = page.locator('.person-card[data-person-id="person-two"]')
    assert.equal(await page.locator('.person-card').count(), 1)
    assert.equal(await page.locator('.person-card[data-person-id="person-one"]').count(), 0)
    assert.match(await merged.innerText(), /3 张照片与视频/)
    assert.match(await merged.innerText(), /另一个场景/)
    const records = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { babies: fixtures.family.babies, memberships: fixtures.assets.map((asset: any) => asset.babyIds) }
    })
    assert.deepEqual(records, original, '合并人物不修改宝宝档案、人脸参考或相册关联')
    await merged.locator('.person-open').click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 3)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1).faceId), 'face-2')
  } finally { await page.close() }
})

test('人物合并失败在对话框内显示原因，保留头像目标并允许成功重试', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3, fail: ['merge'] })
  try {
    const dialog = await openPersonMerge(page)
    const target = dialog.locator('.person-card[data-person-id="person-two"] .person-open')
    await target.click()
    await dialog.getByRole('button', { name: '确认合并', exact: true }).click()
    await dialog.getByRole('alert').filter({ hasText: '模拟merge失败' }).waitFor({ state: 'visible' })
    assert.equal(await target.getAttribute('aria-pressed'), 'true', '失败后保留已明确核对的头像')
    assert.equal(await dialog.locator('.person-card.is-selected').getAttribute('data-person-id'), 'person-two')
    assert.equal(await dialog.getByRole('button', { name: '确认合并', exact: true }).isEnabled(), true)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.family.people.length), 2, '失败不能移除来源人物或改计数')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.merged.length), 0)
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await dialog.getByRole('button', { name: '确认合并', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.mergeAttempts), [
      { sourceId: 'person-one', targetId: 'person-two', libraryId: 'library-one' },
      { sourceId: 'person-one', targetId: 'person-two', libraryId: 'library-one' },
    ])
    assert.equal(await page.locator('.person-card').count(), 1)
    assert.match(await page.locator('.person-card').innerText(), /3 张照片与视频/)
  } finally { await page.close() }
})

test('人物合并迟到成功在关闭、切库或卸载后不恢复旧弹窗，也不污染新库人物', options, async () => {
  for (const action of ['library', 'unmount', 'button', 'escape', 'backdrop'] as const) {
    const page = await openPage({ module: 'library', page: 'people', count: 3 })
    try {
      const dialog = await openPersonMerge(page)
      await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        fixtures.delays.merge = 1000
        const other = structuredClone(fixtures.assets[0])
        Object.assign(other, { id: 'f'.repeat(64) + '-1024', filename: 'new-library-person.jpg', babyIds: [], personIds: ['new-library-person'] })
        other.locations[0].libraryId = 'library-two'; Object.assign(other.faces[0], { id: 'new-library-face', personId: 'new-library-person', personName: '新库妈妈' })
        fixtures.assets.push(other)
        const family = structuredClone(fixtures.family)
        family.people = [{ id: 'new-library-person', name: '新库妈妈', faceCount: 1, assetCount: 1, reference: { assetId: other.id, face: other.faces[0], kind: 'photo' } }]
        fixtures.familyByLibrary['library-two'] = family
      })
      await dialog.locator('.person-card[data-person-id="person-two"] .person-open').click()
      await dialog.getByRole('button', { name: '确认合并', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.mergeAttempts.length === 1)
      assert.equal(await dialog.locator('.merge-footer').getByRole('button', { name: '取消', exact: true }).isEnabled(), true, '请求进行中也保留明确关闭入口')
      if (action === 'unmount') await page.evaluate(() => { (window as any).__testApp.unmount() })
      else if (action === 'library') {
        await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
        await page.locator('.person-card[data-person-id="new-library-person"]').waitFor()
      }
      else if (action === 'button') await dialog.locator('.merge-footer').getByRole('button', { name: '取消', exact: true }).click()
      else if (action === 'escape') await page.keyboard.press('Escape')
      else await page.mouse.click(5, 5)
      await dialog.waitFor({ state: 'detached' })
      await page.waitForFunction(() => (window as any).__fixtures.calls.merged.length === 1)
      assert.equal(await page.getByRole('dialog', { name: '合并人物', exact: true }).count(), 0)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.merged), [{ sourceId: 'person-one', targetId: 'person-two', libraryId: 'library-one' }], '请求固定使用确认时的来源、目标和照片库')
      if (action === 'unmount') assert.equal(await page.locator('.family-workspace').count(), 0)
      else if (action === 'library') {
        assert.equal(await page.locator('.person-card').count(), 1)
        assert.equal(await page.locator('.person-card').getAttribute('data-person-id'), 'new-library-person')
        assert.match(await page.locator('.person-card').innerText(), /新库妈妈/)
        assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).libraryId), 'library-two')
        await page.locator('.person-card .person-open').click()
        await page.getByRole('button', { name: '查看照片 new-library-person.jpg', exact: true }).waitFor()
        assert.equal(await page.locator('.media-card').count(), 1)
      }
      else assert.equal(await page.locator('.family-workspace').isVisible(), true, '关闭合并界面保留当前人物页面，已提交结果仍由后续刷新读取')
    } finally { await page.close() }
  }
})

test('人物头像临时加载失败后保留手动重试，两次轮询不重跑，重试恢复有效图片', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 0 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, api = (window as any).jinchuan, original = api.mediaUrl
      fixtures.avatarFailure = true; fixtures.avatarAttempts = []
      fixtures.family.people[0].reference = { assetId: 'avatar-retry', kind: 'photo', face: { id: 'face-retry', x: 0.2, y: 0.2, width: 0.2, height: 0.3, score: 0.95 } }
      api.mediaUrl = async (id: string, thumbnail: boolean, libraryId: string) => {
        if (id !== 'avatar-retry') return original(id, thumbnail, libraryId)
        fixtures.avatarAttempts.push({ libraryId, thumbnail })
        if (fixtures.avatarFailure) throw new Error('模拟头像 IPC 临时失败')
        fixtures.avatarRecoveryUrl = await original(id, thumbnail, libraryId)
        return fixtures.avatarRecoveryUrl
      }
    })
    const retry = page.getByRole('button', { name: '重试加载 1 个头像', exact: true })
    await retry.waitFor()
    assert.equal(await page.locator('.person-card .face-avatar img').count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.avatarAttempts.length), 1)
    await waitForFamilyPoll(page)
    await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.avatarAttempts.length), 1, '失败头像不随家庭状态轮询自动重跑')
    assert.equal(await retry.count(), 1, '同一照片库保留用户可操作的重试入口')
    await page.evaluate(() => { (window as any).__fixtures.avatarFailure = false })
    await retry.click()
    const avatar = page.locator('.person-card .face-avatar img')
    await avatar.waitFor()
    await page.waitForFunction(() => {
      const image = document.querySelector('.person-card .face-avatar img') as HTMLImageElement | null
      return Boolean(image?.complete && image.naturalWidth > 0)
    })
    assert.equal(await avatar.getAttribute('src'), await page.evaluate(() => (window as any).__fixtures.avatarRecoveryUrl))
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.avatarAttempts), [{ libraryId: 'library-one', thumbnail: true }, { libraryId: 'library-one', thumbnail: true }])
    assert.equal(await retry.count(), 0)
  } finally { await page.close() }
})

test('人物照片视图切库恢复新库头像总览，旧人物追加迟到仍可查看新库人物', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 51 })
  try {
    await page.locator('.person-card .person-open').click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.similarDelays['all:all:all:2'] = 900
      const asset = structuredClone(fixtures.assets[0]); asset.id = 'new-library-person'; asset.filename = 'new-library-person.jpg'; asset.personIds = ['person-two']; asset.locations[0].libraryId = 'library-two'
      Object.assign(asset.faces[0], { personId: 'person-two', personName: '新库妈妈' })
      fixtures.assets.push(asset)
      const family = structuredClone(fixtures.family); family.photoCount = 1; family.people = [{ id: 'person-two', name: '新库妈妈', faceCount: 1, assetCount: 1, reference: { assetId: asset.id, face: asset.faces[0], kind: 'photo' } }]
      fixtures.familyByLibrary['library-two'] = family
      ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新人物照片库', path: 'C:/New', enabled: true })
    })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.similarQueries.some((query: any) => query.scope === 'all' && query.faceId === 'face-one' && query.page === 2))
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    const newPerson = page.locator('.person-card').filter({ hasText: '新库妈妈' })
    await newPerson.locator('.face-avatar img').waitFor()
    assert.equal(await page.locator('.person-context').count(), 0)
    assert.equal(await page.locator('.media-card').count(), 0, '切库先回到新库人物头像总览')
    assert.equal(await page.locator('.person-card').count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).personId), undefined)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedSimilarQueries.some((query: any) => query.scope === 'all' && query.faceId === 'face-one' && query.page === 2))
    await page.waitForTimeout(100)
    assert.equal(await page.locator('.media-card').count(), 0, '旧人物追加完成后不能退出新库头像总览')
    await newPerson.locator('.person-open').click()
    await page.getByRole('button', { name: '查看照片 new-library-person.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.media-card').count(), 1)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1))
    assert.equal(query.libraryId, undefined); assert.equal(query.scope, 'all'); assert.equal(query.assetId, 'new-library-person')
  } finally { await page.close() }
})

/** 用不同人物编号和跨库位置模拟同一张脸的相似结果，不把 exact 分组冒充相似匹配。 */
async function installSimilarScenes(page: Page): Promise<void> {
  await page.evaluate(() => {
    const fixtures = (window as any).__fixtures
    for (const [index, asset] of fixtures.assets.entries()) {
      if (index > 0) { asset.personIds = [`scene-person-${index}`]; Object.assign(asset.faces[0], { personId: asset.personIds[0], personName: `不同场景 ${index}` }) }
      if (index > 1) asset.locations[0].libraryId = 'library-two'
    }
    fixtures.similarAssets = fixtures.assets.slice(0, -2).map((asset: any) => asset.id)
    fixtures.assets.at(-2).faceState = 'pending'; fixtures.assets.at(-1).faceState = 'error'
    Object.assign(fixtures.family.people[0], { assetCount: 1, faceCount: 1 })
    ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '其他已授权照片库', path: 'C:/SyntheticOther', enabled: true })
  })
}

test('人物头像按该脸跨分组查找全部已授权目录，结果完整计数分页且原图操作使用全局范围', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 75 })
  try {
    await installSimilarScenes(page)
    await page.locator('.media-kind-filter').getByRole('button', { name: '视频', exact: true }).click()
    await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).fill('家人')
    await page.locator('.person-card .person-open').click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1)), { assetId: await page.evaluate(() => (window as any).__fixtures.assets[0].id), faceId: 'face-one', scope: 'all', page: 1, limit: 50, order: 'desc' })
    assert.equal(await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).count(), 0, '相似查询隐藏无关搜索，旧视频条件不限制照片结果')
    assert.match(await page.locator('.media-toolbar-heading').innerText(), /73 项/)
    assert.match(await page.locator('.similar-face-coverage').innerText(), /73\s*\/\s*75/)
    assert.match(await page.locator('.similar-face-coverage').innerText(), /1.*待分析|待分析.*1/)
    assert.match(await page.locator('.similar-face-coverage').innerText(), /1.*失败|失败.*1/)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 1, '另一库的不同人物分组照片仍参与相似查询')
    await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'photo-3.jpg', exact: true })
    await dialog.locator('.detail-media-stage img').waitFor()
    assert.equal(await dialog.locator('.face-box,.face-selector').count(), 0, '相似结果打开照片仍是无脸标记的普通预览')
    await dialog.getByRole('button', { name: '照片信息', exact: true }).click()
    await dialog.getByRole('button', { name: '打开原文件位置', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.reveals.some((request: any) => request.id === (window as any).__fixtures.assets[2].id))
    const scopes = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, id = fixtures.assets[2].id
      return { raw: fixtures.calls.mediaScopes.filter((request: any) => request.id === id && !request.thumbnail), reveal: fixtures.calls.reveals.filter((request: any) => request.id === id) }
    })
    assert.ok(scopes.raw.length > 0); assert.ok(scopes.raw.every((request: any) => request.libraryId === undefined))
    assert.deepEqual(scopes.reveal, [{ id: await page.evaluate(() => (window as any).__fixtures.assets[2].id), libraryId: undefined }])
    await dialog.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 73 项'))
    // 照片列表先追加，缩略图队列完成后才更新分页底部的完成状态。
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 73 项') && document.querySelector('.media-load-more')?.textContent?.includes('已加载当前索引的全部 73 项'))
    assert.match(await page.locator('.media-load-more').innerText(), /已加载当前索引的全部 73 项/)
    assert.ok(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.some((query: any) => query.scope === 'all' && query.page === 2 && query.limit === 50)))
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-75.jpg', exact: true }).count(), 0, '没有检测特征的媒体只能计入覆盖率，不能冒充匹配结果')
  } finally { await page.close() }
})

test('相似分页：搜索输入后快速追加全部结果，过期搜索防抖不重置已加载页面', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 75, clockTime: '2026-10-02T00:00:00Z' })
  try {
    await installSimilarScenes(page)
    // 冻结浏览器时钟，稳定复现先完成两页、后触发三百毫秒防抖的顺序。
    await page.clock.pauseAt('2026-10-02T00:01:00Z')
    const started = await page.evaluate(() => Date.now())
    await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).fill('家人')
    await page.locator('.person-card .person-open').click({ force: true })
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.locator('.media-load-more').getByRole('button', { name: '加载更多', exact: true }).click({ force: true })
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 73 项') && document.querySelector('.media-load-more')?.textContent?.includes('已加载当前索引的全部 73 项'))
    assert.ok(await page.evaluate(initial => Date.now() - initial < 300, started), '两页必须在搜索防抖到期前完成，不能靠较慢操作避开问题')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.map((query: any) => query.page)), [1, 2])
    await page.clock.runFor(650)
    await assertVirtualIndex(page, 73)
    assert.match(await page.locator('.media-load-more').innerText(), /已加载当前索引的全部 73 项/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.map((query: any) => query.page)), [1, 2], '超过旧防抖期限后，不能另发第一页请求并丢掉追加结果')
  } finally { await page.close() }
})

test('分析失败仍保留有效人脸并返回相似媒体时，不将零完成计数误报为尚无人脸结果', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) { asset.faceState = 'error'; asset.faceError = '部分分析失败，已检测的人脸保留' }
      fixtures.similarAssets = fixtures.assets.map((asset: any) => asset.id)
    })
    await page.locator('.person-card .person-open').click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 3 && Boolean(document.querySelector('.similar-face-coverage')))
    assert.match(await page.locator('.media-toolbar-heading').innerText(), /3 项/)
    assert.match(await page.locator('.similar-face-coverage').innerText(), /0\s*\/\s*3/)
    assert.match(await page.locator('.similar-face-coverage').innerText(), /失败\s*3\s*项/)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 1)
    assert.equal(await page.locator('.similar-face-empty-analysis').count(), 0, '失败项目已缓存的有效人脸仍有匹配结果，不能宣称完全尚无人脸结果')
  } finally { await page.close() }
})

test('相似结果切范围和退出后丢弃迟到旧页，恢复当前库完整媒体而非残留全局匹配', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 75 })
  try {
    await installSimilarScenes(page)
    await page.locator('.person-card .person-open').click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await page.evaluate(() => { (window as any).__fixtures.similarDelays['all:all:all:2'] = 900 })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.similarQueries.some((query: any) => query.scope === 'all' && query.page === 2))
    await chooseSelect(page, selectControl(page, '相似人脸查找范围'), 'library')
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 2)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).count(), 0)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedSimilarQueries.some((query: any) => query.scope === 'all' && query.page === 2))
    assert.equal(await page.locator('.media-card').count(), 2, '迟到全局页不能追加到当前库结果')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.similarQueries.at(-1)), { assetId: await page.evaluate(() => (window as any).__fixtures.assets[0].id), faceId: 'face-one', scope: 'library', libraryId: 'library-one', page: 1, limit: 50, order: 'desc' })
    const completedBefore = await page.evaluate(() => (window as any).__fixtures.calls.completedSimilarQueries.length)
    await page.evaluate(() => { (window as any).__fixtures.similarDelays['all:all:all:1'] = 900 })
    await chooseSelect(page, selectControl(page, '相似人脸查找范围'), 'all')
    await page.waitForFunction(() => (window as any).__fixtures.calls.similarQueries.at(-1).scope === 'all')
    await page.locator('.similar-face-context').getByRole('button', { name: '全部媒体', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 2 && !document.querySelector('.similar-face-context'))
    await page.waitForFunction(previous => (window as any).__fixtures.calls.completedSimilarQueries.length > previous, completedBefore)
    assert.equal(await page.locator('.media-card').count(), 2)
    assert.equal(await page.locator('.similar-face-context').count(), 0, '退出后不能恢复旧相似结果和范围菜单')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).libraryId), 'library-one')
  } finally { await page.close() }
})

test('同页点击全部媒体清除人物、搜索、来源、日期和类型筛选', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).fill('photo-1.jpg')
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await openTools(page, '.advanced-filters')
    const fields = page.locator('.advanced-filter-fields')
    await chooseSelect(page, selectControl(page, '来源'), 'folder')
    await chooseSelect(page, selectControl(page, '日期来源'), 'capture')
    await chooseSelect(page, selectControl(page, '人物'), 'person-one')
    await fillDate(page.getByLabel('从', { exact: true }), '2024-03-01')
    await fillDate(page.getByLabel('到', { exact: true }), '2024-03-31')
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).to === '2024-03-31' && (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).search === 'photo-1.jpg')
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '全部照片与视频', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length === 2)
    const query = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.deepEqual(query, { libraryId: 'library-one', page: 1, limit: 50, order: 'desc' })
    assert.equal(await page.getByRole('searchbox', { name: '搜索照片、人物', exact: true }).inputValue(), '')
    await openTools(page, '.advanced-filters')
    assert.equal(await selectValue(selectControl(page, '人物')), '')
  } finally { await page.close() }
})

test('普通预览不画检测脸，宝宝选脸明确进入并在退出、关闭和换照片后清理模式', options, async () => {
  for (const module of ['library','baby']) {
    const page = await openPage({ module, page: module === 'baby' ? 'references' : 'all' })
    try {
      await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
      await dialog.locator('.detail-media-stage img').waitFor()
      assert.equal(await dialog.locator('.face-layer,.face-selector,.face-actions').count(), 0)
      if (module === 'baby') {
        await dialog.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
        await dialog.locator('.face-selector button').first().click()
        assert.equal(await dialog.locator('.face-box.chosen').count(), 1)
        await dialog.getByRole('button', { name: '退出选脸', exact: true }).click()
        assert.equal(await dialog.locator('.face-layer,.face-selector,.face-actions').count(), 0)
        await dialog.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
        assert.equal(await dialog.locator('.face-selector button[aria-pressed="true"]').count(), 0, '再次进入必须重新选脸')
      }
      await dialog.getByRole('button', { name: '关闭预览', exact: true }).click()
      await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
      const second = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
      await second.locator('.detail-media-stage img').waitFor()
      assert.equal(await second.locator('.face-layer,.face-selector,.face-actions').count(), 0)
    } finally { await page.close() }
  }
})

test('人脸分析在图库和普通预览持续显示进度，完成提示保留原图且不重新启动分析', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 2, noReferences: true,
    jobs: [{ id: 'running-faces', kind: 'faces', state: 'running', processed: 1, total: 10, label: '合成处理项', error: '', libraryId: 'library-one', startedAt: new Date(Date.now() - 30000).toISOString() }],
    analysis: { done: 1, pending: 9, error: 0, faceCount: 2 },
  })
  try {
    const galleryProgress = page.locator('.family-workspace > .face-analysis-progress')
    await galleryProgress.waitFor()
    assert.match(await galleryProgress.innerText(), /已处理 1 \/ 10 项/)
    assert.match(await galleryProgress.innerText(), /已完成缓存复用/)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    const progress = preview.locator('.face-analysis-progress')
    await progress.waitFor()
    const image = preview.locator('.detail-media-stage img')
    await image.waitFor()
    const source = await image.getAttribute('src')
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.length)
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.family.jobs[0].processed = 4; fixtures.family.analysis.faceCount = 5 })
    await waitForFamilyPoll(page)
    assert.match(await progress.innerText(), /已处理 4 \/ 10 项.*检测到 5 张人脸/s)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), queries, '进度轮询不重复读取图库')
    assert.equal(await image.getAttribute('src'), source)
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.family.jobs[0].processed = 10; fixtures.family.jobs[0].state = 'done'; fixtures.family.analysis.pending = 0 })
    await waitForFamilyPoll(page)
    await progress.waitFor({ state: 'detached' })
    await galleryProgress.waitFor({ state: 'detached' })
    assert.match(await page.locator('.family-workspace').innerText(), /人脸分析已完成/)
    assert.equal(await image.getAttribute('src'), source, '完成提示保留正在浏览的原图')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('人脸分析准备阶段显示明确状态和未知进度，禁止重复发起任务', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 2, noReferences: true,
    jobs: [{ id: 'starting-faces', kind: 'faces', state: 'running', processed: 0, total: 0, label: '正在准备', error: '', libraryId: 'library-one' }],
    analysis: { done: 0, pending: 2, error: 0, faceCount: 0 },
  })
  try {
    const progress = page.locator('.family-workspace > .face-analysis-progress')
    await progress.waitFor()
    assert.match(await progress.innerText(), /正在准备分析/)
    assert.doesNotMatch(await progress.innerText(), /NaN|100%|预计剩余/)
    assert.equal(await progress.locator('progress').getAttribute('value'), null)
    assert.equal(await page.getByRole('button', { name: '分析图库人脸', exact: true }).isDisabled(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('缩略图读取失败明确提示，重试保留图库记录且不重新扫描原文件', options, async () => {
  const page = await openPage({ module: 'import', page: 'folder', count: 2, noReferences: true })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.thumbnailFailures[fixtures.assets[0].id] = true
      Object.assign((window as any).__testProps, { module: 'library', page: 'all' })
    })
    const warning = page.locator('.thumbnail-load-error')
    await warning.waitFor()
    assert.match(await warning.innerText(), /有 1 项缩略图未能显示/)
    assert.equal(await page.locator('.media-card').count(), 2)
    await page.evaluate(() => { (window as any).__fixtures.thumbnailFailures = {} })
    await warning.getByRole('button', { name: '重试缩略图', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card img').length === 2 && [...document.querySelectorAll('.media-card img')].every(image => (image as HTMLImageElement).naturalWidth > 0))
    await warning.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
    assert.equal(await page.locator('.media-card').count(), 2)
  } finally { await page.close() }
})

test('失效缩略图地址只自动更新一次，持续解码失败停止重试并允许手动恢复', options, async () => {
  for (const mode of ['once', 'always']) {
    const page = await openPage({ module: 'import', page: 'folder', count: 2, noReferences: true })
    try {
      await page.evaluate(mode => {
        const fixtures = (window as any).__fixtures, api = (window as any).jinchuan, original = api.mediaUrl
        fixtures.thumbnailBrokenMode = mode; fixtures.thumbnailDecodeAttempts = 0
        api.mediaUrl = async (id: string, thumbnail: boolean, libraryId?: string) => {
          const url = await original(id, thumbnail, libraryId)
          if (thumbnail && id === fixtures.assets[0].id) {
            fixtures.thumbnailDecodeAttempts++
            if (fixtures.thumbnailBrokenMode === 'always' || fixtures.thumbnailBrokenMode === 'once' && fixtures.thumbnailDecodeAttempts === 1) return 'data:image/jpeg;base64,bm90LWEtanBlZw=='
          }
          return url
        }
        Object.assign((window as any).__testProps, { module: 'library', page: 'all' })
      }, mode)
      if (mode === 'always') {
        const warning = page.locator('.thumbnail-load-error')
        await warning.waitFor()
        await page.waitForTimeout(180)
        assert.equal(await page.evaluate(() => (window as any).__fixtures.thumbnailDecodeAttempts), 2, '持续解码失败不能无限请求')
        await page.evaluate(() => { (window as any).__fixtures.thumbnailBrokenMode = 'fixed' })
        await warning.getByRole('button', { name: '重试缩略图', exact: true }).click()
      }
      await page.waitForFunction(() => document.querySelectorAll('.media-card img').length === 2 && [...document.querySelectorAll('.media-card img')].every(image => (image as HTMLImageElement).naturalWidth > 0))
      assert.equal(await page.evaluate(() => (window as any).__fixtures.thumbnailDecodeAttempts), mode === 'once' ? 2 : 3)
      assert.equal(await page.locator('.thumbnail-load-error').count(), 0)
      assert.ok(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.every((call: any) => call.thumbnail && call.libraryId === 'library-one')))
    } finally { await page.close() }
  }
})

test('首次进入图库显示组件库加载与骨架，完成后恢复可操作的月份按钮', options, async () => {
  const page = await openPage({ module: 'import', page: 'folder', count: 2, dates: ['2024-03-10', '2024-02-10'] })
  try {
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.queries), [])
    await page.evaluate(() => {
      (window as any).__fixtures.queryDelays['library-one:all:1'] = 1500
      const props = (window as any).__testProps; props.module = 'library'; props.page = 'all'
    })
    const loading = page.locator('.loading-status'), placeholders = page.locator('.gallery-loading-placeholders')
    await loading.locator('.n-spin').waitFor()
    assert.equal(await loading.getAttribute('role'), 'status')
    assert.equal(await loading.getAttribute('aria-live'), 'polite')
    assert.match(await loading.innerText(), /正在读取照片/)
    assert.equal(await placeholders.isVisible(), true)
    assert.equal(await placeholders.getAttribute('aria-hidden'), 'true')
    assert.equal(await placeholders.locator('.gallery-loading-tile .n-skeleton').count(), 10)
    assert.equal(await page.locator('.media-card,.family-empty').count(), 0, '首批读取期间保留骨架，不闪现空结果')
    await waitForIndexed(page, 2)
    await loading.waitFor({ state: 'detached' })
    await placeholders.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.loading-status .n-spin,.gallery-loading-placeholders').count(), 0)
    const toggle = page.locator('.month-group-toggle').first()
    assert.equal(await toggle.evaluate(element => element.tagName), 'BUTTON')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    const controlledId = await toggle.getAttribute('aria-controls')
    assert.ok(controlledId)
    assert.equal(await page.evaluate(id => document.getElementById(id!)?.getAttribute('data-month-grid'), controlledId), '2024-03')
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await page.locator('[data-month-grid="2024-03"]').isVisible(), false)
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('[data-month-grid="2024-03"]').isVisible(), true)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 1).length), 1)
  } finally { await page.close() }
})

test('追加加载显示统一反馈并禁止重复请求，失败保留选择且手动重试后收起加载', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 75 })
  try {
    await waitForIndexed(page, 50)
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.queryDelays['library-one:all:2'] = 1500
      fixtures.queryFailures['library-one:all:2'] = 1
    })
    const more = page.locator('.media-load-more')
    await more.scrollIntoViewIfNeeded()
    await more.locator('.ui-loading .n-spin').waitFor()
    const loadButton = more.getByRole('button', { name: '加载更多', exact: true })
    assert.equal(await more.getAttribute('aria-busy'), 'true')
    assert.equal(await more.locator('.ui-loading').isVisible(), true)
    assert.match(await more.locator('.ui-loading').innerText(), /正在加载更多.*已加载 50\s*\/\s*75 项/)
    assert.equal(await loadButton.isDisabled(), true)
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const existing = await page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label')))
    assert.ok(existing.length > 0, '追加等待保留当前视口中的已有照片')
    assert.ok(existing.every(label => /^查看照片 photo-(?:[1-9]|[1-4]\d|50)\.jpg$/.test(label ?? '')))
    const bounds = await loadButton.boundingBox()
    assert.ok(bounds)
    await page.mouse.click(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2)
    assert.deepEqual(await page.locator('.media-cover').evaluateAll(elements => elements.map(element => element.getAttribute('aria-label'))), existing)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 1, '点击禁用的加载入口不重复追加请求')
    await more.getByRole('alert').filter({ hasText: '模拟第 2 页加载失败' }).waitFor()
    await more.locator('.ui-loading').waitFor({ state: 'detached' })
    assert.equal(await more.getAttribute('aria-busy'), 'false')
    assert.equal(await more.locator('.n-spin').count(), 0)
    assert.match(await more.innerText(), /已加载 50\s*\/\s*75 项/)
    const retry = more.getByRole('button', { name: '重试加载', exact: true })
    assert.equal(await retry.isEnabled(), true)
    await scrollGallery(page, 'top')
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 1, '失败反馈不因状态轮询自动重试')
    await retry.click()
    await more.locator('.ui-loading .n-spin').waitFor()
    assert.equal(await more.getByRole('button', { name: '加载更多', exact: true }).isDisabled(), true)
    await waitForIndexed(page, 75)
    await more.locator('.ui-loading').waitFor({ state: 'detached' })
    assert.equal(await more.getAttribute('aria-busy'), 'false')
    assert.equal(await more.locator('.n-spin,.error-text').count(), 0)
    assert.match(await more.innerText(), /已加载当前索引的全部 75 项/)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), 2)
    await scrollGallery(page, 'top')
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
  } finally { await page.close() }
})

test('月份默认展开可独立收起，未知月份始终在末尾且正逆序保持正确', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 4, dates: ['2024-03-10', '2024-01-02', '2024-05-01'] })
  try {
    await page.evaluate(() => { (window as any).__fixtures.assets[3].date = null })
    await page.locator('.media-kind-filter').getByRole('button', { name: '照片', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.month-group-toggle').length === 4)
    const labels = () => page.locator('.month-group-toggle h2').allTextContents()
    assert.deepEqual(await labels(), ['2024年5月', '2024年3月', '2024年1月', '日期待确认'])
    const march = page.locator('.media-date-group').filter({ has: page.locator('.month-group-toggle h2', { hasText: '2024年3月' }) })
    const toggle = march.locator('.month-group-toggle')
    assert.equal(await toggle.getAttribute('aria-expanded'), 'true')
    assert.ok(await toggle.getAttribute('aria-controls'))
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-expanded'), 'false')
    assert.equal(await march.locator('.media-grid').isVisible(), false)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }).isVisible(), true, '收起一月不隐藏其他月份')
    await toggle.click()
    assert.equal(await march.locator('.media-grid').isVisible(), true)
    await chooseSelect(page, selectControl(page, '日期排序'), 'asc')
    await page.waitForFunction(() => document.querySelector('.month-group-toggle h2')?.textContent === '2024年1月')
    assert.deepEqual(await labels(), ['2024年1月', '2024年3月', '2024年5月', '日期待确认'])
  } finally { await page.close() }
})

test('折叠月份仍自动追加，折叠全部使新月份继承收起并在展开后补缩略图与保留选择', options, async () => {
  const dates = Array.from({ length: 151 }, (_, index) => index < 50 ? '2024-03-10' : index < 100 ? '2024-02-10' : '2024-01-10')
  const page = await openPage({ module: 'library', page: 'all', count: dates.length, dates })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    const month = (label: string) => page.locator('.media-date-group').filter({ has: page.locator('.month-group-toggle h2', { hasText: label }) })
    await month('2024年3月').locator('.month-group-toggle').click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.page === 2))
    await month('2024年2月').locator('.month-group-toggle').waitFor()
    assert.equal(await month('2024年3月').locator('.month-group-toggle').getAttribute('aria-expanded'), 'false')
    assert.equal(await month('2024年2月').locator('.month-group-toggle').getAttribute('aria-expanded'), 'true', '只收起一个月不影响下一页新月份的默认展开')
    assert.equal(await month('2024年3月').locator('.media-card').count(), 0, '收起月份不创建隐藏媒体卡片')
    assert.match(await month('2024年2月').locator('.month-group-toggle').innerText(), /已加载 50 项/)
    assert.ok(await month('2024年2月').locator('.media-card').count() < 50, '可视卡片不代表该月全部索引')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.month-group-toggle')].every(element => element.getAttribute('aria-expanded') === 'false') && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.media-load-more')?.textContent?.includes('已加载当前索引的全部 151 项'))
    assert.deepEqual(await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), ['false','false','false'])
    assert.match(await page.locator('.media-load-more').innerText(), /已加载当前索引的全部 151 项/)
    assert.equal(await page.locator('.media-card').count(), 0, '全部收起后仅保留月份标题与空网格')
    assert.deepEqual(await page.evaluate(() => [...new Set((window as any).__fixtures.calls.completedQueries.filter((query: any) => query.libraryId === 'library-one').map((query: any) => query.page))]), [1,2,3,4], '真实观察器连续完成全部四批媒体记录')
    const unopenedThumbnailRequests = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, ids = new Set(fixtures.assets.slice(100).map((asset: any) => asset.id))
      return fixtures.calls.mediaScopes.filter((request: any) => request.thumbnail && ids.has(request.id))
    })
    assert.equal(unopenedThumbnailRequests.length, 0, '折叠全部后新月份只追加记录，尚未展开的照片不请求缩略图')
    await month('2024年1月').locator('.month-group-toggle').click()
    await page.waitForFunction(() => {
      const fixtures = (window as any).__fixtures
      return fixtures.calls.mediaScopes.some((request: any) => request.thumbnail && request.id === fixtures.assets[100].id)
    })
    assert.equal(await month('2024年1月').locator('.month-group-toggle').getAttribute('aria-expanded'), 'true')
    assert.equal(await month('2024年3月').locator('.month-group-toggle').getAttribute('aria-expanded'), 'false')
    assert.equal(await month('2024年2月').locator('.month-group-toggle').getAttribute('aria-expanded'), 'false', '展开单月不能取消其他月份的收起状态')
    await assertVirtualIndex(page, 151)
    assert.equal(await month('2024年1月').locator('.media-card').count(), await page.locator('.media-card').count(), '只创建当前展开月份的可视卡片')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    await clickMediaCardControl(page, '选择 photo-101.jpg')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 2 项/)
    await page.locator('.month-view-actions').getByRole('button', { name: '展开全部', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.month-group-toggle')].every(element => element.getAttribute('aria-expanded') === 'true') && !document.querySelector('.month-fold-status'))
    assert.deepEqual(await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), ['true','true','true'])
    await scrollGallery(page, 'top')
    await assertVirtualIndex(page, 151)
    assert.equal(await page.evaluate(() => new Set((window as any).__fixtures.calls.completedQueryItems.filter((result: any) => result.query.limit === 50).flatMap((result: any) => result.ids)).size), 151, '全部四批索引没有漏项或重复')
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    await month('2024年1月').locator('.month-group-toggle').scrollIntoViewIfNeeded()
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    assert.equal(await page.getByRole('button', { name: '选择 photo-101.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 2 项/)
  } finally { await page.close() }
})

test('折叠触发的自动追加失败保留记录与选择，明确重试后继续加载新月份', options, async () => {
  const dates = Array.from({ length: 101 }, (_, index) => index < 50 ? '2024-03-10' : index < 100 ? '2024-02-10' : '2024-01-10')
  const page = await openPage({ module: 'library', page: 'all', count: dates.length, dates })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.evaluate(() => { (window as any).__fixtures.queryFailures['library-one:all:2'] = 1 })
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.month-group-toggle')].every(element => element.getAttribute('aria-expanded') === 'false') && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.locator('.media-load-more .error-text').filter({ hasText: '模拟第 2 页加载失败' }).waitFor()
    assert.match(await page.locator('.media-load-more').innerText(), /已加载 50\s*\/\s*101 项/)
    assert.equal(await page.locator('.media-card').count(), 0)
    assert.equal(await page.locator('.month-group-toggle').first().getAttribute('aria-expanded'), 'false')
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    const attempts = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length)
    await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.page === 2).length), attempts, '失败页不因底部观察器或状态轮询反复请求')
    await page.locator('.media-load-more').getByRole('button', { name: '重试加载', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.media-load-more')?.textContent?.includes('已加载当前索引的全部 101 项'))
    assert.equal(await page.locator('.media-load-more .error-text').count(), 0)
    assert.equal(await page.locator('.media-card').count(), 0)
    assert.deepEqual(await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), ['false','false','false'])
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    await page.locator('.media-date-group').filter({ has: page.locator('.month-group-toggle h2', { hasText: '2024年3月' }) }).locator('.month-group-toggle').click()
    await scrollGallery(page, 'top')
    await assertVirtualIndex(page, 101)
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true', '重新创建月份卡片后恢复原来的已选状态')
  } finally { await page.close() }
})

test('折叠月份触发的旧库追加迟到不混入新库，新库恢复默认展开并清除旧选择', options, async () => {
  const dates = Array.from({ length: 101 }, (_, index) => index < 50 ? '2024-03-10' : '2024-02-10')
  const page = await openPage({ module: 'library', page: 'all', count: dates.length, dates })
  try {
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 50 项'))
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.queryDelays['library-one:all:2'] = 900
      const other = structuredClone(fixtures.assets[0])
      Object.assign(other, { id: 'f'.repeat(64) + '-1024', filename: 'new-library-folded.jpg', date: '2024-01-10', captureDate: '2024-01-10' })
      other.locations[0].libraryId = 'library-two'; fixtures.assets.push(other)
      ;(window as any).__testProps.receiver.libraries.push({ id: 'library-two', name: '新月份照片库', path: 'C:/SyntheticNew', enabled: true })
    })
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.month-group-toggle')].every(element => element.getAttribute('aria-expanded') === 'false') && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.libraryId === 'library-one' && query.page === 2))
    assert.equal(await page.locator('.media-card').count(), 0, '旧库收起时无需创建媒体卡片来等待下一批记录')
    await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryId = 'library-two' })
    await page.getByRole('button', { name: '查看照片 new-library-folded.jpg', exact: true }).waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.libraryId === 'library-one' && query.page === 2))
    assert.equal(await page.locator('.media-card').count(), 1)
    assert.deepEqual(await page.locator('.month-group-toggle h2').allTextContents(), ['2024年1月'])
    assert.equal(await page.locator('.month-group-toggle').getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('.selection-toolbar').count(), 0)
    assert.match(await page.locator('.media-toolbar-heading').innerText(), /1 项/)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-51.jpg', exact: true }).count(), 0)
  } finally { await page.close() }
})

test('传输记录预览显示真实回执信息与位置，保持传输文件名并按坐标返回当前批次', options, async () => {
  const file = { id: 'receipt-info', libraryId: 'library-one', relativePath: '2026-10-01/保存位置.jpg', savedAt: '2026-09-30T18:00:00Z', filename: '上传时的文件名.jpg', size: 4096, batchId: 'batch-info' }
  const page = await openPage({ shell: true, module: 'library', page: 'all', transfer: { files: [file] } })
  try {
    await page.evaluate(() => {
      Object.assign((window as any).__fixtures.assets[0].locations[0], { receiptId: 'receipt-info', path: '合成归档目录/真实回执位置.jpg' })
      ;(window as any).__fixtures.queryDelays['library-one:all:1'] = 900
    })
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.transfer-summary .transfer-row').click()
    await page.locator('.directory-list .photo-symbol').click()
    const preview = page.getByRole('dialog', { name: file.filename, exact: true })
    await preview.waitFor()
    await preview.locator('.preview-placeholder').waitFor()
    assert.equal(await preview.locator('.preview-heading h2').innerText(), file.filename, '共享内容索引的原文件名不能替代本次传输文件名')
    const information = preview.getByRole('button', { name: '照片信息', exact: true })
    const infoBounds = await information.boundingBox(), topbar = await page.locator('.topbar').boundingBox()
    assert.ok(infoBounds && topbar && infoBounds.y >= topbar.y + topbar.height)
    await page.mouse.click(infoBounds.x + infoBounds.width / 2, infoBounds.y + infoBounds.height / 2)
    const metadata = preview.locator('.detail-metadata')
    await metadata.waitFor()
    await waitForPreviewImage(page)
    assert.equal(await information.getAttribute('aria-expanded'), 'true', '加载期间打开的信息在读取索引和原图后仍保持展开')
    assert.equal(await metadata.isVisible(), true)
    assert.match(await metadata.innerText(), /上传时的文件名\.jpg.*4 KB.*320 × 240.*拍摄与归档日期.*保存回执时间.*保存照片库.*合成归档.*真实回执位置\.jpg/s)
    await preview.getByRole('button', { name: '打开原文件位置', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.receiptReveals?.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.receiptReveals), [file.id])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.reveals), [], '传输记录定位必须使用保存回执，而非共享媒体的其他位置')
    const close = preview.getByRole('button', { name: '关闭预览', exact: true })
    assert.match(await close.innerText(), /返回记录/)
    const closeBounds = await close.boundingBox()
    assert.ok(closeBounds && closeBounds.y >= topbar.y + topbar.height)
    await page.mouse.click(closeBounds.x + closeBounds.width / 2, closeBounds.y + closeBounds.height / 2)
    await preview.waitFor({ state: 'detached' })
    assert.match(await page.locator('.library-toggle').innerText(), /合成归档/)
    assert.equal(await page.locator('.directory-list li').count(), 1)
    assert.match(await page.locator('.directory-list').innerText(), /上传时的文件名\.jpg/)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.receiver.files), [file])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('未索引回执照片预览保留信息，读取失败可原位重试且不冒充拍摄日期或重新扫描', options, async () => {
  const file = { id: 'receipt-unindexed', libraryId: 'library-one', relativePath: '2026-10-01/未索引.jpg', savedAt: '2026-09-30T18:00:00Z', filename: '未索引.jpg', size: 2048, batchId: 'batch-unindexed' }
  const page = await openPage({ shell: true, module: 'library', page: 'all', fail: ['previewFile'], transfer: { files: [file] } })
  try {
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.transfer-summary .transfer-row').click()
    await page.locator('.directory-list .photo-symbol').click()
    const preview = page.getByRole('dialog', { name: file.filename, exact: true })
    await preview.getByRole('button', { name: '重试预览', exact: true }).waitFor()
    assert.match(await preview.locator('.preview-placeholder').innerText(), /模拟previewFile失败/)
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    const metadata = preview.locator('.detail-metadata')
    assert.match(await metadata.innerText(), /尚未建立媒体索引.*保存回执时间不作为拍摄日期.*保存照片库.*合成归档目录\/2026-10-01\/未索引\.jpg/s)
    assert.equal(await metadata.locator('dt').filter({ hasText: '拍摄与归档日期' }).count(), 0)
    await page.evaluate(() => { (window as any).__fixtures.fail = [] })
    await preview.getByRole('button', { name: '重试预览', exact: true }).click()
    await waitForPreviewImage(page)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.receiptPreviews), [file.id, file.id])
    assert.equal(await preview.locator('.preview-placeholder').count(), 0)
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await preview.waitFor({ state: 'detached' })
    assert.equal(await page.locator('.directory-list li').count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('同日真实批次独立，复用旧回执与截断快照仍列出已保存结果且不重复计数', options, async () => {
  const receipt = { id: 'receipt-one', libraryId: 'library-one', relativePath: '2026-10-01/original.jpg', savedAt: '2026-09-30T18:00:00Z' }
  const session = (id: string, batchId: string, filename: string, value: typeof receipt, updatedAt: string) => ({ id, batchId, libraryId: 'library-one', filename, size: 1024, offset: 1024, state: 'complete', error: '', updatedAt, archiveDate: '2026-10-01', receipt: value })
  const page = await openPage({ shell: true, module: 'library', page: 'all', transfer: {
    files: [{ ...receipt, filename: 'original.jpg', size: 1024, batchId: 'batch-one' }],
    sessions: [session('session-one', 'batch-one', 'original.jpg', receipt, '2026-09-30T18:01:00Z'), session('session-two', 'batch-two', 'reuse.jpg', receipt, '2026-09-30T19:00:00Z'), session('session-three', 'batch-two', 'snapshot-truncated.jpg', { ...receipt, id: 'receipt-truncated', relativePath: '2026-10-01/truncated.jpg', savedAt: '2026-09-30T19:00:00Z' }, '2026-09-30T19:00:01Z')],
  } })
  try {
    await page.evaluate(() => { (window as any).__fixtures.assets[0].locations[0].receiptId = 'receipt-one' })
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    const rows = page.locator('.transfer-summary .transfer-row')
    assert.equal(await rows.count(), 2, '同日两个真实批次不能合并')
    const localDate = await page.evaluate(() => new Date('2026-09-30T19:00:01Z').toLocaleDateString('sv-SE'))
    assert.equal(localDate, '2026-10-01', '北京时间已跨日')
    assert.match(await rows.first().innerText(), new RegExp(localDate))
    const reusedBatch = rows.filter({ hasText: /2 项/ })
    assert.match(await reusedBatch.innerText(), /已保存 2/)
    await reusedBatch.click()
    assert.equal(await page.locator('.directory-list li').count(), 2, '新批次复用与截断回执均应显示结果')
    assert.match(await page.locator('.directory-list').innerText(), /reuse.jpg/)
    assert.match(await page.locator('.directory-list').innerText(), /已有原文件/)
    assert.match(await page.locator('.directory-list').innerText(), /snapshot-truncated.jpg/)
    assert.match(await page.locator('.directory-list').innerText(), /保存回执/)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.receiver.files[0].batchId), 'batch-one', '不能把旧文件改成新批次保存记录')
    for (const action of ['escape', 'backdrop', 'button'] as const) {
      await page.locator('.directory-list .photo-symbol').first().click()
      const preview = page.getByRole('dialog', { name: 'reuse.jpg', exact: true })
      await preview.waitFor()
      await preview.locator('img').waitFor()
      assert.equal(await preview.getByRole('button', { name: '关闭预览', exact: true }).isVisible(), true)
      if (action === 'escape') await page.keyboard.press('Escape')
      else if (action === 'backdrop') {
        const topbar = await page.locator('.topbar').boundingBox()
        assert.ok(topbar)
        await page.mouse.click(5, topbar.y + topbar.height + 5)
      } else await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
      await preview.waitFor({ state: 'detached' })
      assert.equal(await page.locator('.directory-list li').count(), 2, '关闭预览后保留当前批次详情')
    }
    await page.getByRole('button', { name: '← 返回', exact: true }).click()
    await page.locator('.transfer-summary .transfer-row').filter({ hasText: /1 项/ }).click()
    assert.equal(await page.locator('.directory-list li').count(), 1, '文件与同一回执的完成会话按回执身份去重')
    assert.match(await page.locator('.page-content').innerText(), /1 项 · 已保存 1/)
  } finally { await page.close() }
})

test('空库刷新不启动扫描，显式重扫仅当前库且不把来源预扫描失败误报成库扫描失败', options, async () => {
  const job = { id: 'scan-one', libraryId: 'library-one', kind: 'scan', state: 'error', processed: 2, total: 2, label: '合成失败', error: '合成中断' }
  const scenarios = [
    { jobs: [{ ...job, scanPurpose: 'library' }], hint: '上次扫描中断' },
    { jobs: [{ ...job, scanPurpose: 'import-preview' }, { ...job, id: 'library-done', state: 'done', scanPurpose: 'library' }], hint: null },
    { jobs: [job], hint: '上次扫描或预扫描中断' },
  ]
  for (const scenario of scenarios) {
    const page = await openPage({ module: 'library', page: 'all', count: 0, jobs: scenario.jobs })
    try {
      const status = page.locator('.gallery-scan-status'), controls = page.locator('.gallery-scan-actions')
      await controls.waitFor()
      await page.waitForFunction(() => !document.querySelector('.loading-status'))
      if (scenario.hint) assert.ok((await status.innerText()).includes(scenario.hint))
      else assert.equal(await status.locator('.scan-interrupted').count(), 0)
      const before = await page.evaluate(() => (window as any).__fixtures.calls.queries.length)
      await controls.getByRole('button', { name: '刷新列表', exact: true }).click()
      await page.waitForFunction((count: number) => (window as any).__fixtures.calls.queries.length > count, before)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [], '刷新只读索引，不能触发真实扫描')
      await controls.getByRole('button', { name: '重新扫描', exact: true }).click()
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans), ['library-one'])
      await page.evaluate(() => { (window as any).__testProps.receiver.currentLibraryAvailable = false })
      assert.equal(await controls.getByRole('button', { name: '重新扫描', exact: true }).isDisabled(), true)
    } finally { await page.close() }
  }
})

test('字节发送完和缺失回执的完成状态都保持待确认，详情不丢失任务或伪报已保存', options, async () => {
  const session = (id: string, state: string, filename: string) => ({ id, state, filename, batchId: 'batch-waiting', libraryId: 'library-one', size: 1024, offset: 1024, error: '', updatedAt: '2026-10-01T08:00:00Z', archiveDate: '2026-10-01' })
  const page = await openPage({ shell: true, module: 'library', page: 'all', transfer: { files: [], sessions: [session('sent', 'committing', 'sent.jpg'), session('no-receipt', 'complete', 'await-receipt.jpg')] } })
  try {
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    const waiting = page.locator('.transfer-summary .transfer-row')
    assert.equal(await waiting.count(), 1)
    assert.match(await waiting.innerText(), /2 项/)
    assert.match(await waiting.innerText(), /已保存 0 · 待处理 2/)
    await waiting.click()
    assert.equal(await page.locator('.directory-list li').count(), 0)
    assert.equal(await page.locator('.transfer-task').count(), 2, 'complete 但无回执的任务仍需可见')
    assert.match(await page.locator('.page-content').innerText(), /sent.jpg/)
    assert.match(await page.locator('.page-content').innerText(), /await-receipt.jpg/)
    const summaries = await page.locator('.transfer-task summary').allInnerTexts()
    assert.ok(summaries.every(text => text.includes('等待电脑确认')))
    assert.ok(summaries.every(text => !text.includes('已保存')))
  } finally { await page.close() }
})

test('人物整理仅提交勾选来源，查看关联照片返回保留选择，并可明确撤销本次整理', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 4 })
  try {
    await installGroupingPreview(page, 3)
    const dialog = await openPersonGroupingDialog(page)
    await dialog.locator('.grouping-summary').waitFor()
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '关闭人物整理')
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 0)
    await dialog.getByRole('checkbox', { name: '接受第 2 组合并', exact: true }).check()
    await dialog.getByRole('button', { name: '查看来源人物 2 的照片', exact: true }).click()
    const preview = page.getByRole('dialog', { name: 'photo-3.jpg', exact: true })
    await preview.waitFor(); await waitForPreviewImage(page)
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await dialog.isVisible(), false, '查看照片暂时退出原生顶层，不用旧审核遮挡预览')
    assert.equal(await preview.locator('.face-box,.face-selector').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplyAttempts), [])
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await dialog.waitFor()
    assert.equal(await dialog.getByRole('checkbox', { name: '接受第 2 组合并', exact: true }).isChecked(), true)
    assert.equal(await dialog.getByRole('checkbox', { checked: true }).count(), 1)
    await page.waitForFunction(() => document.activeElement === document.querySelector('.person-grouping-dialog button[aria-label="查看来源人物 2 的照片"]'))
    assert.equal(await dialog.getByRole('button', { name: '查看来源人物 2 的照片', exact: true }).evaluate(element => element === document.activeElement), true)
    await dialog.getByRole('button', { name: '确认应用 1 组合并', exact: true }).click()
    await dialog.waitFor({ state: 'detached' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingApplied), [{ planId: 'grouping-plan-one', libraryId: 'library-one', sourceIds: ['fragment-2'] }])
    const undo = page.getByRole('button', { name: /撤销.*整理/ })
    await undo.waitFor()
    await undo.click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.groupingUndos.length === 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.groupingUndos), [{ token: 'undo-grouping-plan-one', libraryId: 'library-one' }])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('宝宝成长相册默认包含疑似，人工确认与参考分别显示，顶部筛选和全库范围真实切换', options, async () => {
  const page = await openPage({ count: 4 })
  try {
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).includeCandidates), true)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.assets[2].babyIds = []; fixtures.assets[2].candidateBabyIds = ['baby-one']
      fixtures.manualMemberships['baby-one:' + fixtures.assets[0].id] = true
      fixtures.assets[3].locations[0].libraryId = 'library-two'
      const library = { id: 'library-two', name: '另一个合成库', path: 'C:/SyntheticSecond', enabled: true }
      fixtures.receiver.libraries.push(library)
    })
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await waitForIndexed(page, 3)
    const card = (filename: string) => page.getByRole('button', { name: '查看照片 ' + filename, exact: true }).locator('..')
    assert.equal(await card('photo-1.jpg').locator('.media-candidate').innerText(), '人工确认')
    assert.equal(await card('photo-1.jpg').locator('.media-reference').innerText(), '已作参考')
    assert.equal(await card('photo-2.jpg').locator('.media-candidate').innerText(), '自动匹配')
    assert.equal(await card('photo-2.jpg').locator('.media-reference').count(), 0)
    assert.equal(await card('photo-3.jpg').locator('.media-candidate').innerText(), '疑似')
    const filters = page.locator('.baby-result-filter')
    await filters.getByRole('button', { name: /^已加入 2$/ }).click()
    await waitForIndexed(page, 2)
    assert.equal(await card('photo-3.jpg').count(), 0)
    const included = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(included.includeCandidates, undefined); assert.equal(included.candidates, undefined)
    await filters.getByRole('button', { name: /^疑似 1$/ }).click()
    await waitForIndexed(page, 1)
    assert.equal(await card('photo-3.jpg').count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1).candidates), true)
    await filters.getByRole('button', { name: '全部', exact: true }).click()
    await waitForIndexed(page, 3)
    await chooseSelect(page, selectControl(page, '宝宝查找范围'), 'all')
    await waitForIndexed(page, 4)
    const global = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1))
    assert.equal(global.libraryId, undefined); assert.equal(global.scope, 'all')
    await card('photo-4.jpg').locator('.media-cover').click()
    await waitForPreviewImage(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => !request.thumbnail).at(-1).libraryId), undefined)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
  } finally { await page.close() }
})

test('宝宝预览确认归属不自动设参考，组合入口必须明确选脸后保存且不重读所有页面', options, async () => {
  const page = await openPage({ count: 3 })
  try {
    await page.evaluate(() => {
      for (const asset of (window as any).__fixtures.assets) { asset.babyIds = []; asset.candidateBabyIds = ['baby-one'] }
    })
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await waitForIndexed(page, 3)
    const originals = await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces)
    const queryCount = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    let preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await waitForPreviewImage(page)
    assert.equal(await preview.locator('.face-box,.face-selector').count(), 0)
    await preview.getByRole('button', { name: '是宝宝', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.memberships.length === 1)
    assert.equal(await preview.locator('.face-box,.face-selector').count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.family.babies[0].referenceFaces), originals)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queryCount)
    await preview.getByRole('button', { name: '不是宝宝', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.memberships.length === 2)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 3, '排除只改关联，不能删除原媒体')
    await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true })
    await waitForPreviewImage(page)
    await preview.getByRole('button', { name: '确认并设为参考', exact: true }).click()
    await preview.locator('.face-selector').waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.memberships.length), 2, '组合入口尚未选脸时不能确认归属或保存参考')
    const save = preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true })
    assert.equal(await save.isDisabled(), true)
    await preview.locator('.face-selector button').click()
    await save.click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.references.length === 1)
    const result = await page.evaluate(() => ({ saved: (window as any).__fixtures.calls.references, asset: (window as any).__fixtures.assets[1], references: (window as any).__fixtures.family.babies[0].referenceFaces }))
    assert.deepEqual(result.saved, [{ babyId: 'baby-one', assetId: result.asset.id, faceId: 'face-2' }])
    assert.ok(result.references.some((reference: any) => reference.faceId === 'face-one'))
    assert.equal(result.asset.babyIds.includes('baby-one'), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('宝宝大批缓存匹配先显示运行进度，完成轮询更新疑似结果，识别失败只明确重试失败项目', options, async () => {
  const page = await openPage({ page: 'references', count: 40 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.matchState = 'running'
      for (const asset of fixtures.assets) asset.babyIds = []
      fixtures.family.analysis = { pending: 0, done: 39, error: 1, faceCount: 39 }
    })
    await waitForFamilyPoll(page)
    await page.locator('.recognition-panel').getByRole('button', { name: '仅重试失败', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [{ libraryId: 'library-one', retryOnlyFailed: true }])
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
    await page.waitForFunction(() => (window as any).__testProps.page === 'timeline')
    await openRecognitionDetails(page)
    await page.locator('.baby-match-coverage').filter({ hasText: /正在匹配.*0.*40/ }).waitFor()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.matches), [{ babyId: 'baby-one', libraryId: 'library-one', scope: 'library' }])
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      for (const asset of fixtures.assets) asset.candidateBabyIds = ['baby-one']
      Object.assign(fixtures.family.babyMatching[0], { state: 'done', processed: 40, candidates: 40, addedCandidates: 40 })
    })
    await waitForIndexed(page, 40)
    await page.locator('.baby-match-coverage').filter({ hasText: /已分析 40.*40 项/ }).waitFor()
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 40', exact: true }).count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.memberships), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
  } finally { await page.close() }
})

test('一万项照片索引按批完整加载，可视卡片有界，展开月份只读取视口缩略图', { ...options, timeout: 120000 }, async () => {
  const page = await openPage({ module: 'library', page: 'all', count: 10000 })
  try {
    await waitForIndexed(page, 50)
    await page.locator('.media-card').first().waitFor()
    assert.ok(await page.locator('.media-card').count() < 100)
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-toggle')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => document.querySelector('.month-group-actions>span')?.textContent?.includes('已加载 10000 项'), undefined, { timeout: 90000 })
    assert.equal(await page.locator('.media-card').count(), 0)
    const loaded = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      return { ids: new Set(fixtures.calls.completedQueryItems.filter((result: any) => result.query.limit === 50).flatMap((result: any) => result.ids)).size, thumbnails: fixtures.calls.mediaScopes.filter((request: any) => request.thumbnail).length, lastPage: Math.max(...fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).map((query: any) => query.page)) }
    })
    assert.equal(loaded.ids, 10000); assert.equal(loaded.lastPage, 200)
    assert.ok(loaded.thumbnails < 100, '折叠状态加载全部元数据不能请求整月缩略图')
    await page.locator('.month-group-toggle').click()
    await scrollGallery(page, 'top')
    await assertVirtualIndex(page, 10000)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    await scrollGallery(page, 'bottom')
    await page.getByRole('button', { name: '查看照片 photo-10000.jpg', exact: true }).waitFor()
    await assertVirtualIndex(page, 10000)
    const after = await page.evaluate(() => (window as any).__fixtures.calls.mediaScopes.filter((request: any) => request.thumbnail))
    assert.ok(after.length < 150, '展开与滚动仅请求顶部、末尾和缓冲区，不能解码一万张照片')
    assert.equal(new Set(after.map((request: any) => request.id)).size, after.length, '回到同一视口复用已有缩略图')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('同库切模块返回恢复月份、滚动与选择，切库后清除旧图库状态', options, async () => {
  const dates = Array.from({ length: 101 }, (_, index) => index < 50 ? '2024-03-10' : index < 100 ? '2024-02-10' : '2024-01-10')
  const page = await openPage({ shell: true, module: 'library', page: 'all', count: 101, dates })
  try {
    await waitForIndexed(page, 50)
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => [...document.querySelectorAll('.month-group-toggle')].every(element => element.getAttribute('aria-expanded') === 'false') && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 101)
    await page.locator('.media-date-group').filter({ has: page.getByRole('heading', { name: '2024年2月', exact: true }) }).locator('.month-group-toggle').click()
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 150; element.dispatchEvent(new Event('scroll')) })
    const before = await page.locator('.page-content').evaluate(element => element.scrollTop)
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && !query.babyId).length)
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.locator('.baby-profile-banner').waitFor()
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await page.locator('.module-navigation').getByRole('button', { name: '照片与视频', exact: true }).click()
    await waitForIndexed(page, 101)
    assert.deepEqual(await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), ['false', 'true', 'false'])
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    assert.equal(await page.locator('.page-content').evaluate(element => element.scrollTop), before)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && !query.babyId).length), queries, '返回同库浏览直接复用加载元数据')
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, asset = structuredClone(fixtures.assets[0])
      Object.assign(asset, { id: 'd'.repeat(64) + '-1024', filename: 'new-context.jpg' }); asset.locations[0].libraryId = 'library-two'; fixtures.assets.push(asset)
      const library = { id: 'library-two', name: '新库', path: 'C:/SyntheticNew', enabled: true }
      fixtures.receiver.libraries.push(library)
    })
    await page.locator('.library-toggle').click()
    await page.locator('.library-menu').getByRole('button', { name: /新库/ }).click()
    await page.getByRole('button', { name: '查看照片 new-context.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.selection-toolbar').count(), 0)
    assert.equal(await page.locator('.month-group-toggle').getAttribute('aria-expanded'), 'true')
    assert.equal(await page.locator('.page-content').evaluate(element => element.scrollTop), 0)
  } finally { await page.close() }
})

test('排除超过一页后返回同库仍能补齐剩余索引，分页移位不漏尾部照片或重复重读全部页', { ...options, timeout: 90000 }, async () => {
  const page = await openPage({ shell: true, count: 300 })
  try {
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.locator('.baby-profile-banner').waitFor()
    await waitForIndexed(page, 50)
    await page.evaluate(() => { (window as any).__fixtures.queryFailures['library-one:all:6'] = 1 })
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-toggle')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 250)
    await page.locator('.media-load-more .error-text').filter({ hasText: '模拟第 6 页加载失败' }).waitFor()
    await page.locator('.month-group-toggle').click()
    await scrollGallery(page, 'top')
    for (let index = 1; index <= 60; index++) {
      const control = page.getByRole('button', { name: '选择 photo-' + index + '.jpg', exact: true })
      if (!(await control.count())) {
        await page.locator('.media-card').last().scrollIntoViewIfNeeded()
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
      }
      await clickMediaCardControl(page, '选择 photo-' + index + '.jpg')
    }
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 60 项/)
    const before = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await page.locator('.selection-toolbar').getByRole('button', { name: '确认不是宝宝', exact: true }).click()
    await waitForIndexed(page, 190)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), before, '批量排除只修补当前索引，不整页重查')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.memberships[0].ids.length), 60)
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await waitForIndexed(page, 190)
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-toggle')?.getAttribute('aria-expanded') === 'false' && !document.querySelector('.month-fold-status'))
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 240)
    assert.match(await page.locator('.media-load-more').innerText(), /已加载当前索引的全部 240 项/)
    await page.locator('.month-group-toggle').click()
    await scrollGallery(page, 'top')
    await page.getByRole('button', { name: '查看照片 photo-61.jpg', exact: true }).waitFor()
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 0)
    await scrollGallery(page, 'bottom')
    await page.getByRole('button', { name: '查看照片 photo-300.jpg', exact: true }).waitFor()
    await assertVirtualIndex(page, 240)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 300)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('旧空宝宝相册在图库明确加入后返回显示新照片，版本未变时再次返回直接复用缓存', options, async () => {
  const page = await openPage({ shell: true, count: 3 })
  try {
    await page.evaluate(() => { for (const asset of (window as any).__fixtures.assets) asset.babyIds = [] })
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.locator('.growth-toolbar').waitFor()
    await page.locator('.family-empty').waitFor()
    await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 0', exact: true }).waitFor()
    assert.equal(await page.locator('.media-card').count(), 0)
    await page.locator('.module-navigation').getByRole('button', { name: '照片与视频', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await chooseSelect(page, selectControl(page, '加入的宝宝相册'), 'baby-one')
    await page.locator('.selection-toolbar').getByRole('button', { name: '加入宝宝相册', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.memberships.length === 1 && (window as any).__fixtures.family.browseRevision === 'fixture-1')
    await page.getByRole('status').filter({ hasText: '已确认是宝宝。' }).waitFor()
    const before = await page.evaluate(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length)
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    await waitForIndexed(page, 1)
    await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 1', exact: true }).waitFor()
    await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 0', exact: true }).waitFor()
    assert.equal(await page.locator('.media-card .media-candidate').innerText(), '人工确认')
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 0)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length), before + 1, '旧空快照失效后重新读取当前宝宝索引，不依赖手动刷新')
    const refreshed = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 1', exact: true }).count(), 1)
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 0', exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), refreshed, '数据未变的模块往返保留缓存，不因状态新对象重新查询')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 3)
  } finally { await page.close() }
})

test('宝宝快照同数量换图仍刷新已加载索引，保留月份、滚动和未受影响的选择', options, async () => {
  const dates = Array.from({ length: 102 }, (_, index) => index < 80 ? '2024-05-10' : index < 100 || index === 101 ? '2024-04-10' : '2024-03-10')
  const page = await openPage({ shell: true, count: 102, dates })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.assets[101].babyIds = ['baby-two']
      fixtures.assets[1].babyIds = ['baby-two']; fixtures.assets[1].candidateBabyIds = ['baby-one']
    })
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await waitForIndexed(page, 50)
    await page.locator('.month-view-actions').getByRole('button', { name: '折叠全部', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.month-fold-status') && document.querySelector('.month-group-toggle')?.getAttribute('aria-expanded') === 'false')
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 101)
    await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 100', exact: true }).waitFor()
    await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 1', exact: true }).waitFor()
    const april = page.locator('.media-date-group').filter({ has: page.getByRole('heading', { name: '2024年4月', exact: true }) })
    await april.locator('.month-group-toggle').click()
    await clickMediaCardControl(page, '选择 photo-81.jpg')
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event('scroll')) })
    const scroll = await page.locator('.page-content').evaluate(element => element.scrollTop)
    assert.ok(scroll > 0, '使用真实有内容的滚动位置验证恢复')
    const collapsed = await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded')))
    assert.deepEqual(collapsed, ['false', 'true', 'false'])
    const completedBefore = await page.evaluate(() => (window as any).__fixtures.calls.completedQueryItems.length)
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, removed = fixtures.assets[89], added = fixtures.assets[101]
      removed.babyIds = ['baby-two']; added.babyIds = ['baby-one', 'baby-two']
      fixtures.manualMemberships[`baby-one:${removed.id}`] = false; fixtures.manualMemberships[`baby-one:${added.id}`] = true
      fixtures.family.browseRevision = 'fixture-external-replacement'
    })
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.waitForFunction(previous => (window as any).__fixtures.calls.completedQueryItems.slice(previous).filter((entry: any) => entry.query.limit === 50 && entry.query.babyId === 'baby-one').length === 3, completedBefore)
    await waitForIndexed(page, 101)
    await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 100', exact: true }).waitFor()
    await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 1', exact: true }).waitFor()
    assert.deepEqual(await page.locator('.month-group-toggle').evaluateAll(elements => elements.map(element => element.getAttribute('aria-expanded'))), collapsed)
    assert.equal(await page.locator('.page-content').evaluate(element => element.scrollTop), scroll)
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
    assert.equal(await page.getByRole('button', { name: '选择 photo-81.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    const refreshed = await page.evaluate(previous => {
      const fixtures = (window as any).__fixtures
      return { ids: fixtures.calls.completedQueryItems.slice(previous).filter((entry: any) => entry.query.limit === 50 && entry.query.babyId === 'baby-one').flatMap((entry: any) => entry.ids), removed: fixtures.assets[89].id, added: fixtures.assets[101].id }
    }, completedBefore)
    assert.equal(new Set(refreshed.ids).size, 101)
    assert.equal(refreshed.ids.includes(refreshed.removed), false, '数量不变也不能恢复已排除的旧记录')
    assert.equal(refreshed.ids.includes(refreshed.added), true, '同数量替换的新照片必须进入缓存')
    await scrollGallery(page, 'bottom')
    await page.getByRole('button', { name: '查看照片 photo-102.jpg', exact: true }).waitFor()
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await waitForIndexed(page, 101)
    await page.getByRole('button', { name: '查看照片 photo-102.jpg', exact: true }).waitFor()
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 100', exact: true }).count(), 1)
    assert.equal(await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 1', exact: true }).count(), 1)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queries, '已更新版本的快照再次返回直接复用')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 102, '刷新关联记录不删除任何媒体')
  } finally { await page.close() }
})

test('宝宝快照失效后的重读请求迟到，切库或切到参考页面后不能覆盖新上下文', { ...options, timeout: 45000 }, async () => {
  for (const change of ['library', 'page']) {
    const page = await openPage({ shell: true, count: 3 })
    try {
      await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
      await waitForIndexed(page, 3)
      await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
      await page.locator('.import-actions').waitFor()
      const previous = await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        fixtures.assets[0].babyIds = ['baby-two']; fixtures.family.browseRevision = 'fixture-late-refresh'
        fixtures.queryDelays['library-one:all:1'] = 1100
        return fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.libraryId === 'library-one' && query.babyId === 'baby-one').length
      })
      await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
      await page.waitForFunction(count => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.libraryId === 'library-one' && query.babyId === 'baby-one').length === count + 1, previous)
      if (change === 'library') {
        await page.evaluate(() => {
          const fixtures = (window as any).__fixtures, asset = structuredClone(fixtures.assets[1])
          asset.id = 'revision-new-library'; asset.filename = 'revision-new-library.jpg'; asset.locations[0].libraryId = 'library-two'
          fixtures.assets.push(asset); fixtures.receiver.libraries.push({ id: 'library-two', name: '版本验证新库', path: 'C:/SyntheticRevision', enabled: true })
        })
        await page.locator('.library-toggle').click()
        await page.locator('.library-menu').getByRole('button', { name: /版本验证新库/ }).click()
        await page.getByRole('button', { name: '查看照片 revision-new-library.jpg', exact: true }).waitFor()
      } else {
        await page.evaluate(() => { (window as any).__fixtures.queryDelays['library-one:all:1'] = 0 })
        await openTools(page, '.baby-tools')
        await page.getByRole('button', { name: '人物查找与参考', exact: true }).click()
        await page.locator('.reference-picker-entry').waitFor()
        await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).waitFor()
      }
      await page.waitForFunction(count => (window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50 && query.libraryId === 'library-one' && query.babyId === 'baby-one').length === count + 1, previous)
      if (change === 'library') {
        await waitForIndexed(page, 1)
        assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 0)
        assert.match(await page.locator('.library-toggle').innerText(), /版本验证新库/)
        assert.equal(await page.getByRole('button', { name: '查看照片 revision-new-library.jpg', exact: true }).count(), 1)
      } else {
        await waitForIndexed(page, 3)
        assert.equal(await page.locator('.reference-picker-entry').count(), 1)
        assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 1, '旧宝宝结果排除的照片仍应出现在新的参考照片范围')
      }
      assert.equal(await page.locator('.media-dialog,.selection-toolbar').count(), 0, '迟到刷新不能重新打开旧预览或恢复旧选择')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
    } finally { await page.close() }
  }
})

test('忙碌或其他宝宝匹配期间消费的新版本，在任务结束后仍刷新当前宝宝相册', { ...options, timeout: 45000 }, async () => {
  for (const waiting of ['busy', 'other-baby']) {
    const page = await openPage({ count: 2 })
    try {
      await page.evaluate(() => { (window as any).__fixtures.assets[1].babyIds = ['baby-two'] })
      await page.getByRole('button', { name: '刷新列表', exact: true }).click()
      await waitForIndexed(page, 1)
      const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length)
      if (waiting === 'busy') {
        await page.evaluate(() => { (window as any).__fixtures.delays.favorite = 5000 })
        await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
        await waitForPreviewImage(page)
        await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).getByRole('button', { name: '取消收藏', exact: true }).click()
        await page.waitForFunction(() => (window as any).__fixtures.calls.favoriteAttempts.length === 1)
      } else {
        await page.evaluate(() => {
          ;(window as any).__fixtures.family.babyMatching = [{ babyId: 'baby-two', libraryId: 'library-one', scope: 'library', state: 'running', processed: 0, total: 2, included: 2, candidates: 0, addedIncluded: 0, addedCandidates: 0, validReferences: 0, invalidReferences: 0, coverage: { total: 2, done: 2, pending: 0, error: 0, noFaces: 0 } }]
        })
      }
      await page.evaluate(() => {
        const fixtures = (window as any).__fixtures
        fixtures.assets[1].babyIds = ['baby-one', 'baby-two']; fixtures.family.browseRevision = 'fixture-consumed-while-waiting'
      })
      await page.waitForFunction(() => (window as any).__fixtures.calls.familyReadRevisions.at(-1) === 'fixture-consumed-while-waiting')
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length), queries, '新版本先被轮询消费，但当前任务未结束时不提前刷新')
      if (waiting === 'busy') {
        const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
        assert.equal(await preview.getByRole('button', { name: '取消收藏', exact: true }).isDisabled(), true)
        await page.waitForFunction(() => (window as any).__fixtures.assets[0].favorite === false)
      } else {
        await page.evaluate(() => { Object.assign((window as any).__fixtures.family.babyMatching[0], { state: 'done', processed: 2 }) })
      }
      await waitForIndexed(page, 2)
      await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 2', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length), queries + 1, '即使本宝宝没有匹配完成事件，也须补读之前未应用的版本')
      if (waiting === 'busy') {
        assert.equal(await page.locator('.detail-media-stage img').isVisible(), true)
        await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).getByRole('button', { name: '关闭预览', exact: true }).click()
      }
      await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).waitFor()
      const refreshed = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length)
      await waitForFamilyPoll(page)
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50 && query.babyId === 'baby-one').length), refreshed, '补齐后同版本的普通轮询不重复读取')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
    } finally { await page.close() }
  }
})

test('保存新参考产生同步或后台匹配结果时刷新完整相册与计数，保留原图及缩放', { ...options, timeout: 45000 }, async () => {
  for (const matching of ['done', 'running']) {
    const page = await openPage({ count: 3, autoMatch: true })
    try {
      await page.evaluate(mode => {
        const fixtures = (window as any).__fixtures
        for (const asset of fixtures.assets.slice(1)) asset.babyIds = ['baby-two']
        fixtures.assets[0].faces.push({ id: 'new-baby-reference', x: 0.6, y: 0.2, width: 0.2, height: 0.3, score: 0.99, personId: 'person-one', personName: '新的参考角度' })
        fixtures.matchAssets = fixtures.assets.slice(1).map((asset: any) => asset.id)
        fixtures.candidateMatchAssets = [fixtures.assets[2].id]; fixtures.referenceMatching = mode
      }, matching)
      await page.getByRole('button', { name: '刷新列表', exact: true }).click()
      await waitForIndexed(page, 1)
      const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
      await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
      const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
      await waitForPreviewImage(page)
      await preview.getByRole('button', { name: '实际大小', exact: true }).click()
      await preview.getByRole('button', { name: '放大', exact: true }).click()
      await preview.getByRole('button', { name: '确认并设为参考', exact: true }).click()
      await preview.locator('.face-selector button').nth(1).click()
      const zoom = await preview.locator('.preview-zoom-value').innerText(), image = await preview.locator('.detail-media-stage img').getAttribute('src')
      await preview.getByRole('button', { name: '设为宝宝人脸参考', exact: true }).click()
      await page.waitForFunction(() => (window as any).__fixtures.calls.references.length === 1)
      await preview.getByRole('button', { name: '选择宝宝人脸', exact: true }).waitFor()
      if (matching === 'running') {
        await page.locator('.recognition-details-trigger').filter({ hasText: '匹配中…' }).waitFor()
        assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queries, '后台匹配未完成时只更新已明确保存的参考，不提前宣告整库索引已同步')
        await page.evaluate(() => { Object.assign((window as any).__fixtures.family.babyMatching[0], { state: 'done', processed: 3 }) })
      }
      await waitForIndexed(page, 3)
      await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 2', exact: true }).waitFor()
      await page.locator('.baby-result-filter').getByRole('button', { name: '疑似 1', exact: true }).waitFor()
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queries + 1, '参考产生新的匹配记录，需要有意义地更新完整结果，不仅修补参考卡片')
      assert.equal(await preview.locator('.detail-media-stage img').getAttribute('src'), image)
      assert.equal(await preview.locator('.preview-zoom-value').innerText(), zoom)
      assert.equal(await preview.locator('.detail-media-stage img').evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0), true)
      assert.equal(await preview.getByRole('button', { name: '放大', exact: true }).isDisabled(), false)
      assert.equal(await preview.locator('.face-selector,.face-box').count(), 0, '完成保存后恢复普通无脸标记预览')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [{ babyId: 'baby-one', assetId: await page.evaluate(() => (window as any).__fixtures.assets[0].id), faceId: 'new-baby-reference' }])
      await preview.getByRole('button', { name: '关闭预览', exact: true }).click()
      const included = page.locator('.media-card').filter({ has: page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }) })
      const candidate = page.locator('.media-card').filter({ has: page.getByRole('button', { name: '查看照片 photo-3.jpg', exact: true }) })
      assert.equal(await included.locator('.media-candidate').innerText(), '自动匹配')
      assert.equal(await candidate.locator('.media-candidate').innerText(), '疑似')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
      assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 3)
    } finally { await page.close() }
  }
})

test('外部版本自动刷新失败后保留旧图，不反复重试同一版本，明确手动刷新才继续', options, async () => {
  const page = await openPage({ count: 2 })
  try {
    await page.evaluate(() => { (window as any).__fixtures.assets[1].babyIds = ['baby-two'] })
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await waitForIndexed(page, 1)
    const queries = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.assets[1].babyIds = ['baby-one', 'baby-two']; fixtures.family.browseRevision = 'fixture-refresh-error'
      fixtures.queryFailures['library-one:all:1'] = 1
    })
    await page.getByRole('status').filter({ hasText: '模拟第 1 页加载失败' }).waitFor()
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 1)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).count(), 0)
    for (let poll = 0; poll < 2; poll++) await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), queries + 1, '同版本失败只提示一次，后续轮询不能形成自动重试循环')
    await page.getByRole('button', { name: '刷新列表', exact: true }).click()
    await waitForIndexed(page, 2)
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).waitFor()
    await page.locator('.baby-result-filter').getByRole('button', { name: '已加入 2', exact: true }).waitFor()
    const refreshed = await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length)
    assert.equal(refreshed, queries + 2, '手动刷新只重试一次并补齐新记录')
    await waitForFamilyPoll(page)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).length), refreshed)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('第二页追加途中排除首项，迟到旧页不能回填，重叠页继续补齐全部剩余照片', { ...options, timeout: 45000 }, async () => {
  const page = await openPage({ count: 101 })
  try {
    await waitForIndexed(page, 50)
    await page.evaluate(() => { (window as any).__fixtures.queryDelays['library-one:all:2'] = 1300 })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.some((query: any) => query.limit === 50 && query.page === 2))
    await scrollGallery(page, 'top')
    await clickMediaCardControl(page, '选择 photo-1.jpg')
    await page.locator('.selection-toolbar').getByRole('button', { name: '确认不是宝宝', exact: true }).click()
    await waitForIndexed(page, 49)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.limit === 50 && query.page === 2))
    await waitForIndexed(page, 49)
    assert.equal(await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).count(), 0)
    assert.equal(await page.locator('.selection-toolbar').count(), 0)
    assert.match(await page.locator('.media-load-more').innerText(), /已加载 49\s*\/\s*100 项/)
    const completedBefore = await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.queryDelays['library-one:all:2'] = 0
      return fixtures.calls.completedQueryItems.length
    })
    await page.locator('.media-load-more').scrollIntoViewIfNeeded()
    await waitForIndexed(page, 100)
    const loaded = await page.evaluate(previous => {
      const fixtures = (window as any).__fixtures
      const pages = fixtures.calls.completedQueryItems.slice(previous).filter((entry: any) => entry.query.limit === 50 && entry.query.babyId === 'baby-one')
      return { pages: pages.map((entry: any) => entry.query.page), ids: pages.flatMap((entry: any) => entry.ids), expected: fixtures.assets.slice(1).map((asset: any) => asset.id), removed: fixtures.assets[0].id, memberships: fixtures.calls.memberships }
    }, completedBefore)
    assert.deepEqual(loaded.pages, [1, 2], '分页位移从重叠页补读，不把旧第二页当作已经加载的新第二页')
    assert.deepEqual(new Set(loaded.ids), new Set(loaded.expected))
    assert.equal(new Set(loaded.ids).size, 100)
    assert.equal(loaded.ids.includes(loaded.removed), false)
    assert.deepEqual(loaded.memberships, [{ babyId: 'baby-one', ids: [loaded.removed], included: false }])
    await scrollGallery(page, 'bottom')
    await page.getByRole('button', { name: '查看照片 photo-101.jpg', exact: true }).waitFor()
    await assertVirtualIndex(page, 100)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 101)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('成长水印默认成长模板与单项导出 DTO 一致，兼容原有 watermark 页面', options, async () => {
  const page = await openPage({ page: 'watermark' })
  try {
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.length > 0)
    const preview = await page.evaluate(() => (window as any).__fixtures.calls.completedWatermarkPreviews.at(-1))
    assert.deepEqual({ babyId: preview.options.babyId, template: preview.options.template, growthMode: preview.options.growthMode, shade: preview.options.shade, showName: preview.options.showName, fontSize: preview.options.fontSize, position: preview.options.position }, { babyId: 'baby-one', template: 'growth', growthMode: 'auto', shade: true, showName: false, fontSize: 48, position: 'bottom-left' })
    assert.equal(preview.libraryId, 'library-one')
    assert.equal(await selectValue(selectControl(page, '水印内容')), 'auto')
    assert.equal(await selectValue(selectControl(page, '水印位置')), 'bottom-left')
    assert.equal(await page.getByLabel('显示宝宝昵称', { exact: true }).isVisible(), false, '字号、昵称等次要设置默认收起')
    await page.getByRole('button', { name: /导出/ }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.exports.length === 1)
    const exported = await page.evaluate(() => (window as any).__fixtures.calls.exports[0])
    assert.deepEqual(exported.ids, [preview.assetId])
    assert.deepEqual(exported.options, preview.options)
    assert.equal(exported.libraryId, 'library-one')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.scans ?? []), [])
  } finally { await page.close() }
})

test('成长水印内容模式互斥，自动月龄与总天数切换更新同一预览', options, async () => {
  const page = await openPage({ page: 'watermark' })
  try {
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.length > 0)
    const content = selectControl(page, '水印内容')
    assert.deepEqual(await selectOptions(page, content), ['auto', 'day-count'])
    await chooseSelect(page, content, 'day-count')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.at(-1)?.options.growthMode === 'day-count')
    let request = await page.evaluate(() => (window as any).__fixtures.calls.completedWatermarkPreviews.at(-1))
    assert.equal(request.options.template, 'growth')
    assert.equal(request.options.growthMode, 'day-count')
    assert.equal(request.options.showAge, false)
    assert.equal(request.options.showDayCount, true)
    assert.equal(await selectedOptionCount(page, content), 1)
    const previousPreview = await page.getByRole('img', { name: '成长水印预览', exact: true }).getAttribute('src')
    await page.evaluate(() => { (window as any).__fixtures.fail.push('watermarkPreview') })
    await chooseSelect(page, content, 'auto')
    await page.locator('.growth-preview-error').waitFor()
    assert.equal(await page.getByRole('img', { name: '成长水印预览', exact: true }).getAttribute('src'), previousPreview, '失败仍保留旧图供查看')
    assert.equal(await page.locator('.growth-export-button').isDisabled(), true, '最新参数预览失败时不能导出未展示的样式')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
    await page.evaluate(() => { const fixtures = (window as any).__fixtures; fixtures.fail = fixtures.fail.filter((operation: string) => operation !== 'watermarkPreview') })
    await page.getByRole('button', { name: '重试预览', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.at(-1)?.options.growthMode === 'auto')
    await page.waitForFunction(() => !(document.querySelector('.growth-export-button') as HTMLButtonElement).disabled)
    request = await page.evaluate(() => (window as any).__fixtures.calls.completedWatermarkPreviews.at(-1))
    assert.equal(request.options.growthMode, 'auto')
    assert.equal(request.options.showAge, true)
    assert.equal(request.options.showDayCount, false)
    assert.equal(await selectedOptionCount(page, content), 1)
    assert.equal(request.libraryId, 'library-one')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
  } finally { await page.close() }
})

test('成长水印从宝宝预览直接打开，取消、Escape 和遮罩仅关闭编辑且保留相册浏览状态', options, async () => {
  const page = await openPage({ count: 36 })
  try {
    await waitForIndexed(page, 36)
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 120; element.dispatchEvent(new Event('scroll')) })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    // 多选时封面用于切换选择，先正常预览，再通过真实选择事件构造需要保留的状态。
    await page.evaluate(() => { (document.querySelector('.media-select[aria-label="选择 photo-1.jpg"]') as HTMLButtonElement).click() })
    await page.locator('.selection-toolbar').waitFor({ state: 'attached' })
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
    const before = await page.evaluate(() => ({ scroll: document.querySelector('.page-content')?.scrollTop, queries: (window as any).__fixtures.calls.queries.length, page: (window as any).__testProps.page }))
    for (const method of ['cancel', 'escape', 'backdrop']) {
      const editor = await openGrowthWatermark(page)
      assert.equal(await page.locator('.media-dialog .preview-header-actions').getByRole('button', { name: '成长水印', exact: true }).count(), 1, '常用功能在大图工具栏直接可见')
      await selectControl(page, '水印内容').locator('.n-base-selection').focus()
      await page.keyboard.press('ArrowRight')
      assert.equal(await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).count(), 1, '编辑期间快捷键不能切换后面的照片')
      if (method === 'cancel') await editor.getByRole('button', { name: '取消', exact: true }).click()
      else if (method === 'escape') await page.keyboard.press('Escape')
      else await page.mouse.click(8, 90)
      await editor.waitFor({ state: 'hidden' })
      await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).waitFor()
      await page.waitForFunction(() => Boolean(document.querySelector('.media-dialog')?.contains(document.activeElement)))
      assert.match(await page.locator('.selection-toolbar').innerText(), /已选 1 项/)
      assert.equal(await page.evaluate(() => (window as any).__testProps.page), before.page)
    }
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.locator('.media-dialog').waitFor({ state: 'detached' })
    assert.equal(await page.locator('.page-content').evaluate(element => element.scrollTop), before.scroll)
    assert.equal(await page.getByRole('button', { name: '选择 photo-1.jpg', exact: true }).getAttribute('aria-pressed'), 'true')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.queries.length), before.queries, '编辑开关不能跳页或重新查询相册')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
  } finally { await page.close() }
})

test('成长水印多选显示文件名与跳过原因，仍导出有效照片并展示逐项失败', options, async () => {
  const page = await openPage({ count: 6, assetOverrides: [
    { index: 1, values: { dateConfirmed: false, dateSource: 'creation' } },
    { index: 2, values: { kind: 'video', filename: 'sample-video.mp4', duration: 3 } },
    { index: 3, values: { available: false } },
    { index: 5, values: { available: true, locations: [
      { id: 'offline-current', source: 'folder', label: '离线的当前库', path: '', libraryId: 'library-one', available: false },
      { id: 'online-other', source: 'folder', label: '可用的其他库', path: '', libraryId: 'library-two', available: true },
    ] } },
  ] })
  try {
    await waitForIndexed(page, 6)
    await openTools(page, '.gallery-tools')
    await page.getByRole('button', { name: '选择此页', exact: true }).click()
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 6 项/)
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures, asset = fixtures.assets[4]
      fixtures.watermarkExportResults[asset.id] = { assetId: asset.id, filename: asset.filename, error: '合成水印写入失败：目标目录不可写' }
    })
    await page.locator('.selection-toolbar').getByRole('button', { name: '成长水印', exact: true }).click()
    const editor = page.getByRole('dialog', { name: '成长水印', exact: true })
    await editor.waitFor()
    const problems = editor.locator('.growth-watermark-problems')
    assert.match(await problems.innerText(), /photo-2\.jpg/)
    assert.match(await problems.innerText(), /拍摄日期|确认.*日期/)
    assert.match(await problems.innerText(), /sample-video\.mp4/)
    assert.match(await problems.innerText(), /视频/)
    assert.match(await problems.innerText(), /photo-4\.jpg/)
    assert.match(await problems.innerText(), /不可用|连接.*硬盘/)
    assert.match(await problems.innerText(), /photo-6\.jpg/)
    assert.match(await problems.innerText(), /当前照片库原文件不可用/, '其他库的在线副本不能冒充当前库可用')
    await editor.getByRole('button', { name: /导出/ }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.exports.length === 1)
    const exported = await page.evaluate(() => { const fixtures = (window as any).__fixtures; return { request: fixtures.calls.exports[0], valid: [fixtures.assets[0].id, fixtures.assets[4].id] } })
    assert.deepEqual(exported.request.ids, exported.valid)
    assert.equal(exported.request.options.template, 'growth')
    assert.equal(exported.request.libraryId, 'library-one')
    await editor.getByText(/合成水印写入失败：目标目录不可写/).waitFor()
    assert.match(await editor.innerText(), /photo-5\.jpg/)
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    assert.match(await page.locator('.selection-toolbar').innerText(), /已选 6 项/)
    assert.equal(await page.evaluate(() => (window as any).__testProps.page), 'timeline')
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets.length), 6, '跳过与失败不能删除原媒体')
  } finally { await page.close() }
})

test('成长水印编辑关闭后重新打开另一张照片，旧预览迟到不覆盖新编辑会话', options, async () => {
  const page = await openPage()
  try {
    await page.evaluate(() => { (window as any).__fixtures.delays.watermarkPreview = 1200 })
    const firstEditor = await openGrowthWatermark(page)
    await page.waitForFunction(() => (window as any).__fixtures.calls.watermarkPreviews.length > 0)
    const firstAsset = await page.evaluate(() => (window as any).__fixtures.assets[0].id)
    await firstEditor.getByRole('button', { name: '取消', exact: true }).click()
    await firstEditor.waitFor({ state: 'hidden' })
    await page.evaluate(() => { (window as any).__fixtures.delays.watermarkPreview = 0 })
    await page.getByRole('button', { name: '下一项', exact: true }).click()
    await page.getByRole('dialog', { name: 'photo-2.jpg', exact: true }).waitFor()
    await waitForPreviewImage(page)
    const editor = await openGrowthWatermark(page, 'photo-2.jpg')
    await page.waitForFunction(() => {
      const fixtures = (window as any).__fixtures
      return fixtures.calls.completedWatermarkPreviews.some((request: any) => request.assetId === fixtures.assets[1].id)
    })
    const expected = await page.evaluate(() => { const fixtures = (window as any).__fixtures; return fixtures.watermarkPreviewUrls[`${fixtures.assets[1].id}:auto:bottom-left`] })
    await page.waitForFunction(url => document.querySelector('img[alt="成长水印预览"]')?.getAttribute('src') === url, expected)
    await page.waitForFunction(id => (window as any).__fixtures.calls.completedWatermarkPreviews.some((request: any) => request.assetId === id), firstAsset)
    assert.equal(await editor.getByRole('img', { name: '成长水印预览', exact: true }).getAttribute('src'), expected)
    assert.equal(await page.getByRole('dialog', { name: 'photo-2.jpg', exact: true }).count(), 1)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
  } finally { await page.close() }
})

test('成长水印内容与位置连续调整时迟到预览不覆盖最新模式', options, async () => {
  const page = await openPage({ page: 'watermark' })
  try {
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.length > 0)
    await page.evaluate(() => { (window as any).__fixtures.delays.watermarkPreview = 1300 })
    await chooseSelect(page, selectControl(page, '水印位置'), 'top-right')
    await page.waitForFunction(() => (window as any).__fixtures.calls.watermarkPreviews.some((request: any) => request.options.position === 'top-right' && request.options.growthMode === 'auto'))
    await page.evaluate(() => { (window as any).__fixtures.delays.watermarkPreview = 0 })
    await chooseSelect(page, selectControl(page, '水印内容'), 'day-count')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.some((request: any) => request.options.position === 'top-right' && request.options.growthMode === 'day-count'))
    const expected = await page.evaluate(() => { const fixtures = (window as any).__fixtures; return fixtures.watermarkPreviewUrls[`${fixtures.assets[0].id}:day-count:top-right`] })
    await page.waitForFunction(url => document.querySelector('img[alt="成长水印预览"]')?.getAttribute('src') === url, expected)
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.some((request: any) => request.options.position === 'top-right' && request.options.growthMode === 'auto'))
    assert.equal(await page.getByRole('img', { name: '成长水印预览', exact: true }).getAttribute('src'), expected)
    assert.equal(await selectValue(selectControl(page, '水印内容')), 'day-count')
    assert.equal(await selectValue(selectControl(page, '水印位置')), 'top-right')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
  } finally { await page.close() }
})

test('成长水印可从全屏照片打开，退出全屏后取消仍返回原照片预览', options, async () => {
  const page = await openPage()
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    await page.getByRole('button', { name: '全屏预览', exact: true }).click()
    await page.waitForFunction(() => document.fullscreenElement?.classList.contains('media-dialog'))
    const editor = await openGrowthWatermark(page)
    assert.equal(await editor.isVisible(), true)
    assert.equal(await page.evaluate(() => document.fullscreenElement === null), true, '独立编辑弹层不能留在预览全屏元素之外')
    await editor.getByRole('button', { name: '取消', exact: true }).click()
    await editor.waitFor({ state: 'hidden' })
    assert.equal(await page.getByRole('dialog', { name: 'photo-1.jpg', exact: true }).count(), 1)
    await waitForPreviewImage(page)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.exports), [])
  } finally { await page.close() }
})

test('中文日历内部选择不误关筛选，清空恢复无日期条件，Escape逐层回到入口', options, async () => {
  const page = await openPage({ module: 'library', page: 'all' })
  try {
    await openTools(page, '.advanced-filters')
    const filters = page.locator('.advanced-filters'), from = page.getByLabel('从', { exact: true })
    await fillDate(from, '2024-03-01')
    await from.click()
    const calendar = page.locator('.n-date-panel--date:visible')
    await calendar.waitFor()
    assert.match(await calendar.locator('.n-date-panel-month__text').innerText(), /2024.*3月/)
    assert.match(await calendar.locator('.n-date-panel-weekdays').innerText(), /一.*二.*三.*四.*五.*六.*日/s)
    await calendar.locator('.n-date-panel-date:not(.n-date-panel-date--excluded)').filter({ hasText: /^12$/ }).click()
    assert.equal(await filters.getAttribute('data-open'), 'true', '点击子日历只更新日期，不算外部点击')
    assert.equal(await from.inputValue(), '2024-03-12')
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedQueries.some((query: any) => query.from === '2024-03-12'))
    await from.click(); await calendar.waitFor()
    await page.keyboard.press('Escape')
    await calendar.waitFor({ state: 'hidden' })
    assert.equal(await filters.getAttribute('data-open'), 'true', '第一次Escape只收起日历')
    assert.equal(await from.evaluate(input => input === document.activeElement), true)
    await fillDate(from, '')
    await page.waitForFunction(() => !(window as any).__fixtures.calls.completedQueries.filter((query: any) => query.limit === 50).at(-1).from)
    assert.equal(await from.inputValue(), '')
    await page.keyboard.press('Escape')
    assert.equal(await filters.getAttribute('data-open'), 'false')
    assert.equal(await filters.locator('button[aria-expanded]').evaluate(button => button === document.activeElement), true)
  } finally { await page.close() }
})

test('出生日期支持键盘输入年份，合法闰日保留年月日，空值与越界日期不能保存档案', options, async () => {
  const page = await openPage()
  try {
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '宝宝档案', exact: true }), birthday = dialog.getByLabel('出生日期', { exact: true })
    await dialog.waitFor()
    assert.equal(await birthday.getAttribute('type'), 'text', '日期交互使用组件日历')
    await birthday.focus(); await birthday.press('Control+A'); await birthday.pressSequentially('2020-02-29'); await birthday.press('Tab')
    assert.equal(await birthday.inputValue(), '2020-02-29', JSON.stringify(await birthday.evaluate(input => ({ value: (input as HTMLInputElement).value, model: input.closest('.ui-date-picker')?.getAttribute('data-value'), error: (input as HTMLInputElement).validationMessage, valid: (input as HTMLInputElement).checkValidity(), active: document.activeElement?.outerHTML }))))
    assert.equal(await birthday.evaluate(input => (input as HTMLInputElement).checkValidity()), true)
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0, '调整年份只更新草稿')
    const future = await page.evaluate(() => `${new Date().getFullYear() + 1}-01-01`)
    for (const value of ['1899-12-31', future, '2024-02-30', '']) {
      await fillDate(birthday, value)
      assert.equal(await birthday.evaluate(input => (input as HTMLInputElement).checkValidity()), false, `${value || '空日期'} 必须阻止保存`)
      await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
      assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts.length), 0)
      assert.equal(await dialog.isVisible(), true)
      await fillDate(birthday, '2020-02-29')
    }
    await fillDate(birthday, '1900-01-01')
    assert.equal(await birthday.evaluate(input => (input as HTMLInputElement).checkValidity()), true, '出生日期下限可选')
    const today = await page.evaluate(() => new Date().toLocaleDateString('sv-SE'))
    await fillDate(birthday, today)
    assert.equal(await birthday.evaluate(input => (input as HTMLInputElement).checkValidity()), true, '今天作为上限可选')
    await fillDate(birthday, '2020-02-29')
    await dialog.getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await dialog.waitFor({ state: 'hidden' })
    assert.equal(await page.evaluate(() => (window as any).__fixtures.calls.saved[0].birthday), '2020-02-29', '保存本地年月日，不经UTC转换')
  } finally { await page.close() }
})

test('档案与预览中的日期日历可获得焦点，Escape先关日历再关闭父层', options, async () => {
  const page = await openPage()
  try {
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    const profile = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await profile.getByLabel('出生日期', { exact: true }).click()
    const calendar = page.locator('.n-date-panel--date:visible')
    await calendar.waitFor(); await calendar.focus()
    assert.equal(await calendar.evaluate(panel => panel === document.activeElement), true, `模态焦点限制允许操作所属日历：${JSON.stringify(await calendar.evaluate(panel => ({ parent: panel.closest('.n-modal')?.className, active: document.activeElement?.outerHTML, calendar: panel.outerHTML.slice(0, 300) })))}`)
    await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
    assert.equal(await profile.isVisible(), true)
    await page.keyboard.press('Escape'); await profile.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    await preview.getByLabel('确认或修正实际拍摄日期', { exact: true }).click()
    await calendar.waitFor(); await calendar.focus()
    assert.equal(await calendar.evaluate(panel => Boolean(panel.closest('.media-dialog'))), true, '日历留在预览与全屏的同一元素内')
    assert.equal(await calendar.evaluate(panel => panel === document.activeElement), true)
    await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
    assert.equal(await preview.locator('.detail-metadata').count(), 1)
    await page.keyboard.press('Escape')
    assert.equal(await preview.locator('.detail-metadata').count(), 0)
    assert.equal(await preview.isVisible(), true)
    await page.keyboard.press('Escape'); await preview.waitFor({ state: 'hidden' })
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.saved), [])
  } finally { await page.close() }
})

test('实际拍摄日期非法或未来输入不提交旧日期，修正后才明确保存当前年月日', options, async () => {
  const page = await openPage({ module: 'library', page: 'all', dateConfirmed: false })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    const date = preview.getByLabel('确认或修正实际拍摄日期', { exact: true }), save = preview.getByRole('button', { name: '保存确认日期', exact: true })
    const future = await page.evaluate(() => `${new Date().getFullYear() + 1}-01-01`)
    for (const text of ['2024-02-30', '2024-13-01', future, '']) {
      await fillDate(date, text)
      assert.equal(await date.inputValue(), text, '错误输入保留供修正，不能悄悄回退旧日期')
      assert.equal(await save.isDisabled(), true, `${text || '空日期'} 不允许保存确认日期`)
      await date.press('Enter')
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.dateAttempts), [], '非法输入和键盘确认都不能调用setMediaDate')
      assert.equal(await page.evaluate(() => (window as any).__fixtures.assets[0].dateConfirmed), false)
      assert.equal(await page.evaluate(() => (window as any).__fixtures.assets[0].date), '2024-03-10')
      assert.match(await preview.locator('.detail-metadata').innerText(), /2024-03-10 · 文件创建日期/)
      assert.doesNotMatch(await preview.locator('.detail-metadata').innerText(), /手动确认日期/)
    }
    await fillDate(date, '2024-03-12')
    assert.equal(await save.isEnabled(), true)
    await save.click()
    await page.waitForFunction(() => (window as any).__fixtures.assets[0].dateConfirmed)
    const expectedId = await page.evaluate(() => (window as any).__fixtures.assets[0].id)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.dateAttempts), [{ id: expectedId, date: '2024-03-12' }])
    assert.equal(await page.evaluate(() => (window as any).__fixtures.assets[0].date), '2024-03-12')
  } finally { await page.close() }
})

test('日期日历点击外部只收起子层，保留筛选、档案草稿与预览信息', options, async () => {
  const page = await openPage()
  try {
    const calendar = page.locator('.n-date-panel--date:visible')
    await openTools(page, '.advanced-filters')
    await page.getByLabel('从', { exact: true }).click()
    await calendar.waitFor()
    await clickOutsideCalendar(page, page.locator('.ui-popover-content[aria-label="更多筛选"]'))
    await calendar.waitFor({ state: 'hidden' })
    assert.equal(await page.locator('.advanced-filters').getAttribute('data-open'), 'true', '外点日历时保留所属筛选面板')
    await page.keyboard.press('Escape')
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    const profile = page.getByRole('dialog', { name: '宝宝档案', exact: true })
    await profile.getByLabel('宝宝昵称', { exact: true }).fill('保留日期外点草稿')
    await profile.getByLabel('出生日期', { exact: true }).click()
    await calendar.waitFor()
    await clickOutsideCalendar(page, profile.locator('.baby-profile-footer'))
    await calendar.waitFor({ state: 'hidden' })
    assert.equal(await profile.isVisible(), true)
    assert.equal(await profile.getByLabel('宝宝昵称', { exact: true }).inputValue(), '保留日期外点草稿')
    await profile.getByRole('button', { name: '关闭宝宝档案', exact: true }).click()
    await profile.waitFor({ state: 'hidden' })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-1.jpg', exact: true })
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    await preview.getByLabel('确认或修正实际拍摄日期', { exact: true }).click()
    await calendar.waitFor()
    await clickOutsideCalendar(page, preview.locator('.preview-information-body'))
    await calendar.waitFor({ state: 'hidden' })
    assert.equal(await preview.isVisible(), true)
    assert.equal(await preview.locator('.detail-metadata').isVisible(), true, '点击信息面板内部只关闭所属日历')
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.dateAttempts), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.saveAttempts), [])
  } finally { await page.close() }
})

test('预览日历与宝宝下拉获得焦点时左右箭头只交给控件，不切换当前照片', options, async () => {
  const page = await openPage({ page: 'references', count: 3 })
  try {
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const preview = page.getByRole('dialog', { name: 'photo-2.jpg', exact: true }), image = preview.locator('.detail-media-stage img')
    const source = await image.getAttribute('src')
    assert.equal(await preview.getByRole('button', { name: '上一项', exact: true }).isEnabled(), true)
    assert.equal(await preview.getByRole('button', { name: '下一项', exact: true }).isEnabled(), true)
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    await preview.getByLabel('确认或修正实际拍摄日期', { exact: true }).click()
    const calendar = page.locator('.n-date-panel--date:visible')
    await calendar.waitFor(); await calendar.focus()
    assert.equal(await calendar.evaluate(panel => panel === document.activeElement), true)
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key)
      assert.equal(await preview.isVisible(), true)
      assert.equal(await page.locator('.preview-heading h2').innerText(), 'photo-2.jpg')
      assert.equal(await image.getAttribute('src'), source)
    }
    await page.keyboard.press('Escape'); await calendar.waitFor({ state: 'hidden' })
    await preview.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    await preview.locator('.face-selector button').first().click()
    const babyControl = selectControl(page, '此人脸对应的宝宝')
    await babyControl.getByRole('combobox').click()
    const menu = page.locator('.n-base-select-menu:visible')
    await menu.waitFor(); await menu.focus()
    assert.equal(await menu.evaluate(element => element === document.activeElement), true)
    assert.equal(await menu.evaluate(element => Boolean(element.closest('.media-dialog'))), true)
    for (const key of ['ArrowLeft', 'ArrowRight']) {
      await page.keyboard.press(key)
      assert.equal(await preview.isVisible(), true)
      assert.equal(await page.locator('.preview-heading h2').innerText(), 'photo-2.jpg')
      assert.equal(await image.getAttribute('src'), source)
    }
    await page.keyboard.press('Escape'); await menu.waitFor({ state: 'hidden' })
    assert.equal(await preview.isVisible(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.references), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.dateAttempts), [])
  } finally { await page.close() }
})

test('重建人脸索引入口先展示当前库与备份说明，打开确认不调用重建', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3 })
  try {
    await page.getByRole('button', { name: '重建人脸索引', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重建人脸索引', exact: true })
    await dialog.waitFor()
    assert.match(await dialog.innerText(), /当前照片库：合成归档/)
    assert.match(await dialog.innerText(), /先备份.*清理旧人脸.*自动人物分组/)
    assert.match(await dialog.innerText(), /原文件.*宝宝档案.*人工相册记录保留/)
    assert.equal(await dialog.getByRole('button', { name: '备份并重建', exact: true }).isEnabled(), true)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.rebuilds), [])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('重建确认可用 Escape 或取消关闭，切页和切库也关闭且不调用重建', options, async () => {
  for (const action of ['escape', 'cancel', 'page', 'library'] as const) {
    const page = await openPage({ module: 'library', page: 'people', count: 3 })
    try {
      await page.getByRole('button', { name: '重建人脸索引', exact: true }).click()
      const dialog = page.getByRole('dialog', { name: '重建人脸索引', exact: true })
      await dialog.waitFor()
      if (action === 'escape') await page.keyboard.press('Escape')
      else if (action === 'cancel') await dialog.getByRole('button', { name: '取消', exact: true }).click()
      else if (action === 'page') await page.evaluate(() => { (window as any).__testProps.page = 'favorites' })
      else await page.evaluate(() => {
        const props = (window as any).__testProps
        props.receiver.libraries.push({ id: 'library-two', name: '新的合成照片库', path: '合成目录二', enabled: true })
        props.receiver.currentLibraryId = 'library-two'
      })
      await dialog.waitFor({ state: 'hidden' })
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.rebuilds), [], `${action} 只关闭待确认操作`)
      assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
    } finally { await page.close() }
  }
})

test('确认重建只调用当前库一次，随后查询不沿用旧人物筛选', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3 })
  try {
    await page.getByRole('button', { name: '更多筛选', exact: true }).click()
    await chooseSelect(page, selectControl(page, '人物'), 'person-one')
    await page.waitForFunction(() => (window as any).__fixtures.calls.queries.filter((query: any) => query.limit === 50).at(-1)?.personId === 'person-one')
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: '← 全部人物', exact: true }).click()
    await page.getByRole('button', { name: '重建人脸索引', exact: true }).waitFor()
    await page.getByRole('button', { name: '重建人脸索引', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: '重建人脸索引', exact: true })
    await dialog.waitFor()
    const previousQueries = await page.evaluate(() => (window as any).__fixtures.calls.queries.length)
    await page.evaluate(() => { (window as any).__fixtures.delays.rebuild = 80 })
    await dialog.getByRole('button', { name: '备份并重建', exact: true }).evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click() })
    await dialog.waitFor({ state: 'hidden' })
    await page.waitForFunction(count => (window as any).__fixtures.calls.queries.slice(count).some((query: any) => query.limit === 50), previousQueries)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.rebuilds), [{ libraryId: 'library-one' }])
    const queries = await page.evaluate(count => (window as any).__fixtures.calls.queries.slice(count).filter((query: any) => query.limit === 50), previousQueries)
    assert.ok(queries.length > 0)
    assert.ok(queries.every((query: any) => query.libraryId === 'library-one' && query.personId === undefined && !query.ungroupedFaces))
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [])
  } finally { await page.close() }
})

test('人物分析运行期间禁用重建入口，点击禁用按钮不调用重建', options, async () => {
  const page = await openPage({ module: 'library', page: 'people', count: 3, jobs: [{ id: 'faces-running', libraryId: 'library-one', kind: 'faces', state: 'running', processed: 0, total: 3, label: '合成人脸分析', error: '' }] })
  try {
    const rebuild = page.getByRole('button', { name: '重建人脸索引', exact: true })
    await rebuild.waitFor()
    assert.equal(await rebuild.isDisabled(), true)
    await rebuild.evaluate(button => (button as HTMLButtonElement).click())
    assert.equal(await page.getByRole('dialog', { name: '重建人脸索引', exact: true }).count(), 0)
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.rebuilds), [])
  } finally { await page.close() }
})

test('宝宝重建中断时显示继续入口和旧结果标记，人工确认保留其他旧结果且不触发重新清空', options, async () => {
  const page = await openPage({ autoMatch: true, faceRebuilds: [{ libraryId: 'library-one', libraryName: '合成归档', phase: 'detecting', state: 'interrupted', processed: 1, total: 2, failed: 0, snapshotAvailable: true }], assetOverrides: [0, 1].map(index => ({ index, values: { babyIds: [], babyDecisions: [{ id: `previous-${index}`, babyId: 'baby-one', state: 'included', origin: 'recognition', rebuildPending: true }] } })) })
  try {
    const notice = page.locator('.face-rebuild-notice')
    await notice.waitFor(); assert.match(await notice.innerText(), /人脸重建已中断.*已处理 1 \/ 2/s)
    await page.locator('.media-card').first().waitFor()
    assert.deepEqual(await page.locator('.media-candidate').allTextContents(), ['重扫前结果', '重扫前结果'])
    assert.equal(await page.locator('.growth-watermark-stamp').count(), 0)
    assert.equal(await page.getByRole('button', { name: '重新匹配', exact: true }).isDisabled(), true)
    await page.getByRole('button', { name: '已加入 2', exact: true }).click()
    await page.locator('.media-cover').first().click()
    await page.getByRole('button', { name: '是宝宝', exact: true }).click()
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    assert.equal(await page.locator('.media-card').count(), 2, '确认一张后另一张旧结果仍可浏览')
    assert.ok((await page.locator('.media-candidate').allTextContents()).includes('人工确认'))
    assert.ok((await page.locator('.media-candidate').allTextContents()).includes('重扫前结果'))
    await notice.getByRole('button', { name: '继续重建', exact: true }).click()
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.analyses), [{ libraryId: 'library-one', retryOnlyFailed: undefined }])
    assert.deepEqual(await page.evaluate(() => (window as any).__fixtures.calls.rebuilds), [])
    assert.equal(await page.getByRole('dialog', { name: '重建人脸索引' }).count(), 0)
  } finally { await page.close() }
})

test('宝宝人脸重建运行中显示真实阶段，完成后刷新结果及水印且不误报匹配完成', options, async () => {
  const page = await openPage({ autoMatch: true, faceRebuilds: [{ libraryId: 'library-one', libraryName: '合成归档', phase: 'grouping', state: 'running', processed: 2, total: 2, failed: 0, snapshotAvailable: true }], jobs: [{ id: 'rebuild-job', libraryId: 'library-one', kind: 'faces', state: 'running', processed: 2, total: 2, label: '重新归组人物', error: '' }] })
  try {
    await page.locator('.face-rebuild-notice').waitFor()
    assert.match(await page.locator('.face-rebuild-notice').innerText(), /正在整理人物和宝宝结果/)
    assert.equal(await page.getByRole('button', { name: '继续重建', exact: true }).count(), 0)
    assert.equal(await page.locator('.baby-recognition-status').count(), 0)
    await page.evaluate(() => {
      const f = (window as any).__fixtures
      f.family.faceRebuilds = []; f.family.jobs[0].state = 'done'; f.family.browseRevision = 'rebuild-complete'
      f.assets[1].babyIds = []; f.assets[1].candidateBabyIds = ['baby-one']
    })
    await page.waitForFunction(() => !document.querySelector('.face-rebuild-notice'))
    await page.waitForFunction(() => [...document.querySelectorAll('.media-candidate')].some(element => element.textContent === '疑似'))
    assert.equal(await page.locator('.media-card').count(), 2)
    assert.equal(await page.locator('.growth-watermark-stamp').count(), 1)
    assert.equal(await page.getByRole('button', { name: '重新匹配', exact: true }).isDisabled(), false)
    assert.ok(!(await page.locator('.family-workspace').innerText()).includes('匹配完成：'))
  } finally { await page.close() }
})

test('自动成长水印全局开关统一控制缩略图和原图预览，切图重开与刷新保留设置', options, async () => {
  const page = await openPage({ count: 2 })
  try {
    await waitForIndexed(page, 2)
    const toggle = page.getByRole('switch', { name: '自动显示成长水印', exact: true })
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await page.locator('.media-card .growth-watermark-stamp').first().waitFor()
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 2)
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const stamp = page.locator('.detail-media-stage .growth-watermark-stamp')
    assert.equal(await stamp.count(), 1)
    const previewToggle = page.getByRole('switch', { name: '预览显示成长水印', exact: true })
    assert.equal(await previewToggle.getAttribute('aria-checked'), 'true')
    assert.deepEqual(await page.locator('.detail-media-stage img').evaluate(image => {
      const fixtures = (window as any).__fixtures, id = fixtures.assets[0].id
      return { original: (image as HTMLImageElement).src === fixtures.rawUrls[id], thumbnail: (image as HTMLImageElement).src === fixtures.thumbUrls[id] }
    }), { original: true, thumbnail: false })
    assert.equal(await stamp.locator('strong').innerText(), '1 个月 10 天')
    assert.equal(await stamp.locator('small').innerText(), '2024 · 03 · 10')
    await previewToggle.click()
    assert.equal(await stamp.count(), 0)
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 0)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await page.getByRole('button', { name: '下一项', exact: true }).click()
    await waitForPreviewImage(page)
    assert.equal(await stamp.count(), 0)
    assert.equal(await previewToggle.getAttribute('aria-checked'), 'false')
    await previewToggle.click()
    await stamp.waitFor()
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 2)
    await page.getByRole('button', { name: '关闭预览', exact: true }).click()
    await page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    assert.equal(await stamp.count(), 1)
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await previewToggle.click()
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForIndexed(page, 2)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    assert.equal(await previewToggle.getAttribute('aria-checked'), 'false')
    assert.equal(await stamp.count(), 0)
    assert.deepEqual(await page.evaluate(() => ({ previews: (window as any).__fixtures.calls.watermarkPreviews, exports: (window as any).__fixtures.calls.exports })), { previews: [], exports: [] })
  } finally { await page.close() }
})

test('自动成长水印按宝宝记住开关，切换宝宝和刷新不会串用偏好', options, async () => {
  const today = new Date().toLocaleDateString('sv-SE')
  const page = await openPage({ count: 1, dates: [today] })
  try {
    await waitForIndexed(page, 1)
    const toggle = page.getByRole('switch', { name: '自动显示成长水印', exact: true })
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await waitForIndexed(page, 1)
    assert.equal(await toggle.getAttribute('aria-checked'), 'true')
    await page.locator('.media-card .growth-watermark-stamp').waitFor()
    assert.equal(await page.locator('.media-card .growth-watermark-stamp strong').innerText(), '出生第 1 天')
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-one')
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await page.reload({ waitUntil: 'domcontentloaded' })
    await waitForIndexed(page, 1)
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 0)
  } finally { await page.close() }
})

test('自动成长水印不展示视频、创建日期和出生前照片的确定年龄', options, async () => {
  const page = await openPage({ count: 4, assetOverrides: [
    { index: 1, values: { dateSource: 'creation', dateConfirmed: false } },
    { index: 2, values: { date: '2023-12-31' } },
    { index: 3, values: { kind: 'video', filename: 'video.mp4' } },
  ] })
  try {
    await waitForIndexed(page, 4)
    await page.locator('.media-card .growth-watermark-stamp').waitFor()
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 1)
    const uncertain = page.getByRole('button', { name: '查看照片 photo-2.jpg', exact: true })
    assert.equal(await uncertain.locator('.growth-watermark-stamp').count(), 0)
    await uncertain.click()
    await waitForPreviewImage(page)
    assert.equal(await page.locator('.detail-media-stage .growth-watermark-stamp').count(), 0)
  } finally { await page.close() }
})

test('自动成长水印跟随图片缩放旋转，选脸时隐藏且退出后恢复', options, async () => {
  const page = await openPage({ count: 1 })
  try {
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const stage = page.locator('.detail-media-stage'), stamp = stage.locator('.growth-watermark-stamp')
    await stamp.waitFor()
    const before = await stamp.boundingBox()
    await page.getByRole('button', { name: '放大', exact: true }).click()
    const enlarged = await stamp.boundingBox()
    assert.ok(enlarged!.width > before!.width)
    assert.equal(await stamp.evaluate(element => getComputedStyle(element).pointerEvents), 'none')
    await page.getByRole('button', { name: '向右旋转', exact: true }).click()
    assert.match(await stage.getAttribute('style') ?? '', /rotate\(90deg\)/)
    await page.getByRole('button', { name: '选择宝宝人脸', exact: true }).click()
    assert.equal(await stamp.count(), 0)
    await page.locator('.face-layer').waitFor()
    await page.getByRole('button', { name: '退出选脸', exact: true }).click()
    await stamp.waitFor()
    await page.getByRole('button', { name: '成长水印', exact: true }).click()
    await page.locator('.growth-watermark-editor').waitFor()
    await page.waitForFunction(() => (window as any).__fixtures.calls.completedWatermarkPreviews.length > 0)
    await page.getByRole('button', { name: '导出水印副本', exact: true }).click()
    await page.waitForFunction(() => (window as any).__fixtures.calls.exports.length === 1)
  } finally { await page.close() }
})

test('自动成长水印存储写入失败时切换宝宝仍保留本次显示偏好', options, async () => {
  const page = await openPage({ count: 1 })
  try {
    await waitForIndexed(page, 1)
    await page.evaluate(() => {
      localStorage.setItem('jinchuan.growth-display.v1.baby-one', 'on')
      Storage.prototype.setItem = () => { throw new DOMException('合成存储配额失败', 'QuotaExceededError') }
    })
    const toggle = page.getByRole('switch', { name: '自动显示成长水印', exact: true })
    await toggle.click()
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-two')
    await chooseSelect(page, selectControl(page, '当前宝宝'), 'baby-one')
    assert.equal(await toggle.getAttribute('aria-checked'), 'false')
    assert.equal(await page.locator('.media-card .growth-watermark-stamp').count(), 0)
  } finally { await page.close() }
})

test('自动成长水印按照片短边缩放，全景大图仍完整显示两行文字', options, async () => {
  const page = await openPage({ count: 1 })
  try {
    await page.evaluate(() => {
      const fixtures = (window as any).__fixtures
      fixtures.previewUrls[fixtures.assets[0].id] = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="100"><rect width="1000" height="100" fill="#798876"/></svg>')}`
    })
    await page.getByRole('button', { name: '查看照片 photo-1.jpg', exact: true }).click()
    await waitForPreviewImage(page)
    const stage = await page.locator('.detail-media-stage').boundingBox()
    for (const line of ['strong', 'small']) {
      const bounds = await page.locator(`.detail-media-stage .growth-watermark-stamp ${line}`).boundingBox()
      assert.ok(bounds!.y >= stage!.y && bounds!.y + bounds!.height <= stage!.y + stage!.height, `${line} 不被全景照片边界裁切`)
    }
  } finally { await page.close() }
})
