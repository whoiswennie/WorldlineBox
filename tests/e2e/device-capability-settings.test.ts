import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { EmbeddingDeviceCapability } from '../../src/shared/embedding/device-capability';
import type { WorldlineBoxLibraryApi } from '../../src/shared/library-api';
import { electronLaunchEnv, preparePackagedCompanionLaunch, removeCompanionTestDirectory, resolveElectronLaunchOptions } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { library: WorldlineBoxLibraryApi } };
type OwnedRuntime = { pid: number; parentPid: number; loadsModel: boolean; gpuLayers: number | null; device: string | null };

// Actual production capability routes and bundled inference. Nothing replaces
// hardware, vectors, canvas contexts, native process launch, or provider output.
// An unsupported CPU-only machine records its real limitation instead of
// manufacturing a successful GPU result. The current GPU acceptance host must
// pass the short real GPU sample when its actual inventory has a usable device.
// eslint-disable-next-line no-empty-pattern
test('checks the real bundled device from Settings, keeps status reads inference-free and independently probes WebGL2', async ({}, testInfo) => {
  test.setTimeout(240_000);
  const root = mkdtempSync(path.join(tmpdir(), 'worldlinebox-device-settings-')), profile = path.join(root, 'profile');
  const cache = path.join(profile, 'embedding-models', 'device-capability-v1.json');
  const evidence = path.resolve('artifacts/vcp-validation/device-settings'); mkdirSync(evidence, { recursive: true });
  let application: ElectronApplication | undefined;
  const observed: Array<{ phase: string; at: string; processes: OwnedRuntime[] }> = [];
  const diagnostics: string[] = [];
  try {
    application = await electron.launch({ ...resolveElectronLaunchOptions(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'hardware' }) });
    application.process().stderr?.on('data', chunk => diagnostics.push(String(chunk)));
    await preparePackagedCompanionLaunch(application, profile);
    const page = await application.firstWindow(), native = await application.browserWindow(page);
    await native.evaluate(win => { win.unmaximize(); win.setContentSize(1440, 960); win.setFocusable(false); win.setOpacity(0); win.webContents.setBackgroundThrottling(false); win.hide(); win.showInactive(); });
    await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page');
    const sample = async (phase: string) => {
      const processes = await ownedRuntimeChildren(application!);
      observed.push({ phase, at: new Date().toISOString(), processes }); return processes;
    };
    expect(await sample('before-settings')).toEqual([]);
    expect(existsSync(cache)).toBe(false);
    await page.getByRole('button', { name: '设置', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '通用设置', exact: true });
    await settings.getByRole('tab', { name: '全局模型', exact: true }).click();
    const capabilities = settings.getByRole('region', { name: '设备能力', exact: true });
    const embedding = capabilities.getByRole('article', { name: '本地向量设备检测', exact: true });
    const world = capabilities.getByRole('article', { name: '3D 世界设备检测', exact: true });
    await capabilities.scrollIntoViewIfNeeded();
    const initial = await status(page);
    expect(initial.state).not.toBe('testing'); expect(initial.metrics).toBeUndefined();
    const model = settings.getByRole('listitem', { name: '内置多模态向量服务', exact: true });
    await expect(model.getByRole('status')).toHaveText('文件已就绪', { timeout: 30_000 });
    await expect(embedding.getByRole('status')).toHaveText(initial.state === 'unchecked' ? '未检测' : initial.state === 'unsupported' ? '设备受限' : '检测未完成');
    for (let index = 0; index < 3; index++) {
      const read = await status(page); expect(read.metrics).toBeUndefined(); expect(read.state).not.toBe('testing');
      expect(await sample('status-only-' + index)).toEqual([]);
    }
    expect(existsSync(cache)).toBe(false);

    // The real 3D action is independent: no scene/model is loaded and the
    // embedding capability must still be unmeasured afterwards.
    await world.getByRole('button', { name: '检测设备', exact: true }).click();
    const hardware = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.library.deviceHardwareStatus());
    expect(hardware.ok).toBe(true); if (!hardware.ok) throw new Error(hardware.error.message);
    const webgl = await page.evaluate(() => {
      const canvas = document.createElement('canvas'); canvas.width = canvas.height = 1;
      const gl = canvas.getContext('webgl2', { antialias: true, alpha: false, powerPreference: 'high-performance' });
      try { return { webgl2: gl !== null, contextLost: gl?.isContextLost() ?? false, attributes: gl?.getContextAttributes() ?? null }; }
      finally { gl?.getExtension('WEBGL_lose_context')?.loseContext(); canvas.remove(); }
    });
    const expected3D = webgl.webgl2 && !webgl.contextLost && webgl.attributes !== null && hardware.value.totalMemoryBytes >= 4 * 1024 ** 3;
    await expect(world.getByRole('status')).toHaveText(expected3D ? '可以使用' : '设备受限');
    await expect(world).toContainText('检测于');
    if (expected3D) await expect(world).toContainText('图形环境通过基础检查');
    else await expect(world).toContainText('3D 画面暂不可用；伙伴聊天与世界生活仍可继续');
    expect((await status(page)).metrics).toBeUndefined(); expect(await sample('after-webgl-only')).toEqual([]);
    expect(await page.getByRole('img', { name: '伙伴世界三维场景', exact: true }).count()).toBe(0);
    expect(existsSync(cache)).toBe(false);

    const clickedAt = Date.now();
    await embedding.getByRole('button', { name: '检测设备', exact: true }).click();
    let capability: EmbeddingDeviceCapability | undefined, sampledDuringRuntime = false;
    await expect.poll(async () => {
      capability = await status(page);
      if (capability.state === 'testing' && capability.backend && !sampledDuringRuntime) {
        await sample('during-explicit-short-test'); sampledDuringRuntime = true;
      }
      return capability.state;
    }, { timeout: 100_000, intervals: [100, 250, 500, 1000] }).toMatch(/^(supported|unsupported|error)$/u);
    capability ??= await status(page);
    // A runtime error is a real failed acceptance result, never promoted to
    // "unsupported" or hidden by synthetic hardware/latency fixtures.
    expect(capability.state, capability.message).not.toBe('error');
    const eligibleGpu = !!capability.hardware?.gpus.some(gpu => gpu.freeMemoryMiB >= 1536)
      && (capability.hardware?.availableMemoryBytes ?? 0) >= capability.budgets.minimumAvailableMemoryBytes;
    if (eligibleGpu) {
      expect(capability.backend, capability.message).toBe('gpu'); expect(capability.state, capability.message).toBe('supported');
      expect(capability.deviceName).toBeTruthy();
    } else if (capability.state === 'unsupported') expect(['memory_pressure', 'latency']).toContain(capability.reason);
    if (capability.metrics) {
      expect(capability.metrics.textMs).toHaveLength(3);
      expect(capability.metrics.textMs.every(time => time > 0)).toBe(true); expect(capability.metrics.imageMs).toBeGreaterThan(0);
      expect(Date.parse(capability.testedAt!)).toBeGreaterThanOrEqual(clickedAt); expect(existsSync(cache)).toBe(true);
    }
    await expect(embedding.getByRole('status')).toHaveText(capability.state === 'supported' ? '可以使用' : '设备受限');
    await expect.poll(() => sample('after-explicit-test'), { timeout: 15_000 }).toEqual([]);
    const saved = await status(page);
    expect(saved.state).toBe(capability.state); expect(saved.metrics).toEqual(capability.metrics);
    expect(await sample('after-result-status')).toEqual([]);
    const screenshots = [];
    for (const [theme, width] of [['light', 1440], ['dark', 1440], ['light', 1040]] as const) {
      await native.evaluate((win, width) => win.setContentSize(width, 960), width);
      await settings.getByRole('tab', { name: '外观', exact: true }).click();
      await settings.getByRole('radio', { name: 'WorldlineBox', exact: true }).click();
      await settings.getByRole('radio', { name: theme === 'light' ? '亮色' : '暗色', exact: true }).click();
      await settings.getByRole('tab', { name: '全局模型', exact: true }).click(); await capabilities.scrollIntoViewIfNeeded();
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      const geometry = await capabilities.evaluate(node => ({ innerWidth, width: node.clientWidth, scroll: node.scrollWidth,
        overflowingButtons: [...node.querySelectorAll('button')].some(button => { const box = button.getBoundingClientRect(), parent = node.getBoundingClientRect(); return box.left < parent.left - 1 || box.right > parent.right + 1; }) }));
      expect(geometry.innerWidth).toBe(width); expect(geometry.scroll).toBeLessThanOrEqual(geometry.width + 1); expect(geometry.overflowingButtons).toBe(false);
      const file = `device-capabilities-${theme}-${width}.png`; await page.screenshot({ path: path.join(evidence, file), animations: 'disabled' }); screenshots.push({ file, theme, ...geometry });
    }
    const proof = { generatedAt: new Date().toISOString(), isolatedProfile: true, syntheticHardwareOrInference: false,
      statusOnlyInferenceProcessesObserved: false, processScope: 'Only descendants of this Electron Main; --list-devices inventory is not a loaded model.',
      processSamples: observed, embeddingCapability: capability, actualWebgl2: webgl, hardware: hardware.value, expected3DAvailable: expected3D,
      scope: 'Three fixed short texts and one 224px image. It does not assert large-media throughput or general model quality.', screenshots };
    writeFileSync(path.join(evidence, 'real-device-ui-proof.json'), JSON.stringify(proof, null, 2), 'utf8');
    await testInfo.attach('actual-device-settings-proof', { body: JSON.stringify(proof), contentType: 'application/json' });
  } finally {
    await testInfo.attach('device-electron-stderr', { body: diagnostics.join('').slice(-80_000), contentType: 'text/plain' });
    await application?.close().catch(() => undefined); cleanup(root);
  }
});

async function status(page: Page) {
  const response = await page.evaluate(() => (window as unknown as Bridge).worldlinebox.library.embeddingDeviceStatus());
  expect(response.ok).toBe(true); if (!response.ok) throw new Error(response.error.message); return response.value;
}
async function ownedRuntimeChildren(application: ElectronApplication): Promise<OwnedRuntime[]> {
  return application.evaluate(() => {
    const child = process.getBuiltinModule('node:child_process');
    let rows: Array<{ ProcessId: number; ParentProcessId: number; Name: string; CommandLine: string }>;
    if (process.platform === 'win32') {
      // Same read-only owned-descendant traversal as semantic-sqlite-lifecycle.
      const script = `$all = @(Get-CimInstance Win32_Process); $ids = [System.Collections.Generic.HashSet[uint32]]::new(); [void]$ids.Add(${process.pid}); do { $added = $false; foreach ($entry in $all) { if ($ids.Contains([uint32]$entry.ParentProcessId) -and $ids.Add([uint32]$entry.ProcessId)) { $added = $true } } } while ($added); @($all | Where-Object { $_.Name -eq 'llama-server.exe' -and $ids.Contains([uint32]$_.ProcessId) } | Select-Object ProcessId,ParentProcessId,Name,CommandLine) | ConvertTo-Json -Compress`;
      const output = child.execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 }).trim();
      const parsed: unknown = output ? JSON.parse(output) : []; rows = (Array.isArray(parsed) ? parsed : [parsed]) as typeof rows;
    } else {
      rows = child.execFileSync('ps', ['-eo', 'pid=,ppid=,comm=,args='], { encoding: 'utf8', timeout: 10_000 }).split(/\r?\n/u).flatMap(line => {
        const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/u.exec(line); return match ? [{ ProcessId: Number(match[1]), ParentProcessId: Number(match[2]), Name: match[3]!, CommandLine: match[4]! }] : [];
      });
      const ids = new Set([process.pid]); let added = true;
      while (added) { added = false; for (const row of rows) if (ids.has(row.ParentProcessId) && !ids.has(row.ProcessId)) { ids.add(row.ProcessId); added = true; } }
      rows = rows.filter(row => ids.has(row.ProcessId) && /(?:^|\/)llama-server$/u.test(row.Name));
    }
    return rows.filter(row => /(?:^|\s)--model(?:\s|=)/u.test(row.CommandLine ?? '')).map(row => {
      const gpu = /--n-gpu-layers(?:\s+|=)(\d+)/u.exec(row.CommandLine), device = /--device(?:\s+|=)([A-Za-z]+\d+)/u.exec(row.CommandLine);
      return { pid: row.ProcessId, parentPid: row.ParentProcessId, loadsModel: true, gpuLayers: gpu ? Number(gpu[1]) : null, device: device?.[1] ?? null };
    });
  });
}
function cleanup(root: string) {
  if (path.dirname(root) !== tmpdir() || !path.basename(root).startsWith('worldlinebox-device-settings-')) throw new Error('Unexpected device settings fixture cleanup target.');
  removeCompanionTestDirectory(root);
}
