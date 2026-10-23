import { cp, mkdir, writeFile, readFile, access } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { packager } from '@electron/packager'
import { advanceDesktopVersion } from './release-version.mjs'
import { copyRuntimeLicenses } from './third-party-licenses.mjs'
import { verifyMediaBuild } from './media-source-bundle.mjs'
import { buildWindowsInstaller } from './windows-installer.mjs'
import { windowsInstallerCompiler } from './setup-windows-installer.mjs'

const root=dirname(dirname(fileURLToPath(import.meta.url)))
const mediaBuild=await verifyMediaBuild(root)
const stamp=new Date().toISOString().replace(/[:.]/g,'-')
const output=join(root,'release',stamp)
const input=join(output,'package-input')
const installerCompiler=windowsInstallerCompiler(root)
const desktop=await advanceDesktopVersion(root)
const packageName=`MomentNest-${desktop.version}`
console.log(`桌面版本：${desktop.previousVersion} → ${desktop.version}`)
await mkdir(input,{recursive:true})
await cp(join(root,'apps/desktop/out'),join(input,'out'),{recursive:true})
await mkdir(join(input,'assets','branding'),{recursive:true})
await cp(join(root,'assets','branding','momentnest.ico'),join(input,'assets','branding','momentnest.ico'))
const nativeModules=['sharp','onnxruntime-node','@momentnest/media-tools']
const copied=new Map()
/** 复制实际安装的运行依赖及其可用平台包，便携程序不需要联网安装。 */
async function copyDependency(name,fromDirectory,parentDestination,optional=false) {
  const resolver=createRequire(join(fromDirectory,'package.json'))
  let source
  for(const base of resolver.resolve.paths(name)??resolver.resolve.paths('__momentnest_dependency_lookup__')??[]) {
    const candidate=join(base,name)
    try {await access(join(candidate,'package.json'));source=candidate;break} catch { /* 此层没有该依赖时继续查找。 */ }
  }
  if(!source) {if(optional)return;throw new Error(`打包缺少依赖：${name}`)}
  const metadata=JSON.parse(await readFile(join(source,'package.json'),'utf8'))
  let destination=join(input,'node_modules',name)
  if(copied.get(destination)===metadata.version) return
  if(copied.has(destination)) destination=join(parentDestination,'node_modules',name)
  if(copied.get(destination)===metadata.version) return
  if(copied.has(destination)) throw new Error(`依赖版本冲突：${name}`)
  await mkdir(dirname(destination),{recursive:true})
  await cp(source,destination,{recursive:true,dereference:true,filter:path=>!path.includes(`${source}/node_modules/`)&&!path.includes(`${source}\\node_modules\\`)})
  copied.set(destination,metadata.version)
  for(const dependency of Object.keys(metadata.dependencies??{})) await copyDependency(dependency,source,destination)
  for(const dependency of Object.keys(metadata.optionalDependencies??{})) await copyDependency(dependency,source,destination,true)
}
for(const name of nativeModules) await copyDependency(name,join(root,'apps','desktop'),input)
await cp(join(root,'models'),join(input,'models'),{recursive:true})
await cp(join(root,'THIRD_PARTY_NOTICES.md'),join(input,'THIRD_PARTY_NOTICES.md'))
await cp(join(root,'LICENSE'),join(input,'LICENSE'))
await cp(join(root,'third_party','licenses'),join(input,'licenses'),{recursive:true})
const licenseReport=await copyRuntimeLicenses(root,join(input,'licenses'))
if(licenseReport.missingNotices.length) console.warn(`以下运行依赖未发现顶层许可文本，对外分发前需补核：${licenseReport.missingNotices.join('、')}`)
await writeFile(join(input,'package.json'),JSON.stringify({name:'momentnest',version:desktop.version,description:'拾光匣：本地家庭相册与局域网传输',main:'out/main/index.js',author:'MomentNest',license:desktop.license,dependencies:Object.fromEntries(nativeModules.map(name=>[name,desktop.dependencies[name]]))},null,2))
// 每次打包写入独立目录，主进程与工作线程已包含运行所需的 JavaScript 依赖。
const paths=await packager({dir:input,name:packageName,icon:join(root,'assets','branding','momentnest.ico'),appCopyright:'MomentNest',platform:'win32',arch:'x64',electronVersion:desktop.devDependencies.electron,download:{cacheRoot:join(root,'.cache/electron-runtime')},out:output,asar:false,prune:false,overwrite:false,win32metadata:{ProductName:'拾光匣',FileDescription:'拾光匣本地家庭相册'}})
await cp(mediaBuild.sourcePath,join(output,mediaBuild.build.sourceBundle.filename),{errorOnExist:true,force:false})
const installer=await buildWindowsInstaller({root,directory:paths[0],version:desktop.version,compiler:installerCompiler})
await writeFile(join(root,'release','latest.json'),JSON.stringify({version:desktop.version,directory:paths[0],executable:join(paths[0],`${packageName}.exe`),installer,createdAt:new Date().toISOString()},null,2))
console.log(`Windows 便携程序已生成：${paths[0]}`)
console.log(`Windows 安装程序已生成：${installer.path}`)
