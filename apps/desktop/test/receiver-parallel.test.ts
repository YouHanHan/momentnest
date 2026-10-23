import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createHash, randomUUID } from 'node:crypto'
import { Agent, request } from 'node:https'
import { Receiver } from '../src/service/receiver.ts'
import type { Library, Receipt, UploadSession } from '../src/service/types.ts'

test('真实 HTTPS 并行上传三个原文件、重复内容提交和独立偏移续传', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'momentnest-parallel-receiver-'))
  const data = join(directory, 'state'), libraryPath = join(directory, 'library')
  await Promise.all([data, libraryPath].map(path => mkdir(path)))
  const receiver = new Receiver(data)
  await receiver.addDirectory(libraryPath, 'library')
  await receiver.start(0, '127.0.0.1')
  const identity = JSON.parse(await readFile(join(data, 'tls-identity.json'), 'utf8'))
  const agent = new Agent({ ca: identity.cert, maxSockets: 6, checkServerIdentity: (_host, cert) => cert.fingerprint256.replaceAll(':', '').toLowerCase() === receiver.fingerprint ? undefined : new Error('错误证书') })
  let token = ''
  const call = (method: string, path: string, value?: unknown): Promise<any> => new Promise((resolve, reject) => {
    const bytes = Buffer.isBuffer(value) ? value : value === undefined ? undefined : Buffer.from(JSON.stringify(value))
    const req = request({ hostname: '127.0.0.1', port: receiver.port, path, method, agent, headers: { ...(bytes ? { 'content-length': bytes.length } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
      const parts: Buffer[] = []
      response.on('data', chunk => parts.push(chunk))
      response.on('end', () => {
        const body = JSON.parse(Buffer.concat(parts).toString())
        if (response.statusCode !== 200) reject(new Error(`${response.statusCode}: ${body.error}`))
        else resolve(body)
      })
      response.on('error', reject)
    })
    req.on('error', reject)
    req.end(bytes)
  })
  try {
    const paired = await call('POST', '/v1/pair', { secret: receiver.pairInfo().secret, name: '合成并行手机' })
    token = paired.token
    const library = receiver.store.list<Library>('library')[0]
    const batch = await call('POST', '/v1/batches', { clientKey: randomUUID(), libraryId: library.id, mode: 'manual', manualDate: '2026-02-28' })
    const originals = [Buffer.alloc(1024 * 1024 + 31, 1), Buffer.alloc(1024 * 1024 + 43, 2), Buffer.alloc(1024 * 1024 + 57, 3)]
    const sessions: UploadSession[] = await Promise.all(originals.map(bytes => call('POST', '/v1/uploads', { clientKey: randomUUID(), batchId: batch.id, filename: '同名合成图片.jpg', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length })))
    const duplicate: UploadSession = await call('POST', '/v1/uploads', { clientKey: randomUUID(), batchId: batch.id, filename: '合成副本.jpg', hash: sessions[0].hash, size: sessions[0].size })
    const offsets = [17, 29, 41]
    await Promise.all(sessions.map((session, index) => call('PUT', `/v1/uploads/${session.id}/content?offset=0`, originals[index].subarray(0, offsets[index]))))
    const checkpoints: UploadSession[] = await Promise.all(sessions.map(session => call('GET', `/v1/uploads/${session.id}`)))
    assert.deepEqual(checkpoints.map(session => session.offset), offsets)
    await Promise.all(sessions.map((session, index) => call('PUT', `/v1/uploads/${session.id}/content?offset=${offsets[index]}`, originals[index].subarray(offsets[index]))))
    await call('PUT', `/v1/uploads/${duplicate.id}/content?offset=0`, originals[0])
    const completed: UploadSession[] = await Promise.all([...sessions, duplicate].map(session => call('POST', `/v1/uploads/${session.id}/complete`, {})))
    assert.equal(new Set(completed.map(session => session.receipt!.relativePath)).size, 3)
    assert.equal(completed[0].receipt!.id, completed[3].receipt!.id)
    for (const [index, session] of completed.entries()) {
      const receipt = session.receipt!
      assert.equal(session.state, 'complete')
      assert.equal(session.archiveDate, '2026-02-28')
      assert.equal(receipt.receiverId, receiver.receiverId)
      assert.equal(receipt.libraryId, library.id)
      assert.equal(receipt.hash, session.hash)
      assert.equal(receipt.size, session.size)
      assert.deepEqual(await readFile(join(libraryPath, receipt.relativePath)), originals[index % 3])
    }
    assert.equal(receiver.store.list<Receipt>('file').length, 3)
  } finally { agent.destroy(); await receiver.close() }
})
