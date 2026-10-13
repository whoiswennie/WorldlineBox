param([ValidateSet('Setup', 'Dev', 'Installer')][string]$Action = 'Setup')
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$toolsRoot = Join-Path $projectRoot '.tools'
$nodeVersion = (Get-Content -LiteralPath (Join-Path $projectRoot '.nvmrc') -Raw).Trim()
if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Node version in .nvmrc' }
if (-not [Environment]::Is64BitOperatingSystem) { throw 'WorldlineBox requires 64-bit Windows.' }
$nodeRoot = Join-Path $toolsRoot "node-v$nodeVersion-win-x64"
$nodeExe = Join-Path $nodeRoot 'node.exe'
$npmCmd = Join-Path $nodeRoot 'npm.cmd'
$innoRoot = Join-Path $toolsRoot 'inno'
$setupState = Join-Path $toolsRoot 'setup-state.json'
Set-Location -LiteralPath $projectRoot
New-Item -ItemType Directory -Path $toolsRoot -Force | Out-Null

function Download-File([string]$Url, [string]$Destination) {
    Write-Host "Downloading $Url"
    if (Get-Command curl.exe -ErrorAction SilentlyContinue) {
        & curl.exe --fail --location --retry 4 --output $Destination $Url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $Url" }
    } else {
        Invoke-WebRequest -UseBasicParsing -Uri $Url -OutFile $Destination
    }
}

function Run-Npm([string[]]$Arguments) {
    & $npmCmd @Arguments
    if ($LASTEXITCODE -ne 0) { throw "npm $($Arguments -join ' ') failed (exit $LASTEXITCODE)." }
}

function File-Sha256([string]$FilePath) {
    $algorithm = [Security.Cryptography.SHA256]::Create()
    $stream = [IO.File]::OpenRead($FilePath)
    try { return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant() }
    finally { $stream.Dispose(); $algorithm.Dispose() }
}

function Expand-Zip([string]$ArchivePath, [string]$Destination) {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $destinationRoot = [IO.Path]::GetFullPath($Destination).TrimEnd('\')
    [IO.Directory]::CreateDirectory($destinationRoot) | Out-Null
    $archive = [IO.Compression.ZipFile]::OpenRead($ArchivePath)
    try {
        foreach ($entry in $archive.Entries) {
            $targetPath = [IO.Path]::GetFullPath((Join-Path $destinationRoot $entry.FullName))
            if (-not $targetPath.StartsWith($destinationRoot + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Archive entry escaped destination.' }
            if (-not $entry.Name) { [IO.Directory]::CreateDirectory($targetPath) | Out-Null; continue }
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($targetPath)) | Out-Null
            $inputStream = $entry.Open()
            $outputStream = [IO.File]::Create($targetPath)
            try { $inputStream.CopyTo($outputStream) }
            finally { $outputStream.Dispose(); $inputStream.Dispose() }
        }
    } finally { $archive.Dispose() }
}

function Prepare-Node {
    if (-not (Test-Path -LiteralPath $nodeExe)) {
        $archiveName = "node-v$nodeVersion-win-x64.zip"
        $archivePath = Join-Path $toolsRoot $archiveName
        $hashPath = Join-Path $toolsRoot 'node-SHASUMS256.txt'
        Download-File "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" $hashPath
        Download-File "https://nodejs.org/dist/v$nodeVersion/$archiveName" $archivePath
        $hashLine = Get-Content -LiteralPath $hashPath | Where-Object { $_ -match "  $([regex]::Escape($archiveName))$" }
        if (-not $hashLine) { throw 'Official Node checksum missing.' }
        $expectedHash = ($hashLine -split '\s+')[0]
        if ((File-Sha256 $archivePath) -ne $expectedHash) { throw 'Node checksum mismatch.' }
        Expand-Zip $archivePath $toolsRoot
        Remove-Item -LiteralPath $archivePath -Force
    }
    $actualVersion = & $nodeExe --version
    if ($actualVersion -ne "v$nodeVersion") { throw "Unexpected local Node version: $actualVersion" }
    $env:Path = "$nodeRoot;$env:Path"
    $env:VcpkgEnabled = 'false'
    $env:npm_config_cache = Join-Path $toolsRoot 'npm-cache'
    $env:ELECTRON_CACHE = Join-Path $toolsRoot 'electron-cache'
}

function Prepare-Inno {
    if (-not (Test-Path -LiteralPath (Join-Path $innoRoot 'ISCC.exe'))) {
        $innoVersion = '6.7.3'
        $packageUrl = "https://api.nuget.org/v3-flatcontainer/tools.innosetup/$innoVersion/tools.innosetup.$innoVersion.nupkg"
        $archivePath = Join-Path $toolsRoot 'inno.zip'
        $expectedHash = 'rdSE25v0Im6KKD2sH275qceul818uExubvAWG4BbHHuEAwnknapphEuwqOV77F3JunurFXF9vSfZJp7wkuBUxA=='
        Download-File $packageUrl $archivePath
        $sha512 = [Security.Cryptography.SHA512]::Create()
        try { $actual = [Convert]::ToBase64String($sha512.ComputeHash([IO.File]::ReadAllBytes($archivePath))) }
        finally { $sha512.Dispose() }
        if ($actual -ne $expectedHash) { throw 'Inno Setup checksum mismatch.' }
        $extractRoot = Join-Path $toolsRoot 'inno-package'
        Expand-Zip $archivePath $extractRoot
        $compiler = Get-ChildItem -LiteralPath $extractRoot -Recurse -Filter ISCC.exe | Select-Object -First 1
        if (-not $compiler) { throw 'NuGet package did not contain ISCC.exe.' }
        New-Item -ItemType Directory -Path $innoRoot -Force | Out-Null
        Copy-Item -Path (Join-Path $compiler.Directory.FullName '*') -Destination $innoRoot -Recurse -Force
        Remove-Item -LiteralPath $archivePath -Force
    }
    $env:WORLDLINEBOX_INNO_TOOLS = $innoRoot
}

function Prepare-Electron([switch]$RequireArchive) {
    $electronRoot = Join-Path $projectRoot 'node_modules\electron'
    $hasDistribution = Test-Path -LiteralPath (Join-Path $electronRoot 'dist\electron.exe')
    if ($hasDistribution -and -not $RequireArchive) { return }
    $electronVersion = (Get-Content -LiteralPath (Join-Path $electronRoot 'package.json') -Raw | ConvertFrom-Json).version
    $archiveName = "electron-v$electronVersion-win32-x64.zip"
    $archivePath = Join-Path $toolsRoot $archiveName
    $checksums = Get-Content -LiteralPath (Join-Path $electronRoot 'checksums.json') -Raw | ConvertFrom-Json
    $expectedHash = $checksums.$archiveName
    if (-not $expectedHash) { throw 'Pinned Electron checksum is missing.' }
    if (-not (Test-Path -LiteralPath $archivePath) -or (File-Sha256 $archivePath) -ne $expectedHash) {
        Download-File "https://github.com/electron/electron/releases/download/v$electronVersion/$archiveName" $archivePath
    }
    if ((File-Sha256 $archivePath) -ne $expectedHash) { throw 'Electron checksum mismatch.' }
    if (-not $hasDistribution) {
        Expand-Zip $archivePath (Join-Path $electronRoot 'dist')
        [IO.File]::WriteAllText((Join-Path $electronRoot 'path.txt'), 'electron.exe')
    }
}

function Prepare-NativeBuildTools {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    $hasCompiler = $false
    if (Test-Path -LiteralPath $vswhere) {
        $installation = & $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
        $hasCompiler = [bool]$installation
    }
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    $hasPython = $pythonCommand -and $pythonCommand.Source -notmatch '\\WindowsApps\\'
    if ($hasPython -and $hasCompiler) { return }
    if (-not (Get-Command winget.exe -ErrorAction SilentlyContinue)) {
        throw 'Install Python 3 and Visual Studio 2022 Build Tools (Desktop development with C++), then run setup again. Automatic installation requires Windows App Installer / winget.'
    }
    if (-not $hasPython) {
        & winget.exe install --id Python.Python.3.13 --exact --accept-source-agreements --accept-package-agreements
        if ($LASTEXITCODE -ne 0) { throw 'Python installation failed.' }
    }
    if (-not $hasCompiler) {
        & winget.exe install --id Microsoft.VisualStudio.2022.BuildTools --exact --accept-source-agreements --accept-package-agreements --override '--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended'
        if ($LASTEXITCODE -ne 0) { throw 'C++ Build Tools installation failed. Complete any requested restart and run setup again.' }
    }
    $pythonRoot = Join-Path $env:LOCALAPPDATA 'Programs\Python\Python313'
    if (Test-Path -LiteralPath (Join-Path $pythonRoot 'python.exe')) { $env:Path = "$pythonRoot;$env:Path" }
}

function Setup-Environment {
    Prepare-NativeBuildTools
    $env:ELECTRON_SKIP_BINARY_DOWNLOAD = '1'
    Run-Npm @('ci', '--registry=https://registry.npmjs.org')
    Prepare-Electron -RequireArchive
    Run-Npm @('run', 'rebuild:native')
    $mediaArchive = Join-Path $toolsRoot 'worldlinebox-media-win32-x64.zip'
    if (Test-Path -LiteralPath $mediaArchive) {
        Run-Npm @('run', 'media:ensure', '--', '--archive', $mediaArchive)
    } else { Run-Npm @('run', 'media:ensure') }
    & $nodeExe (Join-Path $projectRoot 'scripts\generate-automation-declarations.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'Automation API generation failed.' }
    & $nodeExe (Join-Path $projectRoot 'scripts\verify-ufbx-wasm.mjs')
    if ($LASTEXITCODE -ne 0) { throw 'FBX component verification failed.' }
    Prepare-Inno
    $lockHash = File-Sha256 (Join-Path $projectRoot 'package-lock.json')
    @{ nodeVersion = $nodeVersion; lockHash = $lockHash } | ConvertTo-Json | Set-Content -LiteralPath $setupState -Encoding UTF8
    Write-Host 'WorldlineBox environment is ready.' -ForegroundColor Green
}

try {
    Prepare-Node
    $needsSetup = -not (Test-Path -LiteralPath $setupState) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\electron\dist\electron.exe'))
    if (-not $needsSetup) {
        $saved = Get-Content -LiteralPath $setupState -Raw | ConvertFrom-Json
        $lockHash = File-Sha256 (Join-Path $projectRoot 'package-lock.json')
        $needsSetup = $saved.nodeVersion -ne $nodeVersion -or $saved.lockHash -ne $lockHash
    }
    if ($Action -eq 'Setup' -or $needsSetup) { Setup-Environment }
    if ($Action -eq 'Dev') {
        & $nodeExe (Join-Path $projectRoot 'scripts\portable-tools.mjs') ensure
        if ($LASTEXITCODE -ne 0) { throw 'Bundled tool preparation failed.' }
        $env:WORLDLINEBOX_DISTRIBUTION = 'development'
        # Development and installed applications use the same user-owned profile.
        Run-Npm @('start')
    }
    if ($Action -eq 'Installer') {
        Prepare-Inno
        Prepare-Electron -RequireArchive
        $env:WORLDLINEBOX_ELECTRON_ZIP_DIR = $toolsRoot
        Run-Npm @('run', 'typecheck')
        Run-Npm @('run', 'package')
        Run-Npm @('run', 'make:inno')
        Write-Host "Installer: $(Join-Path $projectRoot 'out\make\inno\WorldlineBoxSetup.exe')" -ForegroundColor Green
    }
    exit 0
} catch {
    Write-Host "ERROR: $($_.Exception.Message)" -ForegroundColor Red
    exit 1
}
