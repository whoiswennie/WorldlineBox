import path from 'node:path';

// libuv DETACHED_PROCESS can make Windows PowerShell exit 0 without executing
// its command. Launch this short bootstrap normally and wait for its exit; its
// hidden Start-Process child survives the application without keeping any
// executable in the application's installation directory open.
const CLEANUP_BOOTSTRAP = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $worker = Start-Process -FilePath $env:WORLDLINEBOX_UPDATE_CLEANUP_POWERSHELL -ArgumentList @(
    '-NoLogo', '-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden',
    '-ExecutionPolicy', 'Bypass', '-EncodedCommand', $env:WORLDLINEBOX_UPDATE_CLEANUP_SCRIPT
  ) -WindowStyle Hidden -PassThru
  if ($null -eq $worker -or $worker.Id -le 0) { throw 'Cleanup worker did not start.' }
  exit 0
} catch {
  $logPath = $env:WORLDLINEBOX_UPDATE_CLEANUP_LOG
  if (-not [string]::IsNullOrWhiteSpace($logPath)) {
    $entry = @{
      timestamp = [DateTime]::UtcNow.ToString('o')
      level = 'error'
      scope = 'app-update.cleanup'
      error = @{ name = 'CleanupWorkerStartFailed'; message = 'The hidden cleanup worker could not start.' }
      context = @{ artifactKind = 'windows-installer-cleanup' }
    } | ConvertTo-Json -Compress -Depth 5
    try { [System.IO.File]::AppendAllText($logPath, $entry + [Environment]::NewLine, [System.Text.UTF8Encoding]::new($false)) } catch { }
  }
  exit 1
}
`;

const CLEANUP_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$installerPath = $env:WORLDLINEBOX_UPDATE_CLEANUP_INSTALLER
$installerDirectory = $env:WORLDLINEBOX_UPDATE_CLEANUP_DIRECTORY
$temporaryRoot = [System.IO.Path]::GetFullPath($env:WORLDLINEBOX_UPDATE_CLEANUP_TEMP)
$installerPath = [System.IO.Path]::GetFullPath($installerPath)
$installerDirectory = [System.IO.Path]::GetFullPath($installerDirectory)
if (-not [string]::Equals([System.IO.Path]::GetDirectoryName($installerDirectory), $temporaryRoot.TrimEnd('\'), [System.StringComparison]::OrdinalIgnoreCase) -or
    -not [string]::Equals([System.IO.Path]::GetDirectoryName($installerPath), $installerDirectory, [System.StringComparison]::OrdinalIgnoreCase) -or
    [System.IO.Path]::GetFileName($installerDirectory) -notmatch '^worldlinebox-installer-[A-Za-z0-9]+$' -or
    [System.IO.Path]::GetFileName($installerPath) -ine 'WorldlineBoxSetup.exe') { exit 1 }
if ((Test-Path -LiteralPath $installerDirectory) -and
    ((Get-Item -LiteralPath $installerDirectory -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { exit 1 }
$installerProcessName = [System.IO.Path]::GetFileNameWithoutExtension($installerPath)
$installerProcessId = 0
[void][int]::TryParse($env:WORLDLINEBOX_UPDATE_CLEANUP_PID, [ref]$installerProcessId)

if ($installerProcessId -gt 0) {
  for ($attempt = 0; $attempt -lt 1800; $attempt++) {
    $installerStillRunning = $false
    $processes = @(Get-Process -Name $installerProcessName -ErrorAction SilentlyContinue)
    foreach ($installerProcess in $processes) {
      $runningPath = $null
      try { $runningPath = $installerProcess.Path } catch { }
      if ($null -eq $runningPath) {
        if ($installerProcess.Id -eq $installerProcessId) {
          $installerStillRunning = $true
          break
        }
        continue
      }
      if ([string]::Equals(
        $runningPath,
        $installerPath,
        [System.StringComparison]::OrdinalIgnoreCase
      )) {
        $installerStillRunning = $true
        break
      }
    }
    if (-not $installerStillRunning) { break }
    Start-Sleep -Milliseconds 500
  }
}

for ($attempt = 0; $attempt -lt 60; $attempt++) {
  try {
    if (Test-Path -LiteralPath $installerPath) {
      Remove-Item -LiteralPath $installerPath -Force -ErrorAction Stop
    }
    if (Test-Path -LiteralPath $installerDirectory) {
      # Extraction creates exactly one installer. Never recursively delete an
      # unexpected child or follow a link added while the application exits.
      if (Get-ChildItem -LiteralPath $installerDirectory -Force | Select-Object -First 1) { throw 'Unexpected installer directory contents.' }
      Remove-Item -LiteralPath $installerDirectory -Force -ErrorAction Stop
    }
    exit 0
  } catch {
    Start-Sleep -Milliseconds 500
  }
}

$logPath = $env:WORLDLINEBOX_UPDATE_CLEANUP_LOG
if (-not [string]::IsNullOrWhiteSpace($logPath)) {
  $entry = @{
    timestamp = [DateTime]::UtcNow.ToString('o')
    level = 'error'
    scope = 'app-update.cleanup'
    error = @{
      name = 'CleanupTimeout'
      message = 'The temporary Windows installer could not be removed after retrying.'
    }
    context = @{ artifactKind = 'windows-installer-cleanup' }
  } | ConvertTo-Json -Compress -Depth 5
  try {
    [System.IO.File]::AppendAllText(
      $logPath,
      $entry + [Environment]::NewLine,
      [System.Text.UTF8Encoding]::new($false)
    )
  } catch { }
}
exit 1
`;

export type WindowsInstallerCleanupInvocation = {
  executable: string;
  args: string[];
  env: NodeJS.ProcessEnv;
};

export function createWindowsInstallerCleanupInvocation(input: {
  installerPath: string;
  tempDirectory: string;
  installerPid?: number;
  logPath?: string;
  environment?: NodeJS.ProcessEnv;
}): WindowsInstallerCleanupInvocation {
  const installerPath = path.win32.normalize(input.installerPath);
  const directory = path.win32.dirname(installerPath);
  const temporaryRoot = path.win32.normalize(input.tempDirectory).replace(/\\+$/u, '');
  if (!path.win32.isAbsolute(installerPath) || !path.win32.isAbsolute(temporaryRoot)
    || path.win32.dirname(directory).toLowerCase() !== temporaryRoot.toLowerCase()
    || !/^worldlinebox-installer-[A-Za-z0-9]+$/u.test(path.win32.basename(directory))
    || path.win32.basename(installerPath).toLowerCase() !== 'worldlineboxsetup.exe') {
    throw new Error('Refusing cleanup outside an owned temporary installer directory.');
  }
  const systemRoot = input.environment?.SystemRoot ?? process.env.SystemRoot;
  const powershellExecutable = systemRoot === undefined
    ? 'powershell.exe'
    : path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const encodedScript = Buffer.from(CLEANUP_SCRIPT, 'utf16le').toString('base64');
  const encodedBootstrap = Buffer.from(CLEANUP_BOOTSTRAP, 'utf16le').toString('base64');

  return {
    executable: powershellExecutable,
    args: [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-WindowStyle',
      'Hidden',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      encodedBootstrap,
    ],
    env: {
      ...(input.environment ?? process.env),
      WORLDLINEBOX_UPDATE_CLEANUP_POWERSHELL: powershellExecutable,
      WORLDLINEBOX_UPDATE_CLEANUP_SCRIPT: encodedScript,
      WORLDLINEBOX_UPDATE_CLEANUP_INSTALLER: installerPath,
      WORLDLINEBOX_UPDATE_CLEANUP_DIRECTORY: directory,
      WORLDLINEBOX_UPDATE_CLEANUP_TEMP: temporaryRoot,
      WORLDLINEBOX_UPDATE_CLEANUP_PID: input.installerPid === undefined
        ? ''
        : String(input.installerPid),
      WORLDLINEBOX_UPDATE_CLEANUP_LOG: input.logPath ?? '',
    },
  };
}
