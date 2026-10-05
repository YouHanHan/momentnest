import { execFileSync } from 'node:child_process'
import { randomBytes, X509Certificate } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const directory = join(root, '.local', 'momentnest-signing')
const keystore = join(directory, 'momentnest-release.jks')
const properties = join(directory, 'release.properties')
const passwordFile = join(directory, 'store-password.txt')
const certificateFile = join(directory, 'momentnest-release.cer')
const certificatePem = join(directory, 'momentnest-release.pem')
const reportFile = join(directory, 'certificate-info.json')
const alias = 'momentnest-release'

// 正式签名身份必须长期复用，重复执行不会覆盖已有密钥或密码。
if ([keystore, properties, passwordFile, certificateFile, certificatePem, reportFile].some(existsSync)) {
  throw new Error('正式签名目录已有文件，拒绝覆盖。请沿用现有证书和 release.properties。')
}

/** 通过密码文件调用 keytool，避免密码出现在命令行和日志中。 */
function keytool(args) {
  return execFileSync('keytool', args, { windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

await mkdir(directory, { recursive: true })
const password = randomBytes(32).toString('base64url')
await writeFile(passwordFile, password, { flag: 'wx' })
keytool(['-genkeypair', '-noprompt', '-storetype', 'JKS', '-keystore', keystore,
  '-alias', alias, '-keyalg', 'RSA', '-keysize', '3072', '-sigalg', 'SHA256withRSA',
  '-validity', '10000', '-dname', 'CN=MomentNest, OU=Mobile, O=MomentNest, C=CN',
  '-storepass:file', passwordFile, '-keypass:file', passwordFile])
keytool(['-exportcert', '-keystore', keystore, '-alias', alias,
  '-storepass:file', passwordFile, '-file', certificateFile])
keytool(['-exportcert', '-rfc', '-keystore', keystore, '-alias', alias,
  '-storepass:file', passwordFile, '-file', certificatePem])
await writeFile(properties, [
  '# 本机正式签名配置；整个目录已被 .gitignore 排除，请另行备份。',
  'storeFile=../../../.local/momentnest-signing/momentnest-release.jks',
  `storePassword=${password}`, `keyAlias=${alias}`, `keyPassword=${password}`, '',
].join('\n'), { flag: 'wx' })
const certificate = new X509Certificate(await readFile(certificateFile))
const report = {
  alias, algorithm: certificate.publicKey.asymmetricKeyType,
  keySize: certificate.publicKey.asymmetricKeyDetails.modulusLength,
  subject: certificate.subject, validFrom: certificate.validFrom, validTo: certificate.validTo,
  sha1: certificate.fingerprint, sha256: certificate.fingerprint256,
  keystore, properties, certificateFile, certificatePem,
}
await writeFile(reportFile, JSON.stringify(report, null, 2), { flag: 'wx' })
console.log(`正式签名证书已生成：${keystore}\n公开证书：${certificateFile}\nSHA-256：${report.sha256}\n密码仅保存在本机签名目录。`)
