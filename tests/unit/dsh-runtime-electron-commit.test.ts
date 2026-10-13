import { spawn } from 'node:child_process';
import { mkdtemp, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { rolldown } from 'rolldown';
import { describe, expect, it } from 'vitest';
import { path7za } from '7zip-bin';
import { removeManaged } from '../../src/main/dsh/files';

describe.skipIf(process.platform !== 'win32' || !process.env.WORLDLINEBOX_DSH_ELECTRON_COMMIT_INSTALLER)('physical official runtime commits in Electron main', () => {
  it('uses the existing installer in a long workspace path and recovers actual Windows sharing locks', async () => {
    const probeRoot = path.join(process.cwd(), '.tools', 'runtime-commit-probes'); await mkdir(probeRoot, { recursive: true });
    const root = await mkdtemp(path.join(probeRoot, 'electron-'));
    try {
      const script = path.join(root, 'electron-main.cjs');
      const bundle = await rolldown({ input: path.join(process.cwd(), 'tests', 'helpers', 'dsh-runtime-commit-electron.ts'),
        platform: 'node', external: ['electron', 'koffi', 'original-fs', /^node:/] });
      await bundle.write({ file: script, format: 'cjs' }); await bundle.close();
      const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(path.join(process.cwd(), 'node_modules', 'electron', 'dist', 'electron.exe'),
          [script, root, process.env.WORLDLINEBOX_DSH_ELECTRON_COMMIT_INSTALLER!, path7za],
          { cwd: process.cwd(), env, windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
        let text = ''; const timer = setTimeout(() => { child.kill(); reject(new Error(`Electron runtime probe timed out: ${text.slice(-5000)}`)); }, 240_000);
        child.stdout.on('data', chunk => { const line = chunk.toString(); text += line; if (line.includes('DSH_COMMIT_CASE')) process.stdout.write(line); });
        child.stderr.on('data', chunk => { text += chunk.toString(); });
        child.on('error', error => { clearTimeout(timer); reject(error); });
        child.on('close', code => { clearTimeout(timer); if (code === 0) resolve(text); else reject(new Error(`Electron runtime probe exited ${code}: ${text.slice(-6000)}`)); });
      });
      const resultLine = output.split(/\r?\n/).find(line => line.startsWith('DSH_COMMIT_RESULT ')); expect(resultLine).toBeDefined();
      const result = JSON.parse(resultLine!.slice('DSH_COMMIT_RESULT '.length));
      expect(result.electron).toBeTruthy(); expect(result.cases).toHaveLength(3);
      expect(result.cases.map((value: { nativeRenameCode: string }) => value.nativeRenameCode)).toEqual(['EPERM', 'EPERM', 'EPERM']);
    } finally { await removeManaged(probeRoot, root); }
  }, 270_000);
});
