import assert from 'node:assert/strict'
import test from 'node:test'
import { findSensitiveContent, isSensitivePath } from '../check-open-source.mjs'

test('凭据检查报告只保留规则和行号，绝不返回凭据值', () => {
  const credential = ['ghp_', 'A'.repeat(36)].join('')
  const hits = findSensitiveContent(`普通说明\nconst token = '${credential}'\n`)
  assert.deepEqual(hits, [{ rule: 'github-token', line: 2 }])
  assert.ok(!JSON.stringify(hits).includes(credential))
})

test('多行私钥标记及不同凭据格式均可识别', () => {
  const values = [
    ['-----BEGIN ', 'OPENSSH ', 'PRIVATE KEY-----'].join(''),
    ['AKIA', 'A'.repeat(16)].join(''),
    ['xoxb-', 'A'.repeat(25)].join(''),
    ['sk-proj-', 'A'.repeat(48)].join(''),
    ['https://', 'demo:', 'temporary-value@', 'example.com/'].join(''),
  ]
  const hits = findSensitiveContent(values.join('\n'))
  assert.deepEqual(hits.map(item => item.rule), ['private-key', 'aws-access-key', 'slack-token', 'openai-key', 'credential-url'])
  assert.deepEqual(hits.map(item => item.line), [1, 2, 3, 4, 5])
})

test('普通变量名、公开证书和源码字符串不冒充真实凭据命中', () => {
  assert.deepEqual(findSensitiveContent('const token = userInput\n-----BEGIN PUBLIC KEY-----\nhttps://github.com/example/project\n'), [])
  assert.deepEqual(findSensitiveContent(['https://example.com', 'variable: value@host'].join('\n')), [])
})

test('签名、运行数据与私有配置路径应被拦截，示例配置和许可文本保留', () => {
  for (const file of ['.local/signing/release.properties', 'nested/.env.production', 'app/key.properties',
    'archive/private.JKS', 'receiver/records.sqlite', 'receiver/records.db-wal', 'receiver/records.sqlite-shm',
    '.momentnest-incoming/chunk', 'models/face.onnx', 'app-release.apk']) assert.equal(isSensitivePath(file), true, file)
  for (const file of ['.env.example', 'nested/.env.example', 'models/face-LICENSE.txt', 'docs/privacy.md',
    'scripts/create-android-signing.mjs', 'apps/mobile/lib/local_store.dart']) assert.equal(isSensitivePath(file), false, file)
})
