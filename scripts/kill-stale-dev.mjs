#!/usr/bin/env node
/**
 * Terminate orphaned WorldlineBox dev processes (Electron + Forge) for this repo.
 * Ctrl+C on `npm start` often leaves Electron alive while Vite dies → next
 * `npm start` hits single-instance focus on a dead renderer (black screen).
 */
import { execFileSync, execSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const projectRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function killStaleWorldlineBoxDevProcesses(root = projectRoot) {
  if (process.platform === "win32") {
    try {
      // Only this checkout's Electron executable may be terminated. Other
      // Electron projects and desktop applications belong to separate sessions.
      execFileSync('powershell.exe', ['-NoProfile', '-Command',
        '$target = [IO.Path]::GetFullPath($env:WORLDLINEBOX_DEV_EXECUTABLE); ' +
        'Get-CimInstance Win32_Process -Filter "Name = \'electron.exe\'" | ' +
        'Where-Object { $_.ExecutablePath -and ' +
        '[string]::Equals($_.ExecutablePath, $target, [StringComparison]::OrdinalIgnoreCase) -and ' +
        '($_.CommandLine -match \'\\s+\\.\\s*$|--type=(renderer|gpu-process|utility)\') } | ' +
        'ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }',
      ], {
        stdio: 'ignore',
        windowsHide: true,
        env: { ...process.env, WORLDLINEBOX_DEV_EXECUTABLE: path.join(root, 'node_modules', 'electron', 'dist', 'electron.exe') },
      });
    } catch {
      // No matching processes.
    }
    return;
  }

  const patterns = [
    `${root}/node_modules/electron/dist/Electron.app`,
    `${root}.*electron-forge start`,
    `${root}/node_modules/.bin/electron-forge`,
  ];
  for (const pattern of patterns) {
    try {
      execSync(`pkill -f "${pattern}"`, { stdio: "ignore" });
    } catch {
      // pkill exits 1 when nothing matched.
    }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  killStaleWorldlineBoxDevProcesses();
}
