param(
  [string]$Python = 'python',
  [string]$Node = 'node',
  [ValidateRange(1, 32)][int]$Jobs = 1
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
function Get-Sha256([string]$File) {
  $stream = [IO.File]::OpenRead($File)
  $algorithm = [Security.Cryptography.SHA256]::Create()
  try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
  finally { $stream.Dispose(); $algorithm.Dispose() }
}
$nodeVersion = & $Node -p 'process.versions.node'
if ($LASTEXITCODE -ne 0 -or [version]$nodeVersion -lt [version]'22.12.0') { throw '构建需要 Node.js 22.12 及以上版本，请通过 -Node 指定可用 Node。' }
$projectRoot = Split-Path $PSScriptRoot -Parent
$packageRoot = Join-Path $projectRoot 'third_party/media-tools'
$manifestPath = Join-Path $packageRoot 'build-manifest.json'
$manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
$buildScriptHash = Get-Sha256 $PSCommandPath
$cacheRoot = Join-Path $projectRoot '.cache/media-tool-build'
# 每轮使用独立源码和构建目录，避免旧缓存中的修改或目标文件影响对应源码。
$buildRoot = Join-Path (Join-Path $cacheRoot 'builds') ([Guid]::NewGuid().ToString('N'))
$downloadsRoot = Join-Path $cacheRoot 'downloads'
$sourcesRoot = Join-Path $buildRoot 'sources'
$toolsRoot = Join-Path $cacheRoot 'toolchain'
$prefix = Join-Path $buildRoot 'prefix'
$logsRoot = Join-Path $buildRoot 'logs'
foreach ($directory in @($downloadsRoot, $sourcesRoot, $toolsRoot, $prefix, $logsRoot)) {
  New-Item -ItemType Directory -Force -Path $directory | Out-Null
}

function Assert-Hash([string]$File, [string]$Expected) {
  if ((Get-Sha256 $File) -ne $Expected) {
    throw ('SHA-256 校验失败：' + (Split-Path $File -Leaf))
  }
}

function Invoke-Build([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Directory) {
  $log = Join-Path $logsRoot ($Name + '.log')
  Write-Output ('构建步骤：' + $Name)
  Push-Location -LiteralPath $Directory
  try {
    & $Executable @Arguments > $log 2>&1
    if ($LASTEXITCODE -ne 0) {
      Get-Content -LiteralPath $log -Tail 30 | Write-Output
      throw ('构建失败：' + $Name + '，日志：' + $log)
    }
  } finally { Pop-Location }
}

function Invoke-Configure([string]$Name, [string]$Executable, [string[]]$Arguments, [string]$Directory) {
  $stampPath = Join-Path $logsRoot ($Name + '-inputs.json')
  $inputs = @{arguments=$Arguments; manifestSha256=(Get-Sha256 $manifestPath)}
  $inputJson = $inputs | ConvertTo-Json -Depth 8 -Compress
  if ((Test-Path -LiteralPath $stampPath) -and (Test-Path -LiteralPath (Join-Path $Directory 'config.h'))) {
    $previous = Get-Content -Raw -LiteralPath $stampPath | ConvertFrom-Json
    if ($previous.manifestSha256 -eq $inputs.manifestSha256 -and
        ($previous.arguments | ConvertTo-Json -Compress) -eq ($Arguments | ConvertTo-Json -Compress)) {
      Write-Output ('复用已核实配置：' + $Name)
      return
    }
  }
  Invoke-Build $Name $Executable $Arguments $Directory
  [IO.File]::WriteAllText($stampPath, $inputJson, [Text.UTF8Encoding]::new($false))
}

function Expand-CheckedZip([string]$Archive, [string]$Destination) {
  $zip = [IO.Compression.ZipFile]::OpenRead($Archive)
  try {
    $resolvedDestination = [IO.Path]::GetFullPath($Destination) + [IO.Path]::DirectorySeparatorChar
    foreach ($entry in $zip.Entries) {
      $entryPath = [IO.Path]::GetFullPath((Join-Path $Destination $entry.FullName))
      if (-not $entryPath.StartsWith($resolvedDestination, [StringComparison]::OrdinalIgnoreCase)) {
        throw '构建工具归档包含越界路径'
      }
    }
  } finally { $zip.Dispose() }
  if (-not (Test-Path -LiteralPath $Destination)) {
    [IO.Compression.ZipFile]::ExtractToDirectory($Archive, $Destination)
  }
}

foreach ($archive in $manifest.archives) {
  $destination = Join-Path $downloadsRoot $archive.filename
  if (-not (Test-Path -LiteralPath $destination)) {
    Write-Output ('下载固定版本：' + $archive.name)
    for ($attempt = 0; $attempt -lt 3; $attempt++) {
      try { Invoke-WebRequest -UseBasicParsing -Uri $archive.url -OutFile $destination -TimeoutSec 60; break }
      catch { if ($attempt -eq 2) { throw } }
    }
  }
  Assert-Hash $destination $archive.sha256
  if ($archive.role -eq 'runtime-source') {
    $sourceDirectory = Join-Path $sourcesRoot $archive.directory
    if (-not (Test-Path -LiteralPath $sourceDirectory)) {
      $entries = & tar.exe -tf $destination
      if ($LASTEXITCODE -ne 0 -or ($entries | Where-Object { $_ -match '(^/|(^|/)\.\.(/|$)|^[A-Za-z]:)' })) {
        throw '源码归档路径无效'
      }
      & tar.exe -xf $destination -C $sourcesRoot
      if ($LASTEXITCODE -ne 0) { throw ('源码解包失败：' + $archive.name) }
    }
  } elseif ($archive.name -eq 'w64devkit') {
    if (-not (Test-Path -LiteralPath (Join-Path $toolsRoot 'w64devkit/bin/gcc.exe'))) {
      $extractor = Start-Process -FilePath $destination -ArgumentList @('-y', ('-o' + $toolsRoot)) -Wait -PassThru -WindowStyle Hidden
      if ($extractor.ExitCode -ne 0) { throw '便携工具链解包失败' }
    }
  } else {
    Expand-CheckedZip $destination (Join-Path $toolsRoot $archive.name)
  }
}

$compilerBin = Join-Path $toolsRoot 'w64devkit/bin'
$nasmBin = Join-Path $toolsRoot 'nasm/nasm-2.16.03'
$mesonDirectory = Join-Path $toolsRoot 'meson'
$mesonEntry = Join-Path $mesonDirectory 'momentnest-meson.py'
[IO.File]::WriteAllText($mesonEntry, "from mesonbuild.mesonmain import main`nraise SystemExit(main())`n", [Text.UTF8Encoding]::new($false))
$sourcePaths = @{}
foreach ($source in $manifest.archives | Where-Object role -EQ 'runtime-source') {
  $sourcePaths[$source.name] = Join-Path $sourcesRoot $source.directory
}
$shell = Join-Path $compilerBin 'sh.exe'
$make = Join-Path $compilerBin 'make.exe'
$cmake = Join-Path $compilerBin 'cmake.exe'
$ninja = Join-Path $toolsRoot 'ninja/ninja.exe'
$prefixUnix = $prefix.Replace('\', '/')
$prefixInclude = Join-Path $prefix 'include'
$prefixLib = Join-Path $prefix 'lib'
New-Item -ItemType Directory -Force -Path $prefixInclude, $prefixLib | Out-Null

# 这些变量只影响当前构建子进程，退出后恢复；不写入系统或用户环境配置。
$environmentKeys = @('PATH', 'CC', 'CXX', 'AR', 'RANLIB', 'PKG_CONFIG_PATH', 'CCACHE_DIR', 'CCACHE_DISABLE', 'GIT_CEILING_DIRECTORIES', 'SOURCE_DATE_EPOCH')
$environmentBefore = @{}
foreach ($key in $environmentKeys) { $environmentBefore[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
  $env:PATH = $compilerBin + ';' + $nasmBin + ';' + (Join-Path $toolsRoot 'ninja') + ';' + $env:PATH
  $env:CC = 'gcc'
  $env:CXX = 'g++'
  $env:AR = 'ar'
  $env:RANLIB = 'ranlib'
  $env:PKG_CONFIG_PATH = Join-Path $prefixLib 'pkgconfig'
  $env:CCACHE_DIR = Join-Path $buildRoot 'ccache'
  $env:CCACHE_DISABLE = '1'
  $env:GIT_CEILING_DIRECTORIES = $sourcesRoot
  $env:SOURCE_DATE_EPOCH = '1703971198'

  $zlibBuild = Join-Path $buildRoot 'zlib-build'
  Invoke-Build 'zlib-configure' $cmake @('-S', $sourcePaths.zlib, '-B', $zlibBuild, '-G', 'Ninja', ('-DCMAKE_MAKE_PROGRAM=' + $ninja), '-DCMAKE_BUILD_TYPE=Release', ('-DCMAKE_INSTALL_PREFIX=' + $prefix), '-DZLIB_BUILD_EXAMPLES=OFF') $buildRoot
  Invoke-Build 'zlib-compile' $cmake @('--build', $zlibBuild, '--target', 'zlibstatic', '--parallel', "$Jobs") $buildRoot
  Copy-Item -LiteralPath (Join-Path $zlibBuild 'libzlibstatic.a') -Destination (Join-Path $prefixLib 'libz.a')
  Copy-Item -LiteralPath (Join-Path $sourcePaths.zlib 'zlib.h') -Destination $prefixInclude
  Copy-Item -LiteralPath (Join-Path $zlibBuild 'zconf.h') -Destination $prefixInclude
  New-Item -ItemType Directory -Force -Path (Join-Path $prefixLib 'pkgconfig') | Out-Null
  [IO.File]::WriteAllText((Join-Path $prefixLib 'pkgconfig/zlib.pc'), "prefix=$prefixUnix`nlibdir=$prefixUnix/lib`nincludedir=$prefixUnix/include`nName: zlib`nDescription: zlib compression library`nVersion: 1.3.1`nLibs: -L$prefixUnix/lib -lz`nCflags: -I$prefixUnix/include`n", [Text.UTF8Encoding]::new($false))

  $compilerMemoryOptions = 'gcc --param=ggc-min-expand=10 --param=ggc-min-heapsize=4096'
  Invoke-Configure 'x264-configure' $shell @('./configure', ('--prefix=' + $prefixUnix), '--enable-static', '--disable-cli', '--disable-opencl', '--host=x86_64-w64-mingw32') $sourcePaths.x264
  Invoke-Build 'x264-compile' $make @("-j$Jobs", ('CC=' + $compilerMemoryOptions)) $sourcePaths.x264
  Invoke-Build 'x264-install' $make @('install-lib-static') $sourcePaths.x264

  $dav1dBuild = Join-Path $buildRoot 'dav1d-build'
  if (-not (Test-Path -LiteralPath (Join-Path $dav1dBuild 'build.ninja'))) {
    Invoke-Build 'dav1d-configure' $Python @($mesonEntry, 'setup', $dav1dBuild, $sourcePaths.dav1d, ('--prefix=' + $prefix), '--libdir=lib', '--buildtype=release', '--default-library=static', '-Denable_tools=false', '-Denable_tests=false', '-Denable_examples=false', '-Denable_docs=false', '-Db_vscrt=none') $buildRoot
  }
  Invoke-Build 'dav1d-compile' $ninja @('-C', $dav1dBuild, "-j$Jobs") $buildRoot
  Invoke-Build 'dav1d-install' $Python @($mesonEntry, 'install', '-C', $dav1dBuild, '--no-rebuild') $buildRoot

  $ffmpegArguments = @('./configure', '--prefix=/momentnest-media-tools', '--arch=x86_64', '--target-os=mingw32', '--enable-gpl', '--enable-version3', '--disable-autodetect', '--enable-static', '--disable-shared', '--disable-debug', '--disable-doc', '--disable-ffplay', '--disable-network', '--enable-libx264', '--enable-libdav1d', '--enable-zlib', '--pkg-config=pkg-config', '--pkg-config-flags=--static', '--extra-cflags=-I../../prefix/include', '--extra-ldflags=-L../../prefix/lib -static')
  Invoke-Configure 'ffmpeg-configure' $shell $ffmpegArguments $sourcePaths.ffmpeg
  Invoke-Build 'ffmpeg-compile' $make @("-j$Jobs", 'V=1', ('CC=' + $compilerMemoryOptions), 'ffmpeg.exe', 'ffprobe.exe') $sourcePaths.ffmpeg

  $runtimeRoot = Join-Path $packageRoot 'bin/win32-x64'
  New-Item -ItemType Directory -Force -Path $runtimeRoot | Out-Null
  foreach ($tool in @('ffmpeg', 'ffprobe')) {
    Copy-Item -LiteralPath (Join-Path $sourcePaths.ffmpeg ($tool + '.exe')) -Destination $runtimeRoot
  }
  $runtimeHashes = @{}
  foreach ($tool in @('ffmpeg', 'ffprobe')) {
    $runtimeHashes[$tool + '.exe'] = Get-Sha256 (Join-Path $runtimeRoot ($tool + '.exe'))
  }
  $buildInfo = @{version=$manifest.version; buildId=$manifest.buildId; manifestSha256=(Get-Sha256 $manifestPath); buildScriptSha256=$buildScriptHash; binaries=$runtimeHashes; ffmpegConfigure=$ffmpegArguments; compiler=(& (Join-Path $compilerBin 'gcc.exe') -dumpfullversion); compilerMemoryOptions=$compilerMemoryOptions; createdAt=[DateTime]::UtcNow.ToString('o')}
  $buildInfo | ConvertTo-Json -Depth 10 | Set-Content -Encoding utf8 (Join-Path $runtimeRoot 'build-info.json')

  $licenseRoot = Join-Path $packageRoot 'licenses'
  New-Item -ItemType Directory -Force -Path $licenseRoot | Out-Null
  foreach ($file in @('COPYING.GPLv2', 'COPYING.GPLv3', 'COPYING.LGPLv2.1', 'COPYING.LGPLv3', 'LICENSE.md')) { Copy-Item -LiteralPath (Join-Path $sourcePaths.ffmpeg $file) -Destination (Join-Path $licenseRoot ('FFmpeg-' + $file)) }
  Copy-Item -LiteralPath (Join-Path $sourcePaths.x264 'COPYING') -Destination (Join-Path $licenseRoot 'x264-COPYING')
  Copy-Item -LiteralPath (Join-Path $sourcePaths.dav1d 'COPYING') -Destination (Join-Path $licenseRoot 'dav1d-COPYING')
  Copy-Item -LiteralPath (Join-Path $sourcePaths.zlib 'LICENSE') -Destination (Join-Path $licenseRoot 'zlib-LICENSE')
  Copy-Item -LiteralPath (Join-Path $toolsRoot 'w64devkit/COPYING.MinGW-w64-runtime.txt') -Destination (Join-Path $licenseRoot 'MinGW-w64-runtime-COPYING.txt')
  Copy-Item -LiteralPath (Join-Path $projectRoot 'LICENSE') -Destination (Join-Path $packageRoot 'LICENSE')

  & $Node (Join-Path $PSScriptRoot 'media-source-bundle.mjs')
  if ($LASTEXITCODE -ne 0) { throw '对应源码归档准备失败，不能交付媒体工具' }

  Write-Output ('媒体工具构建完成：' + $runtimeRoot)
} finally {
  foreach ($key in $environmentKeys) { [Environment]::SetEnvironmentVariable($key, $environmentBefore[$key], 'Process') }
}
