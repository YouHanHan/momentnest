import { app, BrowserWindow, dialog, ipcMain, net, protocol, session, shell } from 'electron'
import type { IpcMainInvokeEvent } from 'electron'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AppInfo } from '../shared/desktop-api'
import { ServiceBridge } from './service-bridge'
import QRCode from 'qrcode'
import { extname } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import * as familyValidation from './family-validation'
import { mediaResponse } from './media-response'
import { canonicalUserDataDirectory, migrateUserDataDirectory, userDataDirectory } from './data-directory'

const applicationUrl = 'jinchuan://app/'
const rendererRoot = resolve(__dirname, '../renderer')
let mainWindow: BrowserWindow | null = null
let receiver: ServiceBridge | null = null
let quitting = false
let closeConfirmed = false
let closeConfirmationPending = false
const mediaCapabilities = new Map<string,{assetId:string;thumbnail:boolean;libraryId?:string;expiresAt:number}>()
app.commandLine.appendSwitch('disable-background-networking')
// 本机启动器可沿用预览阶段的配置目录，界面不能修改此路径。
// 日常启动不再接受旧启动器的目录切换参数，开发版与正式版共用持久记录。
const configuredDataDirectory = userDataDirectory(app.getPath('appData'), app.getName(), app.getPath('userData'), app.isPackaged, app.getPath('home'))
const dataDirectory = canonicalUserDataDirectory(configuredDataDirectory)
app.setPath('userData', dataDirectory)
app.setPath('sessionData', dataDirectory)

/** 对仅允许本地页面调用的能力统一校验来源。 */
function handle(channel: string, action: (...args: unknown[]) => unknown): void {
  ipcMain.handle(channel, (event, ...args: unknown[]) => {
    if (quitting) return undefined
    requireTrustedSender(event)
    return action(...args)
  })
}
function identifier(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(value)) throw new Error('记录标识无效。')
  return value
}
function optionalLibrary(value:unknown):string|undefined {return value===undefined?undefined:identifier(value)}

protocol.registerSchemesAsPrivileged([
  { scheme: 'jinchuan', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } },
])

/** 仅允许本地开发服务器作为开发界面来源。 */
function getDevelopmentUrl(): string | undefined {
  if (app.isPackaged) return undefined
  const value = process.env.ELECTRON_RENDERER_URL
  if (!value) return undefined
  const url = new URL(value)
  if (url.origin !== 'http://127.0.0.1:5173') {
    throw new Error('开发界面必须来自指定的本机地址。')
  }
  return url.href
}

/** 校验 IPC 来源，文件接口只向主窗口的顶层页面开放。 */
function requireTrustedSender(event: IpcMainInvokeEvent): BrowserWindow {
  if (!mainWindow || event.sender !== mainWindow.webContents ||
      event.senderFrame !== mainWindow.webContents.mainFrame) {
    throw new Error('拒绝来自未授权窗口的请求。')
  }
  const senderUrl = new URL(event.senderFrame.url)
  const developmentUrl = getDevelopmentUrl()
  const trusted = developmentUrl
    ? senderUrl.origin === new URL(developmentUrl).origin
    : senderUrl.protocol === 'jinchuan:' && senderUrl.host === 'app'
  if (!trusted) throw new Error('拒绝来自未授权页面的请求。')
  return mainWindow
}

/** 只提供打包后的界面资源，阻止请求越出资源目录。 */
function registerRendererProtocol(): void {
  protocol.handle('jinchuan', async (request) => {
    try {
      const url = new URL(request.url)
      if (url.host === 'media') {
        const key=url.pathname.slice(1), grant=mediaCapabilities.get(key)
        if(!grant||grant.expiresAt<Date.now()) return new Response('Not found',{status:404})
        const path=await receiver!.call<string>('mediaPath',grant.assetId,grant.thumbnail,grant.libraryId)
        return await mediaResponse(path,request.method,request.headers.get('range'))
      }
      if (url.host !== 'app') return new Response('Not found', { status: 404 })
      const pathname = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname)
      const filePath = resolve(rendererRoot, `.${pathname}`)
      if (!filePath.toLowerCase().startsWith(`${rendererRoot}${sep}`.toLowerCase())) {
        return new Response('Forbidden', { status: 403 })
      }
      return await net.fetch(pathToFileURL(filePath).href)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  })
}

/** 关闭前询问用户，重复请求共用当前确认框，取消时保留窗口和服务。 */
async function confirmClose(window: BrowserWindow): Promise<void> {
  if (quitting || closeConfirmationPending || window.isDestroyed()) return
  closeConfirmationPending = true
  try {
    const result = await dialog.showMessageBox(window, {
      type: 'question',
      title: '关闭拾光匣',
      message: '是否真的关闭拾光匣？',
      detail: '关闭后将停止接收手机上传，并停止正在进行的处理。',
      buttons: ['取消', '关闭'],
      defaultId: 0,
      cancelId: 0,
      noLink: true,
    })
    if (result.response === 1 && !window.isDestroyed() && !quitting) {
      closeConfirmed = true
      app.quit()
    }
  } catch (error) {
    console.error('关闭确认未完成：', error)
  } finally {
    closeConfirmationPending = false
  }
}

/** 再次打开应用时恢复已有窗口，避免后台实例占用锁却没有界面响应。 */
function showWindow(window: BrowserWindow | null = mainWindow): void {
  if (!window || window.isDestroyed()) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
}

/** 创建隔离的桌面窗口，并加载本地界面。 */
async function createWindow(): Promise<void> {
  const window = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 820,
    minHeight: 600,
    title: '拾光匣',
    icon: app.isPackaged
      ? join(process.resourcesPath, 'app', 'assets', 'branding', 'jinchuan.ico')
      : resolve(__dirname, '../../../../assets/branding/jinchuan.ico'),
    backgroundColor: '#FEFEFE',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#fafbfa', symbolColor: '#65706a', height: 56 },
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  mainWindow = window
  window.once('ready-to-show', () => showWindow(window))
  window.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    void confirmClose(window)
  })
  window.on('closed', () => { mainWindow = null })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  await window.loadURL(getDevelopmentUrl() ?? applicationUrl)
}

/** 注册启动期能力，后续的照片接收服务独立接入。 */
async function start(): Promise<void> {
  await app.whenReady()
  if (configuredDataDirectory === resolve(app.getPath('home'), '.jinchuan')) migrateUserDataDirectory(app.getPath('appData'), dataDirectory)
  // 发布界面完全使用本地资源；开发模式也只允许固定回环服务器。
  await session.defaultSession.setProxy({mode:'direct'})
  session.defaultSession.webRequest.onBeforeRequest({urls:['http://*/*','https://*/*','ws://*/*','wss://*/*']},(details,callback)=>{
    const url=new URL(details.url)
    const development=!app.isPackaged && ['http:','ws:'].includes(url.protocol) && url.hostname==='127.0.0.1' && url.port==='5173'
    callback({cancel:!development})
  })
  const modelDirectory=app.isPackaged?join(process.resourcesPath,'app','models'):resolve(__dirname,'../../../..','models')
  receiver = new ServiceBridge(join(app.getPath('userData'), 'receiver'),modelDirectory)
  await receiver.ready
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  registerRendererProtocol()
  ipcMain.handle('app:get-info', (event): AppInfo => {
    requireTrustedSender(event)
    return { version: app.getVersion(), platform: process.platform }
  })
  ipcMain.handle('directories:select', async (event, multiple: unknown): Promise<string[]> => {
    const window = requireTrustedSender(event)
    if (typeof multiple !== 'boolean') throw new Error('目录选择参数无效。')
    const result = await dialog.showOpenDialog(window, {
      title: multiple ? '选择历史照片目录' : '选择新照片保存目录',
      properties: multiple ? ['openDirectory', 'multiSelections'] : ['openDirectory'],
    })
    return result.canceled ? [] : result.filePaths
  })
  handle('receiver:state', () => receiver!.call('snapshot'))
  handle('receiver:current-library',(id)=>receiver!.call('setCurrentLibrary',identifier(id)))
  handle('receiver:add-directories', async (kind) => {
    if (kind !== 'library' && kind !== 'root') throw new Error('目录类型无效。')
    const result = await dialog.showOpenDialog(mainWindow!, {title: kind === 'root' ? '添加历史照片目录' : '选择当前照片库', properties: kind === 'root' ? ['openDirectory', 'multiSelections'] : ['openDirectory']})
    if (result.canceled) return
    for (const path of result.filePaths) {
      const id = await receiver!.call('addDirectory', path, kind)
      if (kind === 'library') await receiver!.call('setCurrentLibrary', id)
    }
  })
  handle('receiver:toggle-directory', (kind, id, enabled) => {
    if ((kind !== 'library' && kind !== 'root') || typeof enabled !== 'boolean') throw new Error('目录参数无效。')
    return receiver!.call('toggleDirectory', kind, identifier(id), enabled)
  })
  handle('receiver:scan', () => receiver!.call('scan'))
  handle('receiver:accept', (value) => {
    if (typeof value !== 'boolean') throw new Error('接收参数无效。')
    return receiver!.call('accept', value)
  })
  handle('receiver:pair', async () => {
    const info = await receiver!.call<{addresses:string[];expiresAt:number}>('pair')
    const payload = JSON.stringify(info)
    return {payload, qr: await QRCode.toDataURL(payload, {width: 300, margin: 2}), expiresAt: info.expiresAt, addresses: info.addresses}
  })
  handle('receiver:revoke', (id) => receiver!.call('revoke', identifier(id)))
  handle('receiver:reveal', async (id) => shell.showItemInFolder(await receiver!.call<string>('storedPath', identifier(id))))
  handle('receiver:preview', async (id) => {
    const path = await receiver!.call<string>('storedPath', identifier(id))
    const mime:Record<string,string> = {'.jpg':'image/jpeg','.jpeg':'image/jpeg','.jpe':'image/jpeg','.jfif':'image/jpeg','.png':'image/png','.webp':'image/webp','.gif':'image/gif','.avif':'image/avif'}
    const type = mime[extname(path).toLowerCase()]
    if (!type) throw new Error('此格式已按原图保存，预览请使用系统图片查看器。')
    if ((await stat(path)).size > 32*1024**2) throw new Error('大图请在文件夹中使用系统查看器预览。')
    return `data:${type};base64,${(await readFile(path)).toString('base64')}`
  })
  handle('family:state',(libraryId)=>receiver!.call('familyState',optionalLibrary(libraryId)))
  handle('family:job-warnings',(jobId,page,libraryId)=>receiver!.call('getJobWarnings',identifier(jobId),familyValidation.warningPage(page),optionalLibrary(libraryId)))
  handle('family:query',(query)=>receiver!.call('queryMedia',familyValidation.query(query)))
  handle('family:similar-query',(query)=>receiver!.call('querySimilarFaces',familyValidation.similarQuery(query)))
  handle('family:scan',(libraryId)=>receiver!.call('scanMedia',optionalLibrary(libraryId)))
  handle('family:prepare-import',(rootId,mode,libraryId)=>{
    if(mode!=='index'&&mode!=='copy') throw new Error('导入方式无效。')
    return receiver!.call('prepareImport',identifier(rootId),mode,libraryId===undefined?undefined:identifier(libraryId))
  })
  handle('family:execute-import',(planId)=>receiver!.call('executeImport',identifier(planId)))
  handle('family:media-url',async(assetId,thumbnail,libraryId)=>{
    const checked=identifier(assetId)
    const checkedLibrary=optionalLibrary(libraryId)
    if(typeof thumbnail!=='boolean') throw new Error('预览参数无效。')
    await receiver!.call('mediaPath',checked,thumbnail,checkedLibrary)
    for(const [key,value] of mediaCapabilities) if(value.expiresAt<Date.now()) mediaCapabilities.delete(key)
    if(mediaCapabilities.size>10000) throw new Error('预览数量过多，请关闭后重新打开相册。')
    const key=randomUUID();mediaCapabilities.set(key,{assetId:checked,thumbnail,libraryId:checkedLibrary,expiresAt:Date.now()+2*60*60*1000})
    return `jinchuan://media/${key}`
  })
  handle('family:reveal',async(assetId,libraryId)=>shell.showItemInFolder(await receiver!.call<string>('mediaPath',identifier(assetId),false,optionalLibrary(libraryId))))
  handle('family:save-baby',(baby,matchScope)=>receiver!.call('saveBaby',familyValidation.baby(baby),familyValidation.optionalMatchScope(matchScope)))
  handle('family:membership',(babyId,assetIds,included)=>receiver!.call('setBabyMembership',identifier(babyId),familyValidation.ids(assetIds),familyValidation.bool(included)))
  handle('family:date',(assetId,date)=>receiver!.call('setMediaDate',identifier(assetId),familyValidation.date(date)))
  handle('family:favorite',(assetId,favorite)=>receiver!.call('setFavorite',identifier(assetId),familyValidation.bool(favorite)))
  handle('family:analyze',(libraryId,retryOnlyFailed)=>receiver!.call('analyzeFaces',optionalLibrary(libraryId),retryOnlyFailed===undefined?false:familyValidation.bool(retryOnlyFailed)))
  handle('family:rebuild-face-index',libraryId=>receiver!.call('rebuildFaceIndex',identifier(libraryId)))
  handle('family:supplement-faces',(libraryId)=>receiver!.call('supplementFaces',optionalLibrary(libraryId)))
  handle('family:name-person',(personId,name)=>receiver!.call('namePerson',identifier(personId),familyValidation.text(name)))
  handle('family:merge-persons',(sourceId,targetId,libraryId)=>receiver!.call('mergePersons',identifier(sourceId),identifier(targetId),identifier(libraryId)))
  handle('family:prepare-person-grouping',libraryId=>receiver!.call('preparePersonGrouping',identifier(libraryId)))
  handle('family:apply-person-grouping',(planId,libraryId,sourceIds)=>receiver!.call('applyPersonGrouping',identifier(planId),identifier(libraryId),familyValidation.groupingIds(sourceIds)))
  handle('family:undo-person-grouping',(token,libraryId)=>receiver!.call('undoPersonGrouping',identifier(token),identifier(libraryId)))
  handle('family:reference',(babyId,assetId,faceId)=>receiver!.call('setBabyReference',identifier(babyId),identifier(assetId),identifier(faceId)))
  handle('family:match-baby',(babyId,libraryId,scope)=>receiver!.call('matchBaby',identifier(babyId),optionalLibrary(libraryId),familyValidation.matchScope(scope,libraryId)))
  handle('family:preview-watermark',(assetId,options,libraryId)=>receiver!.call('previewWatermark',identifier(assetId),familyValidation.watermark(options),optionalLibrary(libraryId)))
  handle('family:export-watermark',async(assetIds,options,libraryId)=>{
    const checkedIds=familyValidation.ids(assetIds),checkedOptions=familyValidation.watermark(options)
    const checkedLibrary=optionalLibrary(libraryId)
    const result=await dialog.showOpenDialog(mainWindow!,{title:'选择水印副本导出目录',properties:['openDirectory','createDirectory']})
    if(result.canceled||!result.filePaths[0]) return []
    return receiver!.call('exportWatermark',checkedIds,checkedOptions,result.filePaths[0],checkedLibrary)
  })
  await createWindow()
  // 仅本机明确传入维护开关时重建，普通启动不会清理已有识别缓存。
  if (app.commandLine.hasSwitch('jinchuan-rebuild-face-index')) {
    try {
      const state = await receiver!.call<{ currentLibraryId: string | null; currentLibraryAvailable: boolean }>('snapshot')
      if (!state.currentLibraryId || !state.currentLibraryAvailable) throw new Error('当前照片库不可用，不能重建人脸索引。')
      await receiver!.call('rebuildFaceIndex', identifier(state.currentLibraryId))
    } catch (error) {
      dialog.showErrorBox('人脸索引重建未开始', error instanceof Error ? error.message : '请在人物管理中重试。')
    }
  }
  app.on('activate', () => {
    if (quitting) return
    if (BrowserWindow.getAllWindows().length === 0) void createWindow().catch(console.error)
    else showWindow()
  })
}

app.on('before-quit', (event) => {
  if (quitting) return
  if (!closeConfirmed && mainWindow && !mainWindow.isDestroyed()) {
    event.preventDefault()
    void confirmClose(mainWindow)
    return
  }
  if (!receiver) return
  event.preventDefault()
  quitting = true
  // 先停止界面轮询，再关闭服务，避免退出期间读取已经关闭的数据库。
  mainWindow?.destroy()
  void receiver.close().catch(console.error).finally(() => app.quit())
})

app.on('window-all-closed', () => {
  if (!quitting && process.platform !== 'darwin') app.quit()
})
app.on('second-instance', () => { if (!quitting) showWindow() })
if (!app.requestSingleInstanceLock()) app.quit()
else void start().catch((error: unknown) => {
  console.error('拾光匣启动失败：', error)
  dialog.showErrorBox('拾光匣启动失败', error instanceof Error ? error.message : '请重新打开应用。')
  app.quit()
})
