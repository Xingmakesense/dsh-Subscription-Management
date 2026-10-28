#requires -Version 5.1
<#
.SYNOPSIS
  把 dsh-Subscription-Management 打成可安装进 DSH profile 的 tgz。

.DESCRIPTION
  profile 会用 pnpm 的 lockfile 钉住 tgz 的 sha512，所以重新打包时版本号必须变，
  否则同名同版本的 tarball 不会被重新解包。默认 -Bump 只升 patch；破坏性变更请先
  手工改 package.json 的版本号。

  产物默认写到仓库内的 dist\ 目录（已被 .gitignore 忽略），可用 -OutDir 覆盖。

.EXAMPLE
  pwsh -File scripts/build-tgz.ps1
  powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-tgz.ps1 -Bump
#>
param(
    [switch]$Bump,
    [string]$OutDir
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$manifestPath = Join-Path $repo 'package.json'
$manifest = Get-Content -Raw -Encoding utf8 $manifestPath | ConvertFrom-Json
$slug = $manifest.name -replace '^@[^/]+/', ''

if (-not $OutDir) {
    $OutDir = Join-Path $repo 'dist'
}
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

function Resolve-Node {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies'
    $fallback = Join-Path $runtime 'node\bin\node.exe'
    if (Test-Path $fallback) { return $fallback }
    throw '找不到 node：请把 node 加入 PATH，或使用 DSH 自带运行时。'
}

function Resolve-Pnpm {
    $cmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($cmd) { return @{ Node = $null; Script = $cmd.Source } }
    $runtime = Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies'
    $script = Join-Path $runtime 'pnpm\bin\pnpm.mjs'
    if (-not (Test-Path $script)) { $script = Join-Path $runtime 'pnpm\bin\pnpm.cjs' }
    if (Test-Path $script) { return @{ Node = (Resolve-Node); Script = $script } }
    throw '找不到 pnpm：请安装 pnpm，或使用 DSH 自带运行时。'
}

if ($Bump) {
    $parts = $manifest.version.Split('.')
    if ($parts.Count -ne 3) { throw "版本号不是 x.y.z：$($manifest.version)" }
    $parts[2] = [string]([int]$parts[2] + 1)
    $manifest.version = $parts -join '.'
    $json = $manifest | ConvertTo-Json -Depth 20
    # UTF-8 without BOM: a BOM would make pnpm read a broken manifest.
    [System.IO.File]::WriteAllText($manifestPath, $json + "`n", (New-Object System.Text.UTF8Encoding($false)))
    Write-Host "版本升到 $($manifest.version)"
}

$node = Resolve-Node
$pnpm = Resolve-Pnpm
Write-Host "node: $node"
Write-Host "pnpm: $($pnpm.Script)"

Push-Location $repo
try {
    & $node scripts/build-client.mjs
    if ($LASTEXITCODE -ne 0) { throw "Client 构建失败，退出码 $LASTEXITCODE" }
    if ($pnpm.Node) {
        & $node $pnpm.Script pack --pack-destination $OutDir
    } else {
        & $pnpm.Script pack --pack-destination $OutDir
    }
    if ($LASTEXITCODE -ne 0) { throw "打包失败，退出码 $LASTEXITCODE" }
} finally {
    Pop-Location
}

$tgz = Join-Path $OutDir ("{0}-{1}.tgz" -f $slug, $manifest.version)
if (-not (Test-Path $tgz)) { throw "没有找到产物：$tgz" }

Write-Host ''
Write-Host "产物：$tgz"
Write-Host '下一步：把它交给 DSH 的插件管理（plugin_manager → install_bundle，target 填上面的绝对路径）。'
Write-Host '若 profile 里已有旧版本，install_bundle 会就地替换依赖并保留 dsh.profile.bundles 里的条目。'
