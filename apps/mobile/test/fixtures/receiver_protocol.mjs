import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { createInterface } from 'node:readline'
import sharp from 'sharp'
import { Receiver } from '../../../desktop/src/service/receiver.ts'

// 仅使用独立合成目录与随机回环端口，测试不会连接用户接收端。
const directory = await mkdtemp(join(tmpdir(), 'momentnest-dart-protocol-'))
const state = join(directory, 'state'), library = join(directory, 'library'), sources = join(directory, 'sources')
await Promise.all([state, library, sources].map(path => mkdir(path)))
const receiver = new Receiver(state)
const libraryId = await receiver.addDirectory(library, 'library')
receiver.setCurrentLibrary(libraryId)
await receiver.start(0, '127.0.0.1')
const faults = process.argv.includes('--faults')
const chunks = [], dropped = [], firstResponses = []
let firstWave = true, activeChunks = 0, maximumChunks = 0, scanStarted = false, waveTimeout
const flushFirstWave = () => {
  firstWave = false
  clearTimeout(waveTimeout)
  for (const send of firstResponses.splice(0)) send()
}

// 在真实落盘后丢弃响应，覆盖客户端尚未确认但电脑已保存的断点。
receiver.server.prependListener('request', (request, response) => {
  const url = new URL(request.url, 'https://127.0.0.1')
  const match = /^\/v1\/uploads\/([^/]+)\/(content|complete)$/.exec(url.pathname)
  if (!match) return
  const session = receiver.store.get('session', match[1])
  if (!session) return
  const chunk = request.method === 'PUT' && match[2] === 'content'
  if (chunk) {
    chunks.push({ task: session.clientKey, offset: Number(url.searchParams.get('offset')) })
    activeChunks++; maximumChunks = Math.max(maximumChunks, activeChunks)
    response.once('close', () => { activeChunks-- })
  }
  const originalEnd = response.end.bind(response)
  response.end = (...args) => {
    const finish = () => {
      if (request.method === 'POST' && match[2] === 'complete' && !scanStarted) {
        scanStarted = true
        receiver.family.scanMedia(libraryId)
      }
      const key = chunk && session.clientKey === 'photo-0' && Number(url.searchParams.get('offset')) === 0 ? 'chunk'
        : request.method === 'POST' && session.clientKey === 'photo-1' && match[2] === 'complete' ? 'receipt' : undefined
      if (faults && key && !dropped.includes(key)) { dropped.push(key); response.destroy() }
      else originalEnd(...args)
    }
    if (chunk && firstWave) {
      firstResponses.push(finish)
      waveTimeout ??= setTimeout(flushFirstWave, 3000)
      if (firstResponses.length === 3) flushFirstWave()
    } else finish()
    return response
  }
})

const files = []
for (let index = 0; index < 11; index++) {
  const png = await sharp({ create: { width: 48, height: 32, channels: 3, background: { r: index * 21, g: 140, b: 230 - index * 20 } } }).png().toBuffer()
  const bytes = index < 3 ? Buffer.concat([png, Buffer.alloc(4 * 1024 * 1024 + index + 31, index)]) : png
  const path = join(sources, `${index}.png`)
  await writeFile(path, bytes)
  files.push({ id: `photo-${index}`, path, hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })
}
files.push({ ...files[0], id: 'photo-11' })
process.stdout.write(JSON.stringify({ ready: true, address: `https://127.0.0.1:${receiver.port}`, pairing: receiver.pairInfo(), libraryId, files }) + '\n')

const input = createInterface({ input: process.stdin })
for await (const line of input) {
  const command = JSON.parse(line)
  try {
    if (command.method === 'close') {
      flushFirstWave()
      await receiver.close()
      process.stdout.write(JSON.stringify({ id: command.id, value: true }) + '\n')
      input.close(); break
    }
    if (command.method !== 'inspect') throw new Error('未知测试命令')
    const saved = receiver.store.list('file')
    const hashes = await Promise.all(saved.map(async receipt => ({ id: receipt.id, hash: createHash('sha256').update(await readFile(join(library, receipt.relativePath))).digest('hex'), size: receipt.size, relativePath: receipt.relativePath })))
    process.stdout.write(JSON.stringify({ id: command.id, value: { dropped, chunks, maximumChunks, sessions: receiver.store.list('session'), saved, hashes, media: receiver.family.queryMedia({ libraryId, limit: 100 }), jobs: (await receiver.family.familyState(libraryId)).jobs } }) + '\n')
  } catch (error) { process.stdout.write(JSON.stringify({ id: command.id, error: error.message }) + '\n') }
}
