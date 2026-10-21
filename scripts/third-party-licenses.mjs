import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

/** 收集实际安装的运行依赖声明，同时覆盖已编入 JavaScript 的依赖。 */
export async function copyRuntimeLicenses(projectRoot, destination) {
  const desktopDirectory = join(projectRoot, 'apps', 'desktop')
  const desktop = JSON.parse(await readFile(join(desktopDirectory, 'package.json'), 'utf8'))
  const packages = new Map()
  let supplements = {}
  try { supplements = JSON.parse(await readFile(join(projectRoot, 'third_party', 'npm-notices.json'), 'utf8')) }
  catch (error) { if (error.code !== 'ENOENT') throw error }

  async function visit(name, fromDirectory, optional = false) {
    const resolver = createRequire(join(fromDirectory, 'package.json'))
    let source
    let metadata
    for (const base of resolver.resolve.paths(name) ?? resolver.resolve.paths('__momentnest_dependency_lookup__') ?? []) {
      const candidate = join(base, name)
      try {
        metadata = JSON.parse(await readFile(join(candidate, 'package.json'), 'utf8'))
        source = candidate
        break
      } catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    if (!source) {
      if (optional) return
      throw new Error(`许可收集缺少运行依赖：${name}`)
    }
    if (typeof metadata.name !== 'string' || typeof metadata.version !== 'string') throw new Error(`运行依赖元数据无效：${name}`)
    const identity = `${metadata.name}@${metadata.version}`
    if (packages.has(identity)) return
    const entry = { name: metadata.name, version: metadata.version, license: metadata.license ?? 'UNKNOWN', files: [] }
    packages.set(identity, entry)
    const relativeDirectory = `npm/${encodeURIComponent(metadata.name)}@${encodeURIComponent(metadata.version)}`
    for (const item of await readdir(source, { withFileTypes: true })) {
      if (!/^(?:licen[cs]e|copying|notice|copyright|authors|third[-_]?party)/i.test(item.name)) continue
      const relativePath = `${relativeDirectory}/${item.name}`
      await mkdir(join(destination, relativeDirectory), { recursive: true })
      await cp(join(source, item.name), join(destination, relativePath), { recursive: true })
      entry.files.push(relativePath)
    }
    if (!entry.files.length) {
      let readme
      try { readme = await readFile(join(source, 'README.md'), 'utf8') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
      if (readme?.includes('Permission is hereby granted') && readme.includes('THE SOFTWARE IS PROVIDED')) {
        const relativePath = `${relativeDirectory}/README.md`
        await mkdir(join(destination, relativeDirectory), { recursive: true })
        await cp(join(source, 'README.md'), join(destination, relativePath))
        entry.files.push(relativePath)
      }
    }
    const supplement = supplements[identity]
    if (!entry.files.length && supplement) {
      if (typeof supplement.file !== 'string' || basename(supplement.file) !== supplement.file) throw new Error(`补充许可文件名无效：${identity}`)
      const author = typeof metadata.author === 'string' ? metadata.author : metadata.author?.name
      if ((supplement.declaredLicense && supplement.declaredLicense !== metadata.license) ||
          (supplement.declaredAuthor && supplement.declaredAuthor !== author)) throw new Error(`补充许可与已安装包的作者或授权声明不符：${identity}`)
      const bytes = await readFile(join(projectRoot, 'third_party', 'licenses', supplement.file))
      if (createHash('sha256').update(bytes).digest('hex') !== supplement.sha256) throw new Error(`补充许可 SHA-256 不符：${identity}`)
      const relativePath = `${relativeDirectory}/${supplement.file}`
      await mkdir(join(destination, relativeDirectory), { recursive: true })
      await writeFile(join(destination, relativePath), bytes)
      entry.files.push(relativePath)
      entry.supplementalSource = supplement.source
      entry.noticeBasis = supplement.noticeBasis ?? 'upstream-license-text'
    }
    for (const dependency of Object.keys(metadata.dependencies ?? {})) {
      await visit(dependency, source, Object.hasOwn(metadata.optionalDependencies ?? {}, dependency))
    }
    for (const dependency of Object.keys(metadata.optionalDependencies ?? {})) {
      if (!Object.hasOwn(metadata.dependencies ?? {}, dependency)) await visit(dependency, source, true)
    }
  }

  for (const name of Object.keys(desktop.dependencies ?? {})) await visit(name, desktopDirectory)
  const dependencies = [...packages.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))
  const report = { dependencies, missingNotices: dependencies.filter(item => !item.files.length).map(item => `${item.name}@${item.version}`) }
  await mkdir(destination, { recursive: true })
  await writeFile(join(destination, 'npm-manifest.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}
