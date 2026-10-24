import sharp from 'sharp'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const branding = join(root, 'assets', 'branding')
const androidResources = join(root, 'apps', 'mobile', 'android', 'app', 'src', 'main', 'res')
const logo = await sharp(join(branding, 'momentnest-logo-baby-pink.png')).trim().png().toBuffer()

/** 从同一份透明 Logo 生成居中的图标，不改变设计原稿。 */
async function renderIcon(size, markSize, background = '#00000000') {
  const mark = await sharp(logo).resize(markSize, markSize, { fit: 'inside' }).png().toBuffer()
  return sharp({ create: { width: size, height: size, channels: 4, background } })
    .composite([{ input: mark, gravity: 'centre' }]).png().toBuffer()
}

/** 将多种尺寸的 PNG 帧封装为 Windows ICO。 */
async function buildWindowsIcon() {
  const sizes = [16, 20, 24, 32, 40, 48, 64, 128, 256]
  const frames = await Promise.all(sizes.map(size => renderIcon(size, Math.round(size * 0.88))))
  const header = Buffer.alloc(6 + sizes.length * 16)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  for (const [index, size] of sizes.entries()) {
    const entry = 6 + index * 16
    header[entry] = size === 256 ? 0 : size
    header[entry + 1] = header[entry]
    header.writeUInt16LE(1, entry + 4)
    header.writeUInt16LE(32, entry + 6)
    header.writeUInt32LE(frames[index].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += frames[index].length
  }
  await writeFile(join(branding, 'momentnest.ico'), Buffer.concat([header, ...frames]))
}

await mkdir(branding, { recursive: true })
await writeFile(join(branding, 'momentnest-icon.png'), await renderIcon(1024, 900))
await buildWindowsIcon()
for (const [density, scale] of [['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]]) {
  const legacyDirectory = join(androidResources, `mipmap-${density}`)
  const foregroundDirectory = join(androidResources, `drawable-${density}`)
  await mkdir(legacyDirectory, { recursive: true })
  await mkdir(foregroundDirectory, { recursive: true })
  await writeFile(join(legacyDirectory, 'momentnest_launcher.png'), await renderIcon(48 * scale, Math.round(38 * scale), '#FFF9F2'))
  // 前景保留 Android 自适应图标的裁切余量，圆形和圆角方形共用同一标记。
  await writeFile(join(foregroundDirectory, 'momentnest_launcher_foreground.png'), await renderIcon(108 * scale, 60 * scale))
}
console.log('已生成 Windows 多尺寸 ICO、PNG 和 Android 各密度启动图标。')
