import { existsSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { chromium } from 'playwright'

const projectRoot = fileURLToPath(new URL('../', import.meta.url))
const rendererRoot = resolve(projectRoot, process.argv.includes('--baseline') ? '.cache/layout-verification/baseline-source' : 'apps/desktop/src/renderer')
const artifactDirectory = resolve(projectRoot, '.cache/layout-verification')
const baseline = process.argv.includes('--baseline')
const label = baseline ? 'baseline' : 'current'
const executable = [process.env.JINCHUAN_TEST_BROWSER, chromium.executablePath(), 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(path => path && existsSync(path))
if (!executable) throw new Error('未找到本地 Edge、Chrome 或 Playwright 浏览器；未安装新软件。')
const report = { checkedAt: new Date().toISOString(), label, browser: executable, checks: [], failures: [], errors: [], screenshots: [] }
let server, browser

/** 只提供合成相册和接口，不连接当前运行的桌面程序或真实照片目录。 */
function installFixtures(options = {}) {
  const assetId = index => `${index.toString(16).padStart(64, '0')}-1024`
  const longPath = `C:/合成测试/家庭相册/${'很长的家庭照片文件夹名称/'.repeat(9)}`
  const name = '宝宝的很长昵称用于验证布局和自动换行'
  const fixtures = {
    assets: Array.from({ length: options.assetCount ?? 52 }, (_, index) => ({ id: assetId(index + 1), hash: (index + 1).toString(16).padStart(64, '0'), size: 1024,
      filename: index === 0 ? 'portrait-3x4.jpg' : `合成${index % 5 === 0 ? '视频' : '照片'}_${index + 1}_${'very-long-filename-'.repeat(8)}.${index % 5 === 0 ? 'mp4' : 'jpg'}`,
      kind: index && index % 5 === 0 ? 'video' : 'photo', date: '2026-06-15', dateSource: 'capture', dateConfirmed: true, captureDate: '2026-06-15', creationDate: '2026-06-16',
      width: index === 0 ? 300 : 480, height: index === 0 ? 400 : 320, duration: index % 5 === 0 ? 72 : 0, available: true,
      locations: [{ id: `location-${index}`, source: index % 3 === 0 ? 'phone' : 'folder', label: '合成位置', path: `${longPath}photo-${index}.jpg`, available: true, libraryId: 'library-one' }],
      babyIds: ['baby-one'], personIds: ['person-one'], favorite: true,
      faces: [{ id: `face-${index}`, x: .2, y: .2, width: .3, height: .35, score: .95, personId: 'person-one', personName: '宝宝' }], faceState: 'done' })),
    family: { photoCount: 42, videoCount: 10, babies: [{ id: 'baby-one', name, birthday: '2025-01-31', autoMatch: true, referenceFaces: [{ assetId: assetId(1), faceId: 'face-0' }], updatedAt: '2026-10-01T00:00:00Z' }],
      people: [{ id: 'person-one', name: '家人的很长名字用于验证下拉列表显示', faceCount: 52, assetCount: 52, reference: { assetId: assetId(1), kind: 'photo', face: { id: 'face-0', x: .2, y: .2, width: .3, height: .35, score: .95 } } }],
      jobs: Array.from({ length: 25 }, (_, index) => ({ id: `job-${index}`, kind: index === 24 ? 'faces' : 'import', state: index === 24 ? 'running' : 'done', processed: index === 24 ? 12 : 52, total: 52, label: `合成任务 ${index + 1} · ${index % 4 === 0 ? longPath : '本地处理完成'}`, error: '' })),
      modelReady: true, modelError: '', candidateCount: 0, importPlans: [], analysis: { pending: 0, done: 52, error: 0, faceCount: 52, noFaces: 2, supplementPending: 2 } },
    receiver: { receiverId: 'synthetic', name: '合成测试接收电脑', port: 0, addresses: ['192.168.0.2'], accepting: false, scanning: false, savedCount: 52, currentLibraryId: 'library-one', currentLibraryAvailable: true,
      libraries: [{ id: 'library-one', name: '合成归档', path: `${longPath}归档目标`, enabled: true }], roots: [{ id: 'root-one', path: `${longPath}来源`, enabled: true, state: 'ready', count: 52, error: '', scannedAt: '2026-10-01T00:00:00Z' }],
      devices: [], sessions: [], files: [] }, calls: [], decisions: [], mediaUrlCalls: [] }
  fixtures.receiver.libraries.push({ id: 'library-two', name: '另一个图库', path: 'C:/合成测试/其他图库', enabled: true })
  // 多个长保存位置用于验证信息仅在侧栏滚动，不把大图和关闭按钮带走。
  fixtures.assets[1].locations.push(...Array.from({ length: 4 }, (_, index) => ({ ...fixtures.assets[1].locations[0], id: `preview-location-${index}`, path: `${longPath}另一个保留副本-${index}/photo-1.jpg` })))
  // 宝宝头像可使用尚未分析人脸的普通照片，不能以选脸结果限制选图。
  fixtures.assets[2].faces = []; fixtures.assets[2].faceState = 'pending'
  fixtures.assets.forEach((asset, index) => {
    asset.date = options.assetCount ? index < 38 ? '2026-01-15' : index < 175 ? '2024-08-15' : index < 369 ? '2024-07-15' : index < 420 ? '2024-06-15' : '2024-05-15' : index < 24 ? '2026-10-01' : index < 50 ? '2026-09-15' : '2026-08-15'
    asset.captureDate = asset.date
    const state = index < 45 ? 'included' : index < 50 ? 'candidate' : 'excluded'
    fixtures.decisions.push({ id: `baby-one:${asset.id}`, babyId: 'baby-one', assetId: asset.id, state, origin: index < 51 ? 'recognition' : 'manual', updatedAt: '2026-10-01T00:00:00Z' })
    if (state !== 'included') asset.babyIds = []
  })
  fixtures.family.candidateCount = 5
  if (!options.assetCount) { fixtures.assets[50].faces = []; fixtures.assets[50].faceState = 'done'; fixtures.assets[50].kind = 'photo' }
  fixtures.family.jobs.unshift({ id: 'scan-interrupted-job', libraryId: 'library-one', kind: 'scan', scanPurpose: 'library', state: 'error', processed: 27, total: 27, label: '合成扫描中断', error: '上次任务被中断，请重新执行。' })
  fixtures.assets.push({ ...structuredClone(fixtures.assets[0]), id: assetId(options.assetCount ? options.assetCount + 1 : 999), filename: '仅属于其他图库.jpg', locations: [{ id: 'other-location', source: 'folder', label: '另一个图库', path: 'C:/合成测试/其他图库/other.jpg', available: true, libraryId: 'library-two' }] })
  const clone = value => structuredClone(value)
  const image = (asset, thumbnail = false) => {
    const width = asset?.width ?? 480, height = asset?.height ?? 320
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><rect width="${width}" height="${height}" fill="${asset?.kind === 'video' ? '#b6d4cd' : '#e5d4b3'}"/><rect x="${width * .2}" y="${height * .2}" width="${width * .3}" height="${height * .35}" fill="#c89c6d"/><circle cx="${width * .35}" cy="${height * .34}" r="${width * .07}" fill="#f5e4c2"/><text x="12" y="${height - 18}" font-size="14" fill="#254e38">${thumbnail ? '合成预览' : '3:4 合成测试照片'}</text></svg>`)}`
  }
  const api = {
    async getState() { return clone(fixtures.receiver) }, async getAppInfo() { return { version: 'layout-test', platform: 'win32' } },
    async getFamilyState(libraryId) { const assets = fixtures.assets.filter(asset => !libraryId || asset.locations.some(location => location.libraryId === libraryId)); return clone({ ...fixtures.family, photoCount: assets.filter(asset => asset.kind === 'photo').length, videoCount: assets.filter(asset => asset.kind === 'video').length }) },
    async getJobWarnings(jobId, page = 1) { const items = fixtures.warningRecords?.[jobId] ?? []; return clone({ items: items.slice((page - 1) * 20, page * 20), total: items.length, page, limit: 20 }) },
    async querySimilarFaces(query) {
      fixtures.calls.push({ ...clone(query), similar: true })
      const assets = fixtures.assets.filter(asset => asset.available && (query.scope === 'all' || asset.locations.some(location => location.libraryId === query.libraryId)) && (!query.kind || asset.kind === query.kind))
      assets.sort((left, right) => query.order === 'asc' ? left.date.localeCompare(right.date) : right.date.localeCompare(left.date))
      const page = query.page ?? 1, limit = query.limit ?? 50
      return clone({ items: assets.slice((page - 1) * limit, page * limit).map(asset => ({ ...asset, similarity: .9 })), total: assets.length, page, limit, scope: query.scope, threshold: .4, coverage: { total: assets.length, done: assets.length, pending: 0, error: 0 } })
    },
    async setCurrentLibrary(id) { fixtures.receiver.currentLibraryId = id },
    async queryMedia(query) {
      fixtures.calls.push(clone(query))
      const memberships = new Map(fixtures.decisions.filter(item => !query.babyId || item.babyId === query.babyId).map(item => [item.assetId, item]))
      const assets = fixtures.assets.filter(asset => {
        const membership = memberships.get(asset.id)
        if (query.babyId && (query.unconfirmed ? Boolean(membership && !(membership.state === 'unconfirmed' || membership.state === 'excluded' && membership.origin === 'recognition')) : query.includeCandidates ? !['included', 'candidate'].includes(membership?.state) : query.candidates ? membership?.state !== 'candidate' : membership?.state !== 'included')) return false
        if (!query.babyId && query.candidates && membership?.state !== 'candidate') return false
        return (!query.libraryId || asset.locations.some(location => location.libraryId === query.libraryId)) && (!query.kind || asset.kind === query.kind) && (!query.favorite || asset.favorite) && (!query.source || asset.locations.some(location => location.source === query.source)) && (!query.dateSource || asset.dateSource === query.dateSource) && (!query.from || asset.date >= query.from) && (!query.to || asset.date <= query.to)
      }).sort((left, right) => (query.order === 'asc' ? left.date.localeCompare(right.date) : right.date.localeCompare(left.date)) || left.id.localeCompare(right.id))
      const page = query.page ?? 1, limit = query.limit ?? 48
      return clone({ items: assets.slice((page - 1) * limit, page * limit).map(asset => {
        const decisions = fixtures.decisions.filter(item => item.assetId === asset.id).map(item => item.origin === 'recognition' && item.state === 'excluded' ? { ...item, state: 'unconfirmed' } : item)
        return { ...asset, babyDecisions: decisions, babyIds: decisions.filter(item => item.state === 'included').map(item => item.babyId), ...(query.unconfirmed ? { babyReviewReason: asset.faces.length ? '尚未确定归属，可直接人工核对。' : '未检测到人脸，可直接人工核对。' } : {}) }
      }), total: assets.length, page, limit })
    },
    async mediaUrl(id, thumbnail) { fixtures.mediaUrlCalls.push({ id, thumbnail }); return image(fixtures.assets.find(asset => asset.id === id), thumbnail) },
    async previewWatermark(id) { return { dataUrl: image(fixtures.assets.find(asset => asset.id === id)), filename: '合成水印.jpg' } },
    async exportWatermark() { return [] }, async prepareImport(rootId, mode, libraryId) {
      const plan = { id: 'synthetic-plan', rootId, mode, libraryId, state: 'ready', count: 52, bytes: 1024 * 52, unknownDates: 0, creationDates: 0,
        preview: fixtures.assets.slice(0, 3).map(asset => ({ filename: asset.filename, date: asset.date, dateSource: asset.dateSource, relativePath: `2026-06-15/${asset.filename}` })) }
      fixtures.family.importPlans = [plan]; return clone(plan)
    },
    async saveBaby(value) { fixtures.family.babies = [clone(value)] }, async setFavorite(id, favorite) { fixtures.assets.find(asset => asset.id === id).favorite = favorite },
    async addDirectories() {}, async toggleDirectory() {}, async scan() {}, async scanMedia(libraryId) { fixtures.scanCalls = [...(fixtures.scanCalls ?? []), libraryId] }, async executeImport() {}, async setAccepting() {}, async revokeDevice() {},
    async revealMedia() {}, async revealFile() {}, async setBabyMembership() {}, async setMediaDate() {}, async analyzeFaces() {}, async supplementFaces() {}, async namePerson() {},
    async setBabyReference(babyId, assetId, faceId) { const baby = fixtures.family.babies.find(item => item.id === babyId); if (!baby.referenceFaces.some(item => item.faceId === faceId)) baby.referenceFaces.push({ assetId, faceId }) }, async matchBaby() {},
    async selectFolders() { return [] }, async previewFile() { return image(fixtures.assets[0]) }, async createPairing() { throw new Error('布局测试不会创建真实配对。') },
  }
  Object.assign(window, { jinchuan: api, __layoutFixtures: fixtures })
}

function record(viewport, scenario, check, passed, metrics) {
  const item = { viewport: `${viewport.width}x${viewport.height}`, scenario, check, passed, metrics }
  report.checks.push(item)
  if (!passed) report.failures.push(item)
}

/** 测量真实浏览器布局；只读取合成页面，不修改产品的布局或滚动行为。 */
async function metrics(page) {
  return page.evaluate(() => {
    const bounds = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
    const content = document.querySelector('.page-content')
    const selectors = ['.sidebar', '.topbar', '.library-switcher']
    return { viewport: { width: innerWidth, height: innerHeight }, document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, x: scrollX, y: scrollY },
      content: { ...bounds(content), clientWidth: content.clientWidth, clientHeight: content.clientHeight, scrollWidth: content.scrollWidth, scrollHeight: content.scrollHeight, scrollTop: content.scrollTop },
      positions: Object.fromEntries(selectors.map(selector => [selector, bounds(document.querySelector(selector))])) }
  })
}

async function settle(page) {
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
}

/** 从固定顶栏打开记录，避免测试通过滚到页尾掩盖原先的浏览问题。 */
async function openProcessingRecords(page) {
  await page.locator('.topbar').getByRole('button', { name: '处理记录', exact: true }).click()
  await page.getByRole('dialog', { name: '本地处理记录', exact: true }).waitFor()
  await settle(page)
}

/** 保存图库的浏览状态，用于核对弹窗关闭不会重置照片选择和月份。 */
async function galleryPosition(page) {
  return page.evaluate(() => ({
    scrollTop: document.querySelector('.page-content').scrollTop,
    selected: [...document.querySelectorAll('.media-select[aria-pressed="true"]')].map(button => button.getAttribute('aria-label')),
    months: [...document.querySelectorAll('.month-group-toggle')].map(button => ({ label: button.textContent.trim(), expanded: button.getAttribute('aria-expanded') })),
  }))
}

/** 只统计临时操作菜单，说明与任务折叠块不属于待关闭浮层。 */
async function transientMenuCount(page) {
  return page.locator('.library-menu,.gallery-tools[data-open="true"],.baby-tools[data-open="true"],.growth-extra[data-open="true"],.device-tools[data-open="true"]').count()
}

/** 使用业务标识点击真实下拉选项，测量与交互均使用可见组件。 */
function selectControl(page, label) {
  return page.locator(`.ui-select[data-control-label=${JSON.stringify(label)}]`)
}

async function chooseSelect(page, control, value) {
  await control.getByRole('combobox').click()
  await page.locator(`[role="option"][data-key=${JSON.stringify(value)}]:visible`).click()
}

/** 测量记录弹窗与内部滚动区，长任务名只能在弹窗内换行或滚动。 */
async function processingDialogBounds(page) {
  return page.locator('.processing-records-dialog').evaluate(dialog => {
    const bounds = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, height: rect.height } }
    const body = dialog.querySelector('.processing-records-body')
    return { dialog: bounds(dialog), close: bounds(dialog.querySelector('button[aria-label="关闭处理记录"]')), body: bounds(body), modal: (dialog.getAttribute('role') === 'dialog' && dialog.getAttribute('aria-modal') === 'true'), ariaModal: dialog.getAttribute('aria-modal'), dialogWidth: dialog.clientWidth, dialogScrollWidth: dialog.scrollWidth, bodyWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth, bodyHeight: body.clientHeight, bodyScrollHeight: body.scrollHeight }
  })
}

/** 测量大图、固定工具栏和按需信息面板，缩放只影响照片平面。 */
async function mediaPreviewBounds(page) {
  return page.locator('.media-dialog').evaluate(dialog => {
    const bounds = element => { if (!element) return null; const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } }
    const overlay = dialog.closest('.preview-backdrop'), padding = getComputedStyle(overlay), overlayBounds = bounds(overlay)
    const viewport = dialog.querySelector('.preview-viewport'), stage = dialog.querySelector('.detail-media-stage'), image = stage?.querySelector('img'), panel = dialog.querySelector('.preview-information'), panelBody = dialog.querySelector('.preview-information-body'), toolbar = dialog.querySelector('.preview-toolbar')
    return {
      dialog: bounds(dialog), titlebarBottom: bounds(document.querySelector('.topbar'))?.bottom ?? 0, available: { left: overlayBounds.left + parseFloat(padding.paddingLeft), right: overlayBounds.right - parseFloat(padding.paddingRight), top: overlayBounds.top + parseFloat(padding.paddingTop), bottom: overlayBounds.bottom - parseFloat(padding.paddingBottom) },
      viewport: bounds(viewport), stage: bounds(stage), image: bounds(image), naturalRatio: image ? image.naturalWidth / image.naturalHeight : null,
      toolbar: bounds(toolbar), toolbarButtons: [...(toolbar?.querySelectorAll('button') ?? [])].map(bounds), heading: bounds(dialog.querySelector('.preview-heading')),
      face: bounds(stage?.querySelector('.face-box')), panel: bounds(panel), panelWidth: panelBody?.clientWidth, panelScrollWidth: panelBody?.scrollWidth, panelHeight: panelBody?.clientHeight, panelScrollHeight: panelBody?.scrollHeight,
      dialogWidth: dialog.clientWidth, dialogScrollWidth: dialog.scrollWidth, viewportWidth: viewport?.clientWidth, viewportScrollWidth: viewport?.scrollWidth,
    }
  })
}

/** 档案正文与选图网格分别滚动，保存和取消始终位于固定页脚。 */
async function babyProfileBounds(page) {
  return page.locator('.baby-profile-dialog').evaluate(dialog => {
    const bounds = element => { if (!element) return null; const item = element.getBoundingClientRect(); return { left: item.left, top: item.top, right: item.right, bottom: item.bottom, width: item.width, height: item.height } }
    const body = dialog.querySelector('.baby-profile-body'), footer = dialog.querySelector('.baby-profile-footer'), grid = dialog.querySelector('.profile-avatar-grid')
    return { dialog: bounds(dialog), modal: (dialog.getAttribute('role') === 'dialog' && dialog.getAttribute('aria-modal') === 'true'), scrollWidth: dialog.scrollWidth, clientWidth: dialog.clientWidth, body: bounds(body), bodyScrollTop: body.scrollTop, bodyScrollWidth: body.scrollWidth, bodyClientWidth: body.clientWidth,
      footer: bounds(footer), actions: [...footer.querySelectorAll('button')].map(bounds), grid: bounds(grid), gridScrollWidth: grid?.scrollWidth, gridClientWidth: grid?.clientWidth, gridScrollHeight: grid?.scrollHeight, gridClientHeight: grid?.clientHeight }
  })
}

/** 记录短暂折叠反馈，避免测试等待点击结束时错过已完成的加载提示。 */
async function observeFoldFeedback(page) {
  await page.evaluate(() => {
    window.__layoutFoldFeedback = []
    const capture = () => {
      const status = document.querySelector('.month-fold-status')
      if (status?.getClientRects().length && status.textContent.trim()) window.__layoutFoldFeedback.push(status.textContent.trim())
    }
    new MutationObserver(capture).observe(document.body, { childList: true, subtree: true, characterData: true })
    capture()
  })
}

/** 从已滚动的内容中触发折叠，直接检查处理程序归顶，避免浏览器先滚动按钮掩盖问题。 */
async function collapseFromScrolledContent(page) {
  return page.getByRole('button', { name: '折叠全部', exact: true }).evaluate(button => {
    const content = document.querySelector('.page-content')
    content.scrollTop = 500
    const before = content.scrollTop
    button.click()
    return before
  })
}

async function waitForFoldCompletion(page) {
  await page.waitForFunction(() => {
    const status = document.querySelector('.month-fold-status')
    return (!status || !status.getClientRects().length) && [...document.querySelectorAll('.month-group-toggle')].every(button => button.getAttribute('aria-expanded') === 'false') && !document.querySelector('.media-card')
  })
}

async function checkFrame(page, viewport, scenario) {
  const value = await metrics(page)
  record(viewport, scenario, 'body 不纵横滚动', value.document.width <= viewport.width + 1 && value.document.height <= viewport.height + 1 && value.document.x === 0 && value.document.y === 0, value)
  record(viewport, scenario, '内容无水平溢出', value.content.scrollWidth <= value.content.clientWidth + 1, value.content)
  if (['图库', '宝宝相册'].includes(scenario)) {
    const toolbar = await page.locator('.media-search-toolbar').evaluate(element => {
      const heading = element.querySelector('.media-toolbar-heading'), rect = heading.getBoundingClientRect()
      const overlaps = [...element.children].filter(child => child !== heading && child.getClientRects().length).map(child => {
        const bounds = child.getBoundingClientRect()
        return { control: child.className, width: Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left), height: Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top) }
      }).filter(item => item.width > 1 && item.height > 1)
      return { fits: heading.scrollWidth <= heading.clientWidth + 1, overlaps }
    })
    record(viewport, scenario, '相册标题和数量完整显示，不挤入筛选按钮', toolbar.fits && !toolbar.overlaps.length, toolbar)
  }
}

async function screenshot(page, name) {
  const path = resolve(artifactDirectory, `${label}-${name}.png`)
  await page.screenshot({ path, fullPage: false })
  report.screenshots.push(path)
}

try {
  await mkdir(artifactDirectory, { recursive: true })
  server = await createServer({ configFile: false, root: rendererRoot, cacheDir: resolve(artifactDirectory, 'vite-cache'), plugins: [vue(), {
    name: 'jinchuan-independent-layout', configureServer(instance) {
      instance.middlewares.use((request, response, next) => {
        if (request.url === '/favicon.ico') { response.statusCode = 204; response.end(); return }
        if (request.url !== '/__layout_test') { next(); return }
        response.setHeader('content-type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/src/main.ts"></script></body></html>')
      })
    },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, fs: { allow: [projectRoot] } }, logLevel: 'error' })
  await server.listen()
  const address = server.httpServer.address()
  const url = `http://127.0.0.1:${address.port}/__layout_test`
  browser = await chromium.launch({ executablePath: executable, headless: true })
  for (const viewport of [{ width: 820, height: 600 }, { width: 1180, height: 800 }, { width: 1600, height: 900 }, { width: 640, height: 720 }, { width: 390, height: 844 }]) {
    const page = await browser.newPage({ viewport })
    page.setDefaultTimeout(8000)
    page.on('pageerror', error => report.errors.push({ viewport, message: error.message }))
    await page.addInitScript(installFixtures)
    await page.goto(url, { waitUntil: 'networkidle' })
    await page.locator('.media-card').first().waitFor()
    record(viewport, '默认首页', '默认进入照片且左侧只有三个主模块', await page.locator('.module-navigation button').count() === 3 && await page.locator('.module-navigation button.selected').getAttribute('aria-label') === '照片与视频')
    record(viewport, '照片库', '顶部一直展示当前照片库名字', (await page.locator('.library-toggle').innerText()).includes('合成归档'))
    await settle(page)
    await checkFrame(page, viewport, '图库')
    const firstMedia = await page.locator('.media-cover').first().boundingBox()
    record(viewport, '图库', '首屏直接展示照片而不是大段介绍', Boolean(firstMedia && firstMedia.y + Math.min(firstMedia.height, 80) <= viewport.height), firstMedia)
    const recordButton = await page.locator('.topbar').getByRole('button', { name: '处理记录', exact: true }).boundingBox()
    record(viewport, '处理记录入口', '按钮位于固定顶栏且保持紧凑', Boolean(recordButton && recordButton.x >= 0 && recordButton.y >= 0 && recordButton.x + recordButton.width <= viewport.width && recordButton.y + recordButton.height <= 56 && recordButton.height <= 36), recordButton)
    record(viewport, '处理记录入口', '已有处理任务和失败也不自动弹窗或在图库底部创建日志', await page.locator('.processing-records-dialog,.family-jobs,.job-row').count() === 0)
    if (viewport.width === 1180) {
      await page.locator('.library-toggle').click()
      await page.locator('.library-menu').waitFor()
      await page.locator('.header-brand').click()
      const libraryOutsideClosed = await page.locator('.library-menu').count() === 0
      await page.locator('.library-toggle').click()
      await page.locator('.library-menu').waitFor()
      await page.keyboard.press('Escape')
      record(viewport, '临时菜单关闭', '照片库菜单支持外点和Escape关闭', libraryOutsideClosed && await page.locator('.library-menu').count() === 0)
      await page.locator('.gallery-tools button[aria-expanded]').click()
      await page.locator('.library-toggle').click()
      await settle(page)
      const libraryIsOnlyMenu = await transientMenuCount(page) === 1 && await page.locator('.library-menu').count() === 1
      await page.locator('.gallery-tools button[aria-expanded]').click()
      await settle(page)
      const galleryIsOnlyMenu = await transientMenuCount(page) === 1 && await page.locator('.gallery-tools[data-open=true]').count() === 1
      await page.keyboard.press('Escape')
      record(viewport, '临时菜单关闭', '库菜单与图库工具互斥，Escape收起当前工具', libraryIsOnlyMenu && galleryIsOnlyMenu && await transientMenuCount(page) === 0)
    }
    const listRefresh = page.getByRole('button', { name: '刷新列表', exact: true }), rescan = page.getByRole('button', { name: '重新扫描', exact: true })
    const reloadControls = [await listRefresh.boundingBox(), await rescan.boundingBox()]
    record(viewport, '图库刷新', '刷新列表和重新扫描直接可见且按钮保持紧凑', reloadControls.every(bounds => bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height && bounds.height <= 44), reloadControls)
    record(viewport, '图库刷新', '中断扫描提示直接可见而不会显示扫描全部完成', await page.locator('.gallery-scan-status').isVisible() && (await page.locator('.gallery-scan-status').innerText()).includes('中断'))
    const queriesBeforeRefresh = await page.evaluate(() => window.__layoutFixtures.calls.length)
    await listRefresh.click()
    await page.waitForFunction(count => window.__layoutFixtures.calls.length > count, queriesBeforeRefresh)
    await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent.trim() === '刷新列表' && !button.disabled) && document.querySelectorAll('.month-group-toggle').length >= 2)
    record(viewport, '图库刷新', '刷新列表读取当前索引且不启动目录扫描', await page.evaluate(() => !(window.__layoutFixtures.scanCalls?.length)))
    record(viewport, '图库', '按月份分组展示媒体', await page.locator('.media-date-group').count() >= 2 && (await page.locator('.month-group-toggle').first().innerText()).includes('月'))
    await observeFoldFeedback(page)
    const scrollBeforeCollapse = await collapseFromScrolledContent(page)
    await waitForFoldCompletion(page)
    record(viewport, '月份折叠', '全部折叠提供处理中反馈', await page.evaluate(() => window.__layoutFoldFeedback.length > 0))
    record(viewport, '月份折叠', '折叠后内容归顶，不停留在底部记录区域', scrollBeforeCollapse > 0 && (await metrics(page)).content.scrollTop <= 1, { scrollBeforeCollapse, scrollAfterCollapse: (await metrics(page)).content.scrollTop })
    record(viewport, '月份折叠', '全部折叠后照片隐藏且月份标题仍可操作', await page.locator('.month-group-toggle[aria-expanded="false"]').count() >= 2 && await page.locator('.media-grid:visible').count() === 0)
    await page.waitForFunction(() => document.querySelector('.media-load-more')?.textContent.includes('已加载当前索引的全部 52 项'))
    record(viewport, '月份折叠', '收起后实际观察器继续加载首批之外的照片', (await page.locator('.media-load-more').innerText()).includes('已加载当前索引的全部 52 项'))
    record(viewport, '月份折叠', '新加载月份继承全部折叠且不创建隐藏照片卡片', await page.locator('.month-group-toggle[aria-expanded="false"]').count() === 3 && await page.locator('.media-grid:visible').count() === 0 && await page.locator('.media-card').count() === 0)
    await page.getByRole('button', { name: '展开全部', exact: true }).click()
    await page.waitForFunction(() => !document.querySelector('.month-fold-status') && document.querySelectorAll('.media-card').length > 0)
    record(viewport, '月份折叠', '重新展开保留52项索引且只渲染可视卡片', (await page.locator('.media-load-more').innerText()).includes('全部 52 项') && await page.locator('.media-card:visible').count() > 0 && await page.locator('.media-card').count() < 52)
    const advanced = page.locator('.advanced-filters')
    if (await advanced.count()) {
      record(viewport, '图库', '高级筛选默认折叠', !(await advanced.evaluate(element => element.getAttribute('data-open') === 'true')))
    }
    const before = await metrics(page)
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 500 })
    await settle(page)
    let after = await metrics(page)
    // 基线没有内部滚动时模拟原页面的整页滚动，仍检查导航是否被带走。
    if (after.content.scrollTop === 0) {
      await page.evaluate(() => window.scrollTo(0, 500))
      await settle(page)
      after = await metrics(page)
    }
    record(viewport, '图库', '右侧内容可以独立滚动', after.content.scrollTop > 0 && after.content.scrollHeight > after.content.clientHeight, after.content)
    record(viewport, '图库', '内容滚动后导航和顶栏保持位置', Object.keys(before.positions).every(selector => ['left', 'top', 'width', 'height'].every(key => Math.abs(before.positions[selector][key] - after.positions[selector][key]) < 1)), { before: before.positions, after: after.positions })
    await page.locator('.media-select').first().evaluate(button => button.click())
    await page.locator('.month-group-toggle').last().evaluate(button => button.click())
    await settle(page)
    const browsingBeforeRecords = await galleryPosition(page)
    if (viewport.width === 1180) await page.locator('.gallery-tools button[aria-expanded]').evaluate(summary => summary.click())
    await openProcessingRecords(page)
    if (viewport.width === 1180) record(viewport, '临时菜单关闭', '打开处理记录收起后台图库工具', await transientMenuCount(page) === 0)
    await checkFrame(page, viewport, '处理记录弹窗')
    const recordsBounds = await processingDialogBounds(page)
    record(viewport, '处理记录弹窗', '记录使用原生模态弹窗隔离键盘焦点', recordsBounds.modal && recordsBounds.ariaModal === 'true')
    record(viewport, '处理记录弹窗', '长任务路径不会撑宽弹窗且关闭操作位于视口', recordsBounds.dialog.left >= 0 && recordsBounds.dialog.right <= viewport.width && recordsBounds.dialog.top >= 0 && recordsBounds.dialog.bottom <= viewport.height && recordsBounds.close.top >= recordsBounds.dialog.top && recordsBounds.close.bottom <= recordsBounds.dialog.bottom && recordsBounds.dialogScrollWidth <= recordsBounds.dialogWidth + 1 && recordsBounds.bodyScrollWidth <= recordsBounds.bodyWidth + 1, recordsBounds)
    record(viewport, '处理记录弹窗', '大量记录在弹窗内部独立滚动', recordsBounds.bodyScrollHeight > recordsBounds.bodyHeight && recordsBounds.bodyHeight >= 80, recordsBounds)
    await page.locator('.processing-records-body').evaluate(element => { element.scrollTop = element.scrollHeight })
    await settle(page)
    record(viewport, '处理记录弹窗', '弹窗滚动不会带动图库', Math.abs((await galleryPosition(page)).scrollTop - browsingBeforeRecords.scrollTop) <= 1)
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-processing-records`)
    await page.keyboard.press('Escape')
    await page.locator('.processing-records-dialog').waitFor({ state: 'detached' })
    const browsingAfterRecords = await galleryPosition(page)
    record(viewport, '处理记录弹窗', 'Escape 关闭后滚动位置、所选照片和月份折叠保持原样', Math.abs(browsingAfterRecords.scrollTop - browsingBeforeRecords.scrollTop) <= 1 && JSON.stringify(browsingAfterRecords.selected) === JSON.stringify(browsingBeforeRecords.selected) && JSON.stringify(browsingAfterRecords.months) === JSON.stringify(browsingBeforeRecords.months), { before: browsingBeforeRecords, after: browsingAfterRecords })
    await openProcessingRecords(page)
    await page.getByRole('button', { name: '关闭处理记录', exact: true }).click()
    await page.locator('.processing-records-dialog').waitFor({ state: 'detached' })
    record(viewport, '处理记录弹窗', '关闭按钮移除弹窗及日志节点', await page.locator('.processing-records-dialog,.family-jobs,.job-row').count() === 0)
    await page.locator('.media-select[aria-pressed="true"]').evaluate(button => button.click())
    await page.locator('.month-group-toggle').last().evaluate(button => button.click())
    await settle(page)
    await page.evaluate(() => window.scrollTo(0, 0))
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 0 })
    await settle(page)
    if (await advanced.count()) await advanced.locator('button[aria-expanded]').click()
    const controls = await page.locator('.gallery-search input,.advanced-filter-fields .ui-date-picker,.advanced-filter-fields .ui-select').evaluateAll(elements => elements.map(element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, rowTop: element.parentElement.getBoundingClientRect().top, right: rect.right, height: rect.height } }))
    const rows = []
    for (const control of controls) { const row = rows.find(row => Math.abs(row[0].rowTop - control.rowTop) < 3); row ? row.push(control) : rows.push([control]) }
    record(viewport, '图库', '筛选控件同排等高且位于视口', rows.every(row => Math.max(...row.map(item => item.height)) - Math.min(...row.map(item => item.height)) <= 1 && Math.max(...row.map(item => item.top)) - Math.min(...row.map(item => item.top)) <= 1) && controls.every(item => item.left >= -1 && item.right <= viewport.width + 1), { rows })
    if (await advanced.count()) await advanced.locator('button[aria-expanded]').click()
    if (viewport.width === 1180) await screenshot(page, '1180-library')

    await page.locator('.month-group-toggle').last().evaluate(button => button.click())
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 500 })
    await page.locator('.media-cover').first().scrollIntoViewIfNeeded()
    await settle(page)
    const browsingBeforePreview = await galleryPosition(page)
    if (viewport.width === 1180) await page.locator('.gallery-tools button[aria-expanded]').evaluate(summary => summary.click())
    await page.locator('.media-cover').first().click()
    await page.locator('.detail-media-stage img').waitFor()
    await page.waitForFunction(() => { const image = document.querySelector('.detail-media-stage img'); return image?.complete && image.naturalWidth > 0 })
    await settle(page)
    const detail = await mediaPreviewBounds(page)
    if (viewport.width === 1180) record(viewport, '临时菜单关闭', '打开大图收起后台工具菜单', await transientMenuCount(page) === 0)
    record(viewport, '照片预览', '大图弹窗使用标题安全区以下的遮罩可用范围且没有横向溢出', detail.dialog.left >= detail.available.left - 1 && detail.dialog.right <= detail.available.right + 1 && detail.dialog.top >= detail.available.top - 1 && detail.dialog.bottom <= detail.available.bottom + 1 && detail.heading.top >= detail.titlebarBottom && detail.dialog.width >= viewport.width - 28 && detail.dialog.height >= detail.available.bottom - detail.available.top - 1 && detail.dialogScrollWidth <= detail.dialogWidth + 1, detail)
    record(viewport, '照片预览', '紧凑标题与工具栏把至少三分之二高度留给图片', detail.heading.height <= 60 && detail.viewport.height >= detail.dialog.height * .65 && detail.toolbarButtons.every(button => button.left >= detail.dialog.left - 1 && button.right <= detail.dialog.right + 1 && button.top >= detail.dialog.top - 1 && button.bottom <= detail.dialog.bottom + 1), detail)
    record(viewport, '照片预览', '竖图保持原图比例并完整适应画布', Math.abs(detail.stage.width / detail.stage.height - .75) < .01 && Math.abs(detail.naturalRatio - .75) < .001 && detail.stage.left >= detail.viewport.left - 1 && detail.stage.right <= detail.viewport.right + 1 && detail.stage.top >= detail.viewport.top - 1 && detail.stage.bottom <= detail.viewport.bottom + 1, detail)
    record(viewport, '照片预览', '默认收起文件信息且不显示人脸标记或选择条', await page.locator('.media-dialog .detail-metadata').count() === 0 && await page.locator('.media-dialog').getByRole('button', { name: '照片信息', exact: true }).getAttribute('aria-expanded') === 'false' && detail.face === null && await page.locator('.media-dialog .face-selector').count() === 0, detail)
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-photo-preview`)

    const preview = page.locator('.media-dialog')
    await preview.getByRole('button', { name: '实际大小', exact: true }).click()
    await settle(page)
    const actualSize = await mediaPreviewBounds(page)
    record(viewport, '照片预览操作', '实际大小显示100%并使用原图像素尺寸', (await preview.locator('.preview-zoom-value').innerText()).includes('100%') && Math.abs(actualSize.stage.width - 300) <= 1 && Math.abs(actualSize.stage.height - 400) <= 1, actualSize)
    await preview.getByRole('button', { name: '放大', exact: true }).click()
    await settle(page)
    const zoomed = await mediaPreviewBounds(page), zoomValue = await preview.locator('.preview-zoom-value').innerText()
    record(viewport, '照片预览操作', '缩放增大照片而不推走工具栏或扩大弹窗', zoomed.stage.width > actualSize.stage.width && parseInt(zoomValue) > 100 && Math.abs(zoomed.toolbar.top - actualSize.toolbar.top) <= 1 && zoomed.dialogScrollWidth <= zoomed.dialogWidth + 1, { actualSize, zoomed, zoomValue })
    await preview.getByRole('button', { name: '向右旋转', exact: true }).click()
    await settle(page)
    const rotated = await mediaPreviewBounds(page)
    record(viewport, '照片预览操作', '向右旋转使显示比例正确交换且操作栏保持位置', Math.abs(rotated.stage.width / rotated.stage.height - 4 / 3) < .01 && Math.abs(rotated.toolbar.top - zoomed.toolbar.top) <= 1 && rotated.dialogScrollWidth <= rotated.dialogWidth + 1, rotated)
    await preview.getByRole('button', { name: '适应窗口', exact: true }).click()
    await settle(page)
    const fitted = await mediaPreviewBounds(page)
    record(viewport, '照片预览操作', '旋转后适应窗口仍完整显示照片', fitted.stage.left >= fitted.viewport.left - 1 && fitted.stage.right <= fitted.viewport.right + 1 && fitted.stage.top >= fitted.viewport.top - 1 && fitted.stage.bottom <= fitted.viewport.bottom + 1, fitted)
    await preview.getByRole('button', { name: '下一项', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.media-dialog h2')?.textContent.includes('very-long-filename'))
    await page.waitForFunction(() => { const image = document.querySelector('.detail-media-stage img'); return image?.complete && image.naturalWidth > 0 })
    await settle(page)
    const nextPreview = await mediaPreviewBounds(page)
    record(viewport, '照片预览导航', '下一项保留紧凑标题，长文件名不撑宽工具栏', nextPreview.heading.height <= 60 && nextPreview.dialogScrollWidth <= nextPreview.dialogWidth + 1 && nextPreview.toolbarButtons.every(button => button.right <= nextPreview.dialog.right + 1), nextPreview)
    await preview.getByRole('button', { name: '照片信息', exact: true }).click()
    await preview.locator('.detail-metadata').waitFor()
    await settle(page)
    const information = await mediaPreviewBounds(page)
    record(viewport, '照片信息', '长路径在右侧信息面板换行且不撑宽预览', information.panel.left >= information.dialog.left - 1 && information.panel.right <= information.dialog.right + 1 && information.panel.top >= information.dialog.top - 1 && information.panel.bottom <= information.dialog.bottom + 1 && information.panel.width <= 320 && information.panelScrollWidth <= information.panelWidth + 1 && information.dialogScrollWidth <= information.dialogWidth + 1, information)
    record(viewport, '照片信息', '信息内部独立滚动，窄窗口不把图片推到下面', information.panelScrollHeight > information.panelHeight && information.viewport.height >= information.dialog.height * .65 && information.viewport.top < information.panel.bottom, information)
    const galleryBeforeInformationScroll = await galleryPosition(page)
    await preview.locator('.preview-information-body').evaluate(panel => { panel.scrollTop = panel.scrollHeight })
    await settle(page)
    const informationScrolled = await mediaPreviewBounds(page)
    record(viewport, '照片信息', '滚动详细信息不会带动大图、操作栏或图库', ['left', 'top', 'width', 'height'].every(key => Math.abs(information.viewport[key] - informationScrolled.viewport[key]) <= 1) && Math.abs(information.toolbar.top - informationScrolled.toolbar.top) <= 1 && Math.abs((await galleryPosition(page)).scrollTop - galleryBeforeInformationScroll.scrollTop) <= 1, { before: information, after: informationScrolled })
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-photo-information`)
    if (viewport.width === 1180 || viewport.width === 390) {
      await page.mouse.click(information.viewport.left + 8, information.viewport.bottom - 8)
      await preview.locator('.detail-metadata').waitFor({ state: 'detached' })
      const viewportClickKeepsPreview = await preview.count() === 1
      await preview.getByRole('button', { name: '照片信息', exact: true }).click()
      await preview.locator('.detail-metadata').waitFor()
      const previewBackdrop = await preview.boundingBox()
      await page.mouse.click(2, previewBackdrop.y + 2)
      await preview.locator('.detail-metadata').waitFor({ state: 'detached' })
      record(viewport, '浮层关闭顺序', '点击画布外侧或遮罩先收起信息，保留预览', viewportClickKeepsPreview && await preview.count() === 1)
    } else await preview.getByRole('button', { name: '关闭照片信息', exact: true }).click()
    await preview.locator('.detail-metadata').waitFor({ state: 'detached' })
    await preview.getByRole('button', { name: '上一项', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.media-dialog h2')?.textContent === 'portrait-3x4.jpg')
    record(viewport, '照片预览导航', '上一项回到原照片且信息恢复按需查看', await preview.locator('.detail-metadata').count() === 0 && await preview.getByRole('button', { name: '照片信息', exact: true }).getAttribute('aria-expanded') === 'false')
    await page.keyboard.press('Escape')
    await preview.waitFor({ state: 'detached' })
    const browsingAfterPreview = await galleryPosition(page)
    record(viewport, '照片预览关闭', 'Escape关闭预览后图库位置、所选媒体和月份折叠保持', Math.abs(browsingAfterPreview.scrollTop - browsingBeforePreview.scrollTop) <= 1 && JSON.stringify(browsingAfterPreview.selected) === JSON.stringify(browsingBeforePreview.selected) && JSON.stringify(browsingAfterPreview.months) === JSON.stringify(browsingBeforePreview.months), { before: browsingBeforePreview, after: browsingAfterPreview })
    await page.locator('.month-group-toggle').last().evaluate(button => button.click())

    await page.locator('.gallery-tools button[aria-expanded]').click()
    await page.getByRole('button', { name: '按人物查找', exact: true }).click()
    await page.locator('.person-card').waitFor()
    await settle(page)
    await checkFrame(page, viewport, '人物头像')
    record(viewport, '人物头像', '人物卡片展示头像与数量，默认不混入全部照片', await page.locator('.person-card .face-avatar img').count() === 1 && await page.locator('.media-card').count() === 0 && (await page.locator('.person-card').innerText()).includes('52 张照片与视频'))
    if (viewport.width === 1180) await screenshot(page, '1180-people')
    await page.locator('.person-card .person-open').click()
    await page.locator('.media-card').first().waitFor()
    await checkFrame(page, viewport, '人物照片')
    record(viewport, '人物照片', '点击头像后全局查找相似人脸且保留返回入口', await page.locator('.similar-face-context button').first().innerText() === '← 返回' && (await page.locator('.similar-face-context').innerText()).includes('全部已授权目录'))
    await chooseSelect(page, selectControl(page, '相似人脸查找范围'), 'library')
    await page.waitForFunction(() => window.__layoutFixtures.calls.at(-1)?.similar && window.__layoutFixtures.calls.at(-1)?.scope === 'library')
    await settle(page)
    await checkFrame(page, viewport, '相似人脸范围')
    record(viewport, '相似人脸范围', '可明确限定当前库且保留覆盖统计', (await page.locator('.similar-face-context').innerText()).includes('当前照片库') && (await page.locator('.similar-face-coverage').innerText()).includes('52'))
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-similar-faces`)

    // 合并前用头像明确选择目标，大量人物在对话框内部滚动。
    await page.evaluate(() => {
      const fixtures = window.__layoutFixtures, template = fixtures.family.people[0]
      fixtures.family.people.push(...Array.from({ length: 44 }, (_, index) => ({ ...structuredClone(template), id: `merge-person-${index}`, name: index === 0 ? '同一个人的另一个场景头像用于验证长名字' : `合成人物 ${index + 1}`, faceCount: 1, assetCount: 1 })))
    })
    await page.getByRole('button', { name: '← 返回', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.person-card').length === 40)
    await page.locator('.person-card[data-person-id="person-one"] .person-merge').click()
    const mergeDialog = page.getByRole('dialog', { name: '合并人物', exact: true })
    await mergeDialog.locator('.face-avatar img').first().waitFor()
    record(viewport, '人物合并', '未明确选择目标时不能确认合并', await mergeDialog.getByRole('button', { name: '确认合并', exact: true }).isDisabled() && await mergeDialog.locator('.person-open[aria-pressed="true"]').count() === 0)
    const mergeBounds = await mergeDialog.evaluate(dialog => {
      const bounds = element => { const rect = element.getBoundingClientRect(); return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } }
      const targets = dialog.querySelector('.merge-targets')
      return { dialog: bounds(dialog), footer: bounds(dialog.querySelector('.merge-footer')), targets: bounds(targets), horizontalOverflow: dialog.scrollWidth > dialog.clientWidth + 1, canScrollTargets: targets.scrollHeight > targets.clientHeight }
    })
    record(viewport, '人物合并', '合并弹窗与确认栏在视口内且没有横向溢出', !mergeBounds.horizontalOverflow && mergeBounds.dialog.left >= 0 && mergeBounds.dialog.right <= viewport.width && mergeBounds.dialog.top >= 0 && mergeBounds.dialog.bottom <= viewport.height && mergeBounds.footer.bottom <= mergeBounds.dialog.bottom, mergeBounds)
    record(viewport, '人物合并', '目标头像独立滚动，照片和确认操作保持可用', mergeBounds.canScrollTargets && mergeBounds.targets.height >= 80, mergeBounds)
    await mergeDialog.locator('.person-card[data-person-id="merge-person-0"] .person-open').click()
    record(viewport, '人物合并', '明确选择头像后高亮唯一目标并启用确认', await mergeDialog.locator('.person-open[aria-pressed="true"]').count() === 1 && await mergeDialog.getByRole('button', { name: '确认合并', exact: true }).isEnabled())
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-person-merge`)
    await mergeDialog.getByRole('button', { name: '取消', exact: true }).click()

    await page.locator('.page-content').evaluate(element => { element.scrollTop = 350 })
    if (viewport.width === 1180) await page.evaluate(() => { window.__layoutFixtures.receiver.devices = [{ id: 'popup-device-one', name: '合成手机 1', revoked: false }, { id: 'popup-device-two', name: '合成手机 2', revoked: false }] })
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.import-actions').waitFor()
    await settle(page)
    record(viewport, '模块切换', '切换模块后内容回到顶部', (await metrics(page)).content.scrollTop <= 1, (await metrics(page)).content)
    await checkFrame(page, viewport, '导入概览')
    const importEntry = await page.getByRole('button', { name: /从电脑文件夹导入/ }).boundingBox()
    const pairingEntry = await page.getByRole('button', { name: '连接新手机', exact: true }).boundingBox()
    record(viewport, '导入概览', '导入和手机连接操作无需滚动即可看到', Boolean(importEntry && pairingEntry && importEntry.y >= 0 && pairingEntry.y >= 0 && importEntry.y + importEntry.height <= viewport.height && pairingEntry.y + pairingEntry.height <= viewport.height), { importEntry, pairingEntry })
    if (viewport.width === 1180) {
      await page.waitForFunction(() => document.querySelectorAll('.device-tools').length === 2)
      await page.locator('.device-tools button[aria-expanded]').first().click()
      await page.locator('.device-tools button[aria-expanded]').nth(1).click()
      await settle(page)
      const devicesExclusive = await page.locator('.device-tools[data-open=true]').count() === 1 && await page.locator('.device-tools').nth(1).evaluate(element => element.getAttribute('data-open') === 'true')
      await page.locator('.compact-page-heading h1').click()
      const outsideClosed = await page.locator('.device-tools[data-open=true]').count() === 0
      await page.locator('.device-tools button[aria-expanded]').first().click()
      await page.keyboard.press('Escape')
      record(viewport, '临时菜单关闭', '设备操作互斥并支持外点和Escape收起', devicesExclusive && outsideClosed && await page.locator('.device-tools[data-open=true]').count() === 0)
    }
    if (viewport.width === 1180) await screenshot(page, '1180-import-overview')
    await page.getByRole('button', { name: /从电脑文件夹导入/ }).click()
    await selectControl(page, '来源文件夹').waitFor()
    await chooseSelect(page, selectControl(page, '来源文件夹'), 'root-one')
    await settle(page)
    await checkFrame(page, viewport, '电脑文件夹')
    const form = await page.locator('.family-workspace').evaluate(element => {
      const container = element.getBoundingClientRect()
      return { container: { left: container.left, right: container.right }, controls: [...element.querySelectorAll('.ui-select,.import-mode label,.target-picker button')].map(item => { const rect = item.getBoundingClientRect(); return { left: rect.left, right: rect.right, width: rect.width, label: item.tagName } }) }
    })
    record(viewport, '电脑文件夹', '长目录与复制表单没有水平溢出', form.controls.every(item => item.left >= form.container.left - 1 && item.right <= form.container.right + 1), form)
    record(viewport, '电脑文件夹', '导入目标固定当前库', await page.locator('.target-picker [role="combobox"]').count() === 0 && (await page.locator('.family-form-grid .field').last().innerText()).includes('合成归档'))
    if (viewport.width === 820) await screenshot(page, '820-import')

    await page.locator('.page-content').evaluate(element => { element.scrollTop = 250 })
    await page.locator('.module-navigation').getByRole('button', { name: '宝宝相册', exact: true }).click()
    await page.locator('.baby-profile-banner').waitFor()
    await settle(page)
    await checkFrame(page, viewport, '宝宝相册')
    const firstBabyMedia = await page.locator('.media-cover').first().boundingBox()
    record(viewport, '宝宝相册', '首屏能看到宝宝照片', Boolean(firstBabyMedia && firstBabyMedia.y + Math.min(firstBabyMedia.height, 80) <= viewport.height), firstBabyMedia)
    record(viewport, '模块切换', '宝宝模块切换后内容回顶', (await metrics(page)).content.scrollTop <= 1, (await metrics(page)).content)
    const profileEntries = await page.locator('.baby-profile-banner').evaluate(banner => {
      const bounds = element => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, height: value.height } }
      return { banner: bounds(banner), entries: [...banner.querySelectorAll('button')].filter(button => button.getClientRects().length && (['编辑档案', '新建档案'].includes(button.textContent.trim()) || button.getAttribute('aria-label') === '更换宝宝头像')).map(button => ({ label: button.getAttribute('aria-label') || button.textContent.trim(), ...bounds(button) })) }
    })
    record(viewport, '宝宝档案入口', '编辑、新建及更换头像直接可见，不需展开工具菜单', profileEntries.entries.length === 3 && profileEntries.entries.every(button => button.left >= 0 && button.right <= viewport.width && button.top >= 0 && button.bottom <= viewport.height && button.height <= (button.label === '更换宝宝头像' ? 72 : 40)), profileEntries)
    record(viewport, '宝宝档案入口', '长昵称与显式按钮保持紧凑，不撑大宝宝栏', profileEntries.banner.height <= 160 && profileEntries.entries.every(button => button.left >= profileEntries.banner.left - 1 && button.right <= profileEntries.banner.right + 1), profileEntries)
    const babyHeader = page.locator('.baby-gallery-header')
    const headerBeforeScroll = await babyHeader.boundingBox()
    record(viewport, '宝宝固定顶部', '档案及常用筛选压缩后为照片保留首屏空间', headerBeforeScroll.height <= (viewport.width > 760 ? 210 : 340), headerBeforeScroll)
    record(viewport, '宝宝整理详情', '自动整理说明默认收起', await page.locator('.baby-recognition-status:visible').count() === 0)
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 400 })
    await settle(page)
    const headerAfterScroll = await babyHeader.boundingBox()
    const pinnedContent = (await metrics(page)).content
    record(viewport, '宝宝固定顶部', '滚动照片时档案和筛选停留在顶栏下方', pinnedContent.scrollTop > 0 && Math.abs(headerAfterScroll.y - pinnedContent.top) < 1 && Math.abs(headerAfterScroll.height - headerBeforeScroll.height) < 1, { before: headerBeforeScroll, after: headerAfterScroll, content: pinnedContent })
    const headerControls = await babyHeader.locator('button:visible,input:visible,.ui-select:visible,.growth-months').evaluateAll(elements => elements.filter(element => !element.matches('button') || !element.closest('.growth-months')).map(element => {
      const bounds = element.getBoundingClientRect()
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom }
    }))
    record(viewport, '宝宝固定顶部', '窄窗口内常用控件仍位于固定顶部范围', headerControls.every(control => control.left >= headerAfterScroll.x - 1 && control.right <= headerAfterScroll.x + headerAfterScroll.width + 1 && control.top >= headerAfterScroll.y - 1 && control.bottom <= headerAfterScroll.y + headerAfterScroll.height + 1), headerControls)
    await babyHeader.getByRole('button', { name: '整理与识别详情', exact: true }).click()
    await page.locator('.baby-recognition-status:visible').waitFor()
    const headerWithDetails = await babyHeader.boundingBox()
    record(viewport, '宝宝整理详情', '展开识别详情不挤占照片区域', Math.abs(headerWithDetails.height - headerAfterScroll.height) < 1)
    await page.keyboard.press('Escape')
    record(viewport, '宝宝整理详情', 'Escape关闭详情并保留照片滚动位置', await page.locator('.baby-recognition-status:visible').count() === 0 && Math.abs((await metrics(page)).content.scrollTop - pinnedContent.scrollTop) < 1)
    if (viewport.width === 1180) await screenshot(page, '1180-baby-fixed-header')
    await page.locator('.page-content').evaluate(element => { element.scrollTop = 0 })
    await settle(page)
    if (viewport.width === 1180) {
      await page.locator('.baby-tools button[aria-expanded]').evaluate(summary => summary.click())
      await settle(page)
      await page.locator('.gallery-tools button[aria-expanded]').evaluate(summary => summary.click())
      await settle(page)
      const galleryOnly = await transientMenuCount(page) === 1 && await page.locator('.gallery-tools[data-open=true]').count() === 1
      await page.locator('.growth-extra button[aria-expanded]').evaluate(summary => summary.click())
      await settle(page)
      const growthOnly = await transientMenuCount(page) === 1 && await page.locator('.growth-extra[data-open=true]').count() === 1
      await page.locator('.header-brand').click()
      const growthOutsideClosed = await transientMenuCount(page) === 0
      await page.locator('.baby-tools button[aria-expanded]').click()
      await page.keyboard.press('Escape')
      record(viewport, '临时菜单关闭', '宝宝、筛选及成长月份互斥，外点和Escape收起当前菜单', galleryOnly && growthOnly && growthOutsideClosed && await transientMenuCount(page) === 0)
    }
    if (viewport.width === 390) await screenshot(page, '390-baby')
    if (viewport.width === 1180) await screenshot(page, '1180-baby')
    const profileBeforeEditing = await page.evaluate(() => structuredClone(window.__layoutFixtures.family.babies[0]))
    const pendingAvatar = await page.evaluate(() => { const asset = window.__layoutFixtures.assets[2]; return { id: asset.id, filename: asset.filename, width: asset.width, height: asset.height } })
    if (viewport.width === 1180) await page.locator('.baby-tools button[aria-expanded]').click()
    await page.locator('.baby-profile-banner').getByRole('button', { name: '编辑档案', exact: true }).click()
    await page.locator('.baby-profile-dialog').waitFor()
    await settle(page)
    const profile = await babyProfileBounds(page)
    if (viewport.width === 1180) record(viewport, '临时菜单关闭', '打开宝宝档案收起后台菜单', await transientMenuCount(page) === 0)
    if (viewport.width === 1180 || viewport.width === 390) {
      await page.locator('.baby-profile-dialog').evaluate(dialog => { const bounds = dialog.getBoundingClientRect(); dialog.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: bounds.left + 2, clientY: bounds.top + bounds.height / 2 })) })
      await settle(page)
      record(viewport, '浮层关闭顺序', '档案收到内部空白点击不会误认为遮罩关闭', await page.locator('.baby-profile-dialog').count() === 1)
    }
    record(viewport, '宝宝档案', '档案弹窗处于遮罩可用范围', profile.modal && profile.dialog.left >= 0 && profile.dialog.right <= viewport.width && profile.dialog.top >= 0 && profile.dialog.bottom <= viewport.height && profile.scrollWidth <= profile.clientWidth + 1, profile)
    record(viewport, '宝宝档案', '头像区和固定保存取消按钮可直接操作', await page.locator('.profile-avatar-section').count() === 1 && profile.actions.length === 2 && profile.actions.every(button => button.left >= profile.dialog.left && button.right <= profile.dialog.right && button.top >= profile.dialog.top && button.bottom <= profile.dialog.bottom), profile)
    const checkboxes = await page.locator('.check-field input').evaluateAll(elements => elements.map(element => ({ width: element.getBoundingClientRect().width, height: element.getBoundingClientRect().height })))
    record(viewport, '宝宝档案', '复选框尺寸正常', checkboxes.every(item => item.width >= 10 && item.width <= 24 && item.height >= 10 && item.height <= 24), checkboxes)
    await page.getByLabel('出生日期', { exact: true }).click()
    await page.locator('.n-date-panel--date:visible').waitFor()
    await settle(page)
    const birthdayCalendar = await page.locator('.n-date-panel--date:visible').boundingBox()
    record(viewport, '中文日期组件', '中文日历完整可见且避开原生标题区', Boolean(birthdayCalendar && birthdayCalendar.x >= 0 && birthdayCalendar.x + birthdayCalendar.width <= viewport.width + 1 && birthdayCalendar.y >= 56 && birthdayCalendar.y + birthdayCalendar.height <= viewport.height + 1), birthdayCalendar)
    record(viewport, '中文日期组件', '周一开始且日历保留生日年月日', await page.locator('.n-date-panel-weekdays__day').first().innerText() === '一' && await page.getByLabel('出生日期', { exact: true }).inputValue() === profileBeforeEditing.birthday)
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-birthday-calendar`)
    await page.keyboard.press('Escape')
    record(viewport, '中文日期组件', '关闭日历保留档案并恢复日期输入焦点', await page.locator('.n-date-panel--date:visible').count() === 0 && await page.getByRole('dialog', { name: '宝宝档案', exact: true }).isVisible() && await page.getByLabel('出生日期', { exact: true }).evaluate(element => element === document.activeElement))
    const avatarQueriesBefore = await page.evaluate(() => window.__layoutFixtures.calls.length)
    const avatarPhotoTotal = await page.evaluate(() => window.__layoutFixtures.assets.filter(asset => asset.kind === 'photo' && asset.locations.some(location => location.libraryId === 'library-one')).length)
    await page.locator('.baby-profile-dialog').getByRole('button', { name: '选择照片', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.profile-avatar-grid button').length === 24)
    await settle(page)
    const picker = await babyProfileBounds(page)
    record(viewport, '宝宝头像选图', '首批只查询当前库的24张照片，不依赖人脸或宝宝归属', await page.evaluate(index => window.__layoutFixtures.calls.slice(index).some(query => query.libraryId === 'library-one' && query.kind === 'photo' && query.limit === 24 && !query.babyId && !query.personId), avatarQueriesBefore) && await page.locator('.profile-avatar-grid').getByRole('button', { name: `使用 ${pendingAvatar.filename} 作为头像`, exact: true }).count() === 1, picker)
    record(viewport, '宝宝头像选图', '长文件名在网格内省略或换行且选图区域独立滚动', picker.gridScrollHeight > picker.gridClientHeight && picker.grid.height <= 261 && picker.gridScrollWidth <= picker.gridClientWidth + 1 && picker.bodyScrollWidth <= picker.bodyClientWidth + 1 && picker.scrollWidth <= picker.clientWidth + 1, picker)
    await page.locator('.profile-avatar-grid').evaluate(grid => { grid.scrollTop = grid.scrollHeight })
    await settle(page)
    const pickerScrolled = await babyProfileBounds(page)
    record(viewport, '宝宝头像选图', '滚动照片时保存取消栏保持位置并始终可达', Math.abs(pickerScrolled.footer.top - picker.footer.top) <= 1 && Math.abs(pickerScrolled.bodyScrollTop - picker.bodyScrollTop) <= 1 && pickerScrolled.actions.every(button => button.top >= 0 && button.bottom <= viewport.height), { before: picker, after: pickerScrolled })
    await page.locator('.profile-avatar-picker').getByRole('button', { name: /加载更多/ }).click()
    await page.waitForFunction(total => document.querySelectorAll('.profile-avatar-grid button').length === total, avatarPhotoTotal)
    record(viewport, '宝宝头像选图', '加载下一页保留首批并显示当前库全部照片', await page.evaluate(index => window.__layoutFixtures.calls.slice(index).some(query => query.libraryId === 'library-one' && query.kind === 'photo' && query.page === 2 && query.limit === 24), avatarQueriesBefore) && await page.locator('.profile-avatar-grid button').count() === avatarPhotoTotal)
    await page.locator('.profile-avatar-grid').getByRole('button', { name: `使用 ${pendingAvatar.filename} 作为头像`, exact: true }).click()
    record(viewport, '宝宝头像选图', '选择尚未分析人脸的照片只更新唯一草稿头像', await page.locator('.profile-avatar-grid button[aria-pressed="true"]').count() === 1 && await page.evaluate(before => JSON.stringify(window.__layoutFixtures.family.babies[0]) === JSON.stringify(before), profileBeforeEditing))
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-baby-profile-avatar`)
    if (viewport.width === 1180 || viewport.width === 390) await page.mouse.click(1, 1)
    else await page.locator('.baby-profile-footer').getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('.baby-profile-dialog').waitFor({ state: 'detached' })
    record(viewport, '宝宝头像选图', '取消档案编辑保留原头像与全部人脸参考', await page.evaluate(before => JSON.stringify(window.__layoutFixtures.family.babies[0]) === JSON.stringify(before), profileBeforeEditing))
    await page.locator('.baby-profile-banner').getByRole('button', { name: '更换宝宝头像', exact: true }).click()
    await page.waitForFunction(() => document.querySelectorAll('.profile-avatar-grid button').length === 24)
    await page.locator('.profile-avatar-grid').getByRole('button', { name: `使用 ${pendingAvatar.filename} 作为头像`, exact: true }).click()
    await page.locator('.baby-profile-footer').getByRole('button', { name: '保存宝宝档案', exact: true }).click()
    await page.locator('.baby-profile-dialog').waitFor({ state: 'detached' })
    record(viewport, '宝宝头像保存', '保存照片头像后保留原昵称出生日期及识别参考', await page.evaluate(({ before, id }) => { const current = window.__layoutFixtures.family.babies[0]; return current.avatarAssetId === id && current.name === before.name && current.birthday === before.birthday && JSON.stringify(current.referenceFaces) === JSON.stringify(before.referenceFaces) }, { before: profileBeforeEditing, id: pendingAvatar.id }))
    await page.waitForFunction(({ width, height }) => { const image = document.querySelector('.baby-profile-banner .photo-avatar img'); return image?.naturalWidth === width && image.naturalHeight === height }, pendingAvatar)
    record(viewport, '宝宝头像保存', '宝宝栏实际显示所选照片缩略图，不依赖人脸头像', await page.locator('.baby-profile-banner .photo-avatar img').count() === 1)
    await page.locator('.baby-profile-banner').getByRole('button', { name: '新建档案', exact: true }).click()
    await page.locator('.baby-profile-dialog').waitFor()
    record(viewport, '宝宝档案入口', '新建入口直接打开空白档案，取消后不替换现有宝宝', (await page.locator('.baby-profile-title h2').innerText()) === '建立宝宝档案' && (await page.locator('#baby-profile-form input[maxlength="32"]').inputValue()) === '')
    await page.locator('.baby-profile-footer').getByRole('button', { name: '取消', exact: true }).click()
    await page.locator('.baby-profile-dialog').waitFor({ state: 'detached' })
    record(viewport, '宝宝档案入口', '取消新建继续展示已保存头像与原宝宝档案', await page.evaluate(id => window.__layoutFixtures.family.babies.length === 1 && window.__layoutFixtures.family.babies[0].avatarAssetId === id, pendingAvatar.id))

    // 成长水印使用原生模态，更多设置只滚动编辑内容，不移动保存与关闭按钮。
    await page.locator('.media-cover').first().click()
    await page.locator('.media-dialog').waitFor()
    await page.locator('.preview-header-actions').getByRole('button', { name: '成长水印', exact: true }).click()
    const growthEditor = page.getByRole('dialog', { name: '成长水印', exact: true })
    await growthEditor.waitFor()
    await page.waitForFunction(() => document.querySelector('.growth-editor-stage img')?.naturalWidth > 0 && document.querySelector('.growth-editor-stage')?.getAttribute('aria-busy') === 'false')
    await settle(page)
    const growthBounds = () => growthEditor.evaluate(editor => {
      const bounds = element => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } }
      return { modal: editor.getAttribute('role') === 'dialog' && editor.getAttribute('aria-modal') === 'true', editor: bounds(editor), width: editor.clientWidth, scrollWidth: editor.scrollWidth, bodyWidth: editor.querySelector('.growth-editor-body').clientWidth, bodyScrollWidth: editor.querySelector('.growth-editor-body').scrollWidth, footer: bounds(editor.querySelector('.growth-editor-footer')), close: bounds(editor.querySelector('[aria-label="关闭成长水印"]')), save: bounds(editor.querySelector('.growth-export-button')), advanced: editor.querySelector('.growth-more-settings').open }
    })
    const growth = await growthBounds()
    record(viewport, '成长水印', '编辑器原生模态且默认设置收起', growth.modal && !growth.advanced)
    record(viewport, '成长水印', '长文件名与窄窗口不撑宽编辑器', growth.editor.left >= 0 && growth.editor.right <= viewport.width && growth.editor.top >= 0 && growth.editor.bottom <= viewport.height && growth.scrollWidth <= growth.width + 1 && growth.bodyScrollWidth <= growth.bodyWidth + 1, growth)
    record(viewport, '成长水印', '保存与关闭直接可见且不进入原生顶栏', growth.close.top >= 56 && growth.close.bottom <= viewport.height && growth.save.top >= growth.editor.top && growth.save.bottom <= growth.editor.bottom, growth)
    await growthEditor.locator('.growth-more-settings summary').click()
    await settle(page)
    const expandedGrowth = await growthBounds()
    record(viewport, '成长水印', '展开更多设置保持保存与关闭可见', expandedGrowth.close.top >= 56 && expandedGrowth.save.bottom <= viewport.height && expandedGrowth.bodyScrollWidth <= expandedGrowth.bodyWidth + 1, expandedGrowth)
    await growthEditor.locator('.growth-more-settings summary').click()
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-growth-watermark`)
    await growthEditor.getByRole('button', { name: '取消', exact: true }).click()
    await growthEditor.waitFor({ state: 'detached' })
    record(viewport, '成长水印', '取消只关闭水印编辑并恢复原照片', await page.locator('.media-dialog').count() === 1)
    await page.locator('.media-dialog').getByRole('button', { name: '关闭预览', exact: true }).click()

    // 匹配结果联合已加入与待确认，人工排除仍不出现在联合结果中。
    await page.getByRole('button', { name: '用照片查找', exact: true }).click()
    await page.getByRole('button', { name: '查找宝宝照片', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button',{name:'疑似 5',exact:true}).waitFor()
    record(viewport,'宝宝默认结果','成长相册默认混合已加入和疑似且范围明确',await page.evaluate(()=>window.__layoutFixtures.calls.some(query=>query.includeCandidates===true&&query.babyId==='baby-one')) && await selectControl(page,'宝宝查找范围').getAttribute('data-value')==='library')
    await page.locator('.baby-tools button[aria-expanded]').click()
    await page.getByRole('button',{name:'全部匹配结果',exact:true}).click()
    await page.locator('.baby-match-context').filter({ hasText: '全部匹配 50 项' }).waitFor()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length > 0 && document.querySelectorAll('.media-card').length < 50)
    await checkFrame(page, viewport, '宝宝匹配结果')
    record(viewport, '宝宝匹配结果', '全部结果区分45项已加入与5项待确认，另2项不混入匹配结果', (await page.locator('.baby-match-context').innerText()).includes('已加入 45 项') && (await page.locator('.baby-match-context').innerText()).includes('待确认 5 项') && await page.evaluate(() => window.__layoutFixtures.calls.some(query => query.includeCandidates === true && query.babyId === 'baby-one')))
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-baby-matches`)
    await page.locator('.baby-match-context').getByRole('button', { name: '待确认 5 项', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions')?.textContent.includes('已加载 5 项'))
    await page.locator('.media-date-groups').scrollIntoViewIfNeeded(); await settle(page)
    record(viewport, '宝宝匹配结果', '待确认入口只展示候选并保留返回全部匹配', await page.locator('.media-candidate').filter({hasText:'疑似'}).count()===await page.locator('.media-card').count() && await page.getByRole('button', { name: '查看全部匹配', exact: true }).isVisible())
    await page.getByRole('button', { name: '查看全部匹配', exact: true }).click()
    await page.locator('.baby-match-context').filter({ hasText: '全部匹配 50 项' }).waitFor()
    await page.locator('.baby-match-context').getByRole('button', { name: '已加入 45 项', exact: true }).click()
    await page.locator('.baby-result-filter').getByRole('button',{name:'已加入 45',exact:true}).click()
    await page.waitForFunction(() => document.querySelectorAll('.media-card').length > 0 && document.querySelector('.baby-result-filter .selected')?.textContent.includes('已加入'))
    record(viewport, '宝宝匹配结果', '已加入筛选只展示归属照片，默认相册仍保留疑似入口', await page.evaluate(()=>window.__layoutFixtures.calls.some(query=>query.babyId==='baby-one'&&!query.includeCandidates&&!query.candidates)) && await page.locator('.media-candidate').filter({hasText:'疑似'}).count()===0)

    // 未能识别的照片仍可核对，旧自动排除不能冒充人工排除。
    await page.locator('.baby-result-filter').getByRole('button', { name: '待核对 1', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.month-group-actions')?.textContent.includes('已加载 1 项'))
    await page.locator('.media-date-groups').scrollIntoViewIfNeeded(); await settle(page)
    await checkFrame(page, viewport, '宝宝待核对')
    record(viewport, '宝宝待核对', '旧自动排除仍展示且不混入人工排除', await page.locator('.media-card').count() === 1 && (await page.locator('.media-candidate').innerText()) === '待核对' && await page.evaluate(() => window.__layoutFixtures.calls.some(query => query.unconfirmed === true && query.babyId === 'baby-one')))
    await page.locator('.media-cover').first().click()
    const reviewPreview = page.locator('.media-dialog')
    await reviewPreview.waitFor()
    record(viewport, '宝宝待核对', '无脸照片可直接确认且不能设为人脸参考', await reviewPreview.getByRole('button', { name: '是宝宝', exact: true }).isEnabled() && await reviewPreview.getByRole('button', { name: '不是宝宝', exact: true }).isEnabled() && await reviewPreview.getByRole('button', { name: '确认并设为参考', exact: true }).isDisabled())
    await reviewPreview.getByRole('button', { name: '照片信息', exact: true }).click()
    await reviewPreview.locator('.detail-metadata').waitFor()
    record(viewport, '宝宝待核对', '按需信息解释无脸原因并保留人工核对', (await reviewPreview.locator('.detail-metadata').innerText()).includes('未检测到人脸，可直接人工核对。'))
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-baby-unconfirmed`)
    await reviewPreview.getByRole('button', { name: '关闭预览', exact: true }).click()

    // 多张参考使用等比原图选脸，窄窗口中的保存与跳过仍可操作。
    await page.locator('.baby-tools button[aria-expanded]').click()
    await page.getByRole('button',{name:'成长时间线',exact:true}).click()
    await page.getByRole('button', { name: '用照片查找', exact: true }).click()
    await page.getByRole('button', { name: '选择参考照片', exact: true }).click()
    await page.locator('.media-cover').nth(0).click()
    await page.locator('.media-cover').nth(1).click()
    await page.getByRole('button', { name: '逐张选择宝宝人脸', exact: true }).click()
    await page.locator('.reference-picker-mode .detail-media-stage img').waitFor()
    for (const [index, ratio] of [[1, .75], [2, 1.5]]) {
      await page.waitForFunction(() => { const image = document.querySelector('.reference-picker-mode .detail-media-stage img'); return image?.complete && image.naturalWidth > 0 })
      await settle(page)
      const wizard = await page.locator('.reference-picker-mode').evaluate(dialog => {
        const bounds = element => { const value = element.getBoundingClientRect(); return { left: value.left, top: value.top, right: value.right, bottom: value.bottom, width: value.width, height: value.height } }
        const stage = dialog.querySelector('.detail-media-stage'), image = stage.querySelector('img'), face = stage.querySelector('.face-box')
        return { dialog: bounds(dialog), stage: bounds(stage), face: bounds(face), ratio: image.naturalWidth / image.naturalHeight, overflow: dialog.scrollWidth > dialog.clientWidth + 1 }
      })
      record(viewport, '多照片参考', `第${index}张弹窗无溢出且保持原图比例`, !wizard.overflow && wizard.dialog.left >= 0 && wizard.dialog.right <= viewport.width && wizard.dialog.top >= 0 && wizard.dialog.bottom <= viewport.height && Math.abs(wizard.stage.width / wizard.stage.height - ratio) < .01 && Math.abs(wizard.ratio - ratio) < .01, wizard)
      record(viewport, '多照片参考', `第${index}张人脸框跟随等比照片`, Math.abs(wizard.face.left - (wizard.stage.left + wizard.stage.width * .2)) < 2 && Math.abs(wizard.face.top - (wizard.stage.top + wizard.stage.height * .2)) < 2 && Math.abs(wizard.face.width - wizard.stage.width * .3) < 2 && Math.abs(wizard.face.height - wizard.stage.height * .35) < 2, wizard)
      record(viewport, '多照片参考', `第${index}张不默认选脸且显示真实进度`, await page.locator('.face-selector button[aria-pressed="true"]').count() === 0 && (await page.locator('.reference-picker-progress').innerText()).includes(`${index} / 2`))
      record(viewport, '多照片参考', `第${index}张仅显示参考队列，不混入普通导航或信息面板`, await page.locator('.reference-picker-mode .preview-navigation,.reference-picker-mode .preview-information').count() === 0 && await page.locator('.reference-picker-mode').getByRole('button', { name: '照片信息', exact: true }).count() === 0 && await page.locator('.reference-picker-mode').getByRole('button', { name: '向右旋转', exact: true }).isDisabled())
      await page.locator('.reference-picker-mode .face-selector button').first().click()
      const save = page.locator('.reference-picker-mode').getByRole('button', { name: '设为宝宝人脸参考', exact: true })
      await save.scrollIntoViewIfNeeded()
      const button = await save.boundingBox()
      record(viewport, '多照片参考', `第${index}张保存按钮可滚动到可见范围`, button && button.x >= 0 && button.y >= 0 && button.x + button.width <= viewport.width && button.y + button.height <= viewport.height, button)
      const faceTools = await page.locator('.reference-picker-mode .preview-face-tools').evaluate(element => { const bounds = element.getBoundingClientRect(); return { top: bounds.top, bottom: bounds.bottom, height: bounds.height, scrollWidth: element.scrollWidth, clientWidth: element.clientWidth } })
      record(viewport, '多照片参考', `第${index}张选脸工具保持紧凑且不横向溢出`, faceTools.height <= viewport.height * .3 + 1 && faceTools.top >= 0 && faceTools.bottom <= viewport.height && faceTools.scrollWidth <= faceTools.clientWidth + 1, faceTools)
      if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-reference-${index}`)
      if (index === 1) { await save.click(); await page.locator('.reference-picker-progress').filter({ hasText: '2 / 2' }).waitFor() }
      else await page.getByRole('button', { name: '跳过这张照片', exact: true }).click()
    }
    await page.locator('.reference-picker-mode').waitFor({ state: 'detached' })

    // 使用真实批次与超长文件名检查摘要和详情，不读取个人传输记录。
    await page.evaluate(() => {
      const fixtures = window.__layoutFixtures
      const filename = `合成接收_${'长文件名用于验证窄窗口'.repeat(12)}.jpg`
      const savedAt = '2026-10-01T02:30:00Z'
      const file = { id: 'receipt-one', filename, size: 1024, relativePath: `2026-10-01/${filename}`, libraryId: 'library-one', savedAt, batchId: 'batch-saved' }
      const task = { id: 'task-waiting', batchId: 'batch-waiting', libraryId: 'library-one', filename, size: 1024, offset: 1024, state: 'committing', error: '', updatedAt: savedAt, archiveDate: '2026-10-01' }
      fixtures.receiver.files = [file]
      fixtures.receiver.sessions = [task, { ...task, id: 'task-reused', batchId: 'batch-reused', state: 'complete', receipt: { ...file } }]
    })
    await page.locator('.module-navigation').getByRole('button', { name: '导入与归档', exact: true }).click()
    await page.locator('.transfer-row').filter({ hasText: '待处理 1' }).waitFor()
    await checkFrame(page, viewport, '批次摘要')
    if (viewport.width === 1180) await screenshot(page, '1180-transfer-overview')
    await page.locator('.transfer-row').filter({ hasText: '待处理 1' }).click()
    await page.getByRole('heading', { name: '批次详情', exact: true }).waitFor()
    await page.locator('.transfer-task summary').click()
    await checkFrame(page, viewport, '批次详情')
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-transfer-detail`)

    // 完整跳过原因按页展示，长路径和大量错误不能撑宽或占满整个页面。
    await page.evaluate(() => {
      const fixtures = window.__layoutFixtures
      const warnings = Array.from({ length: 27 }, (_, index) => `C:/合成图库/${'长文件夹/'.repeat(12)}${index + 1}/同名照片.jpg：文件无法读取，已跳过并继续后续文件。`)
      fixtures.warningRecords = { 'scan-warning-job': warnings }
      fixtures.family.jobs = [{ id: 'scan-warning-job', libraryId: 'library-one', kind: 'scan', state: 'done', processed: 52, total: 79, skipped: 27, duplicates: 4, warnings: warnings.slice(0, 20), warningReportId: 'scan-warning-job', label: '合成扫描', error: '' }]
    })
    await page.locator('.module-navigation').getByRole('button', { name: '照片与视频', exact: true }).click()
    record(viewport, '跳过明细', '新增跳过记录不会自动铺在照片底部或弹出详情', await page.locator('.processing-records-dialog,.family-jobs,.processing-report').count() === 0)
    await openProcessingRecords(page)
    await page.getByRole('button', { name: '查看全部跳过原因（27）', exact: true }).click()
    await page.locator('.warning-pages').filter({ hasText: '共 27 条' }).waitFor()
    await checkFrame(page, viewport, '跳过明细')
    const warningDialogBounds = await processingDialogBounds(page)
    record(viewport, '跳过明细', '展开明细后弹窗仍在视口且内部不横向溢出', warningDialogBounds.dialog.left >= 0 && warningDialogBounds.dialog.right <= viewport.width && warningDialogBounds.dialog.top >= 0 && warningDialogBounds.dialog.bottom <= viewport.height && warningDialogBounds.dialogScrollWidth <= warningDialogBounds.dialogWidth + 1 && warningDialogBounds.bodyScrollWidth <= warningDialogBounds.bodyWidth + 1, warningDialogBounds)
    const warningBounds = await page.locator('.processing-report').evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth, listHeight: element.querySelector('ul').getBoundingClientRect().height }))
    record(viewport, '跳过明细', '长路径无水平溢出且列表高度受限', warningBounds.scrollWidth <= warningBounds.width + 1 && warningBounds.listHeight <= 221, warningBounds)
    record(viewport, '跳过明细', '结果明确成功跳过与同内容合并', (await page.locator('.family-jobs').innerText()).includes('部分完成 · 成功 52 项 · 跳过 27 项') && (await page.locator('.family-jobs').innerText()).includes('相同内容合并 4 项'))
    await page.locator('.warning-pages').getByRole('button', { name: '下一页', exact: true }).click()
    await page.locator('.warning-pages').filter({ hasText: '第 2 / 2 页' }).waitFor()
    record(viewport, '跳过明细', '第二页完整展示第21至27条', await page.locator('.processing-report .processing-warnings li').count() === 7 && (await page.locator('.processing-report').innerText()).includes('27/同名照片.jpg'))
    await page.locator('.processing-report').scrollIntoViewIfNeeded()
    if (viewport.width === 1180 || viewport.width === 390) await screenshot(page, `${viewport.width}-scan-warnings`)
    await page.getByRole('button', { name: '关闭处理记录', exact: true }).click()
    await page.locator('.processing-records-dialog').waitFor({ state: 'detached' })
    record(viewport, '跳过明细', '关闭后不再留下跳过列表或分页到图库底部', await page.locator('.family-jobs,.processing-report,.warning-pages').count() === 0)
    await page.close()
  }

  // 大图库仅提供合成索引，折叠月份继续分页但不生成数千个隐藏照片节点。
  const largeViewport = { width: 1180, height: 800 }
  const largePage = await browser.newPage({ viewport: largeViewport })
  largePage.setDefaultTimeout(20000)
  largePage.on('pageerror', error => report.errors.push({ viewport: largeViewport, message: error.message }))
  await largePage.addInitScript(installFixtures, { assetCount: 2570 })
  await largePage.goto(url, { waitUntil: 'networkidle' })
  await largePage.locator('.media-card').first().waitFor()
  await observeFoldFeedback(largePage)
  const largeScrollBeforeCollapse = await collapseFromScrolledContent(largePage)
  await waitForFoldCompletion(largePage)
  await largePage.waitForFunction(() => document.querySelector('.media-load-more')?.textContent.includes('已加载当前索引的全部 2570 项'))
  await settle(largePage)
  await checkFrame(largePage, largeViewport, '2570项合成图库折叠')
  record(largeViewport, '2570项合成图库折叠', '折叠加载全部索引而不创建隐藏照片卡片', await largePage.locator('.media-card').count() === 0 && await largePage.locator('.media-grid:visible').count() === 0 && await largePage.locator('.month-group-toggle[aria-expanded="false"]').count() === 5)
  record(largeViewport, '2570项合成图库折叠', '处理中提示可见且收起后内容保持顶部', largeScrollBeforeCollapse > 0 && await largePage.evaluate(() => window.__layoutFoldFeedback.length > 0 && document.querySelector('.page-content').scrollTop <= 1))
  const largeCounts = await largePage.evaluate(() => ({ mediaUrlRequests: window.__layoutFixtures.mediaUrlCalls.length, queryCount: window.__layoutFixtures.calls.length, lastQueryPage: window.__layoutFixtures.calls.at(-1)?.page }))
  record(largeViewport, '2570项合成图库折叠', '按页补齐记录，收起的后续媒体不请求缩略图', largeCounts.queryCount >= 52 && largeCounts.lastQueryPage === 52 && largeCounts.mediaUrlRequests <= 60, largeCounts)
  record(largeViewport, '2570项合成图库折叠', '加载完索引仍提示扫描中断并保留重新扫描入口', (await largePage.locator('.gallery-scan-status').innerText()).includes('中断') && await largePage.getByRole('button', { name: '重新扫描', exact: true }).isVisible())
  await screenshot(largePage, '1180-large-collapsed')
  await largePage.close()
} catch (error) {
  report.errors.push({ message: error.stack ?? String(error) })
} finally {
  await browser?.close()
  await server?.close()
  report.passed = report.failures.length === 0 && report.errors.length === 0
  await mkdir(artifactDirectory, { recursive: true })
  const reportPath = resolve(artifactDirectory, `${label}.json`)
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`)
  console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, failures: report.failures.map(({ viewport, scenario, check }) => ({ viewport, scenario, check })), errors: report.errors, report: reportPath, screenshots: report.screenshots }, null, 2))
  if (!report.passed && !baseline) process.exitCode = 1
}
