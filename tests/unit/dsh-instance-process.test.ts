import { spawn } from 'node:child_process';
import { ownedWindowsProcessCreatedAt } from '../../src/main/dsh/windows-job';
import { describe, expect, it, vi } from 'vitest';
import {
  buildOwnedProcessTree, inspectOwnedWindowsTree, inspectProcess, stopOwnedWindowsTree, terminateOwnedProcess,
  type OwnedWindowsProcess, type WindowsTerminationTools,
} from '../../src/main/dsh/instance-process';

const root: OwnedWindowsProcess = { pid: 100, parentPid: 50, executable: 'C:\\runtime\\Harness.exe', createdAt: '2026-10-12T00:00:00.0000000Z' };
const descendant: OwnedWindowsProcess = { pid: 101, parentPid: 100, executable: 'C:\\runtime\\worker.exe', createdAt: '2026-10-12T00:00:01.0000000Z' };

function toolsFixture() {
  const current = new Map([root, descendant].map(process => [process.pid, process]));
  const tools: WindowsTerminationTools = {
    inspect: vi.fn(async (pids: number[]) => pids.flatMap(pid => current.get(pid) ? [current.get(pid)!] : [])),
    killTree: vi.fn(async () => undefined),
    killIdentity: vi.fn(async (identity: OwnedWindowsProcess) => { current.delete(identity.pid); }),
    pause: async () => undefined,
  };
  return { current, tools };
}

describe('owned Windows Harness tree termination', () => {
  it('records native child creation identity exactly as WMI recovery expects without a PowerShell startup', async () => {
    if (process.platform !== 'win32') return;
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const start = performance.now(), createdAt = ownedWindowsProcessCreatedAt(child.pid!);
      const nativeMs = performance.now() - start, beforeCim = performance.now(), recovered = await inspectProcess(child.pid!);
      expect(createdAt).toBe(recovered!.createdAt);
      console.log('DSH_IDENTITY_TIMING', JSON.stringify({ nativeMs, cimMs: performance.now() - beforeCim }));
    } finally { await terminateOwnedProcess(child); }
  });
  it('accepts taskkill stale-child errors once every saved process identity has disappeared', async () => {
    const { current, tools } = toolsFixture();
    tools.killTree = vi.fn(async () => { current.clear(); throw new Error('A child reported operation not supported.'); });
    await expect(stopOwnedWindowsTree([root, descendant], tools)).resolves.toBeUndefined();
    expect(tools.killIdentity).not.toHaveBeenCalled();
  });

  it('kills only a remaining owned descendant after taskkill exits its root and reports an error', async () => {
    const { current, tools } = toolsFixture();
    tools.killTree = vi.fn(async () => { current.delete(root.pid); throw new Error('Child operation not supported.'); });
    await expect(stopOwnedWindowsTree([root, descendant], tools)).resolves.toBeUndefined();
    expect(tools.killIdentity).toHaveBeenCalledExactlyOnceWith(descendant);
  });

  it('never kills a reused PID even when its replacement has the same executable name', async () => {
    const { current, tools } = toolsFixture();
    tools.killTree = vi.fn(async () => { current.clear(); current.set(descendant.pid, { ...descendant, createdAt: '2026-10-12T00:10:00.0000000Z' }); throw new Error('Child no longer belongs to this tree.'); });
    await expect(stopOwnedWindowsTree([root, descendant], tools)).resolves.toBeUndefined();
    expect(tools.killIdentity).not.toHaveBeenCalled();
    expect(current.has(descendant.pid)).toBe(true);
  });

  it('refuses success when an identity-matched process remains alive after both strategies', async () => {
    const { tools } = toolsFixture(); tools.killTree = vi.fn(async () => { throw new Error('Refused'); });
    tools.killIdentity = vi.fn(async () => { throw new Error('Refused'); });
    await expect(stopOwnedWindowsTree([root, descendant], tools)).rejects.toThrow('data remains locked');
    expect(tools.killIdentity).toHaveBeenNthCalledWith(1, descendant); expect(tools.killIdentity).toHaveBeenNthCalledWith(2, root);
  });

  it('does not associate an older process with a reused parent PID and follows the actual descendant chain', () => {
    const oldChild = { ...descendant, pid: 102, createdAt: '2026-10-11T00:00:00.0000000Z' };
    const grandchild = { ...descendant, pid: 103, parentPid: descendant.pid, createdAt: '2026-10-12T00:00:02.0000000Z' };
    expect(buildOwnedProcessTree([grandchild, oldChild, descendant, root], root.pid)).toEqual([root, descendant, grandchild]);
  });

  it('actually stops an owned Windows root and descendant while leaving an unrelated Node process alive', async () => {
    if (process.platform !== 'win32') return;
    const childProgram = "setInterval(() => {}, 1000)";
    const rootProgram = `const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e',${JSON.stringify(childProgram)}],{windowsHide:true,stdio:'ignore'}); console.log(child.pid); setInterval(()=>{},1000);`;
    const owned = spawn(process.execPath, ['-e', rootProgram], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const unrelated = spawn(process.execPath, ['-e', childProgram], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    try {
      const descendantPid = await new Promise<number>((resolve, reject) => {
        owned.stdout.once('data', chunk => resolve(Number(String(chunk).trim()))); owned.once('error', reject);
      });
      expect(descendantPid).toBeGreaterThan(0); expect(owned.pid).toBeGreaterThan(0);
      const tree = await inspectOwnedWindowsTree(owned.pid!);
      expect(tree.map(process => process.pid)).toContain(descendantPid);
      expect(tree.map(process => process.pid)).not.toContain(unrelated.pid);
      await terminateOwnedProcess(owned);
      expect(await inspectProcess(owned.pid!)).toBeUndefined(); expect(await inspectProcess(descendantPid)).toBeUndefined();
      expect(await inspectProcess(unrelated.pid!)).toBeDefined();
    } finally { await terminateOwnedProcess(owned); await terminateOwnedProcess(unrelated); }
  }, 40_000);
});
