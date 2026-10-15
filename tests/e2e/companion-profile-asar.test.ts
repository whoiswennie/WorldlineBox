import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire, builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPackage, listPackage } from '@electron/asar';
import { expect, test } from '@playwright/test';
import sharp from 'sharp';
import { build } from 'vite';

const require = createRequire(path.join(process.cwd(), 'package.json'));
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Report = { error?: string; electronVersion: string; ready: boolean; runAsNode: boolean; windows: number;
  personId: string; absolutePath: string; available: boolean; originalHash: string; copiedHash: string;
  visualInputs: Array<{ personId: string; role: string; mime: string; sha256: string; bytes: number }> };
async function cleanup(root: string): Promise<void> {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('worldlinebox-profile-asar-e2e-')) throw new Error('Unexpected isolated ASAR fixture cleanup.');
  await rm(resolved, { recursive: true, force: true, maxRetries: 10, retryDelay: 150 });
}

test('materializes the actual hashed ASAR portrait to a normal OS file before passing bound pixels to the model', async () => {
  const testInfo = test.info();
  test.setTimeout(60000);
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-profile-asar-e2e-'));
  const project = process.cwd(), source = path.join(root, 'package-source'), archive = path.join(root, 'program', 'resources', 'app.asar');
  const managed = path.join(root, 'managed'), entry = path.join(root, 'fixture-main.ts'), reportPath = path.join(root, 'report.json');
  const buildPath = path.join(root, 'fixture-build'); let child: ReturnType<typeof spawn> | undefined;
  try {
    const sourceFile = path.join(source, '.vite', 'renderer', 'main_window', 'assets', 'deepseek-flash-testhash.png');
    await mkdir(path.dirname(sourceFile), { recursive: true }); await mkdir(path.dirname(archive), { recursive: true }); await mkdir(managed);
    const original = await sharp({ create: { width: 192, height: 192, channels: 3, background: '#bc4f85' } }).png().toBuffer();
    await writeFile(sourceFile, original); await createPackage(source, archive);
    expect(listPackage(archive, { isPack: false }).filter(name => name.endsWith('.png')).map(name => name.replace(/\\/gu, '/'))).toEqual(['/.vite/renderer/main_window/assets/deepseek-flash-testhash.png']);
    const archiveBefore = sha(await readFile(archive));
    const constants = { archive, managed, reportPath, userData: path.join(root, 'electron-profile'), sessionData: path.join(root, 'electron-session') };
    await mkdir(constants.userData); await mkdir(constants.sessionData);
    const code = `import { app, BrowserWindow } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { CompanionPublicProfiles } from ${JSON.stringify(path.join(project, 'src', 'main', 'companions', 'public-profiles.ts'))};
const fixture = ${JSON.stringify(constants)};
app.setName('WorldlineBox isolated portrait ASAR verification');
app.setPath('userData', fixture.userData); app.setPath('sessionData', fixture.sessionData); app.disableHardwareAcceleration();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
app.whenReady().then(async () => {
  const member = { id: 'deepseek-flash', name: 'Synthetic Flash', description: 'Isolated generated test image.', persona: 'Synthetic fixture.', model: '', avatar: 'flash', builtin: true, proactive: false, createdAt: new Date().toISOString(), revision: 1 };
  const room = { id: 'fixture-room', kind: 'group', title: 'Isolated verification', memberIds: [member.id], pinned: false, muted: false, unread: 0, updatedAt: new Date().toISOString(), lastMessage: '' };
  const state = { companions: [member], conversations: [room], activities: [], configured: false };
  const loader = new CompanionPublicProfiles({ root: fixture.managed, appPath: fixture.archive, request: async command => {
    if (command.type !== 'state') throw new Error('Unexpected fixture storage operation: ' + command.type);
    return { ok: true, state };
  } });
  const result = await loader.prepare({ companionId: member.id, conversation: room, sourceAuthorId: member.id, audience: 'peers' });
  const profile = result.publicProfiles.find(person => person.id === member.id), image = profile?.avatar;
  if (!image?.available) throw new Error('The real packaged portrait did not become available.');
  const report = { electronVersion: process.versions.electron, ready: app.isReady(), runAsNode: process.env.ELECTRON_RUN_AS_NODE === '1', windows: BrowserWindow.getAllWindows().length,
    personId: profile.id, absolutePath: image.absolutePath, available: image.available, originalHash: image.sha256, copiedHash: sha(await readFile(image.absolutePath)),
    visualInputs: result.visualInputs.map(image => ({ personId: image.personId, role: image.role, mime: image.mime, sha256: image.sha256, bytes: Buffer.from(image.base64, 'base64').length })) };
  await writeFile(fixture.reportPath, JSON.stringify(report, null, 2)); app.exit(0);
}).catch(async error => { await writeFile(fixture.reportPath, JSON.stringify({ error: error.stack || String(error) })); app.exit(1); });
`;
    await writeFile(entry, code);
    await build({ configFile: false, root: project, logLevel: 'silent', resolve: { conditions: ['node'] },
      build: { outDir: buildPath, emptyOutDir: false, minify: false, lib: { entry, formats: ['cjs'], fileName: () => 'fixture-main.cjs' },
        rollupOptions: { external: ['electron', 'sharp', ...builtinModules, ...builtinModules.map(name => 'node:' + name)], output: { paths: { sharp: require.resolve('sharp').replace(/\\/gu, '/') } } } } });
    const bootstrap = path.join(root, 'bootstrap.cjs');
    await writeFile(bootstrap, `const { app } = require('electron'); const { writeFileSync } = require('node:fs');
const fail = error => { writeFileSync(${JSON.stringify(reportPath)}, JSON.stringify({ error: error.stack || String(error) })); app.exit(1); };
process.on('uncaughtException', fail); process.on('unhandledRejection', fail);
try { require(${JSON.stringify(path.join(buildPath, 'fixture-main.cjs'))}); } catch (error) { fail(error); }
`);
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const executable = require('electron') as string;
    child = spawn(executable, [bootstrap], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = ''; child.stdout?.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-16000); }); child.stderr?.on('data', bytes => { diagnostics = (diagnostics + String(bytes)).slice(-16000); });
    const running = child;
    const outcome = await new Promise<number | null>((resolve, reject) => {
      const deadline = setTimeout(() => { running.kill(); reject(new Error('Isolated ASAR Electron fixture timed out. ' + diagnostics)); }, 25000);
      running.once('error', error => { clearTimeout(deadline); reject(error); }); running.once('exit', code => { clearTimeout(deadline); resolve(code); });
    });
    child = undefined;
    const report = JSON.parse(await readFile(reportPath, 'utf8')) as Report;
    expect(outcome, report.error ?? diagnostics).toBe(0); expect(report.error).toBeUndefined();
    expect(report.electronVersion).toBeTruthy(); expect(report.ready).toBe(true); expect(report.runAsNode).toBe(false); expect(report.windows).toBe(0);
    expect(report.personId).toBe('deepseek-flash'); expect(report.available).toBe(true); expect(path.isAbsolute(report.absolutePath)).toBe(true);
    expect(report.absolutePath).not.toContain('app.asar'); expect(path.relative(managed, report.absolutePath)).toMatch(/^portraits[/\\]/u);
    // This is ordinary Node after the Electron child has exited, so ASAR-only virtual paths cannot pass.
    const externalBytes = await readFile(report.absolutePath);
    expect(sha(externalBytes)).toBe(sha(original)); expect(externalBytes).toEqual(original); expect(report.originalHash).toBe(sha(original)); expect(report.copiedHash).toBe(sha(original));
    expect(report.visualInputs).toHaveLength(1); expect(report.visualInputs[0]).toMatchObject({ personId: 'deepseek-flash', role: 'avatar', mime: 'image/jpeg' });
    expect(report.visualInputs[0]!.sha256).toMatch(/^[a-f0-9]{64}$/u); expect(report.visualInputs[0]!.bytes).toBeLessThanOrEqual(1024 * 1024);
    expect(sha(await readFile(archive))).toBe(archiveBefore);
    const evidence = { realElectron: true, electronVersion: report.electronVersion, runAsNode: false, windows: report.windows, actualAsar: true,
      archiveAsset: '.vite/renderer/main_window/assets/deepseek-flash-testhash.png', archiveUnchanged: true, exposedPathAbsolute: true, exposedPathOutsideArchive: true,
      normalNodeRead: true, personId: report.personId, sourceSha256: sha(original), copiedSha256: sha(externalBytes), visualInputs: report.visualInputs };
    const evidencePath = path.join(project, '.tools', 'test-output', 'companions', 'verified-companion-profile-asar.json');
    await mkdir(path.dirname(evidencePath), { recursive: true }); await writeFile(evidencePath, JSON.stringify(evidence, null, 2) + '\n');
    await testInfo.attach('actual-asar-public-profile-evidence', { body: JSON.stringify(evidence, null, 2), contentType: 'application/json' });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const closed = new Promise<void>(resolve => child!.once('exit', () => resolve())); child.kill(); await closed; }
    await cleanup(root);
  }
});
