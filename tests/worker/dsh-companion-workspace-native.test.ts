import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram } from '../helpers/companion-dsh-real-route';

type Created = { sessionId: string; workspace?: { id: string; title: string; path: string; sessionIds: string[] } };
it.skipIf(process.platform !== 'win32' || !existsSync(path.join(process.env.APPDATA ?? '', 'WorldlineBox/dsh/runtimes.json')))(
  'groups real native Sessions under their partner name, reuses membership and preserves it across Host restart without model calls', async () => {
    let requests = 0;
    const server = createServer((_request, response) => { requests++; response.writeHead(500).end(); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('Probe server failed.');
    const native = await createNativeAcceptanceBroker({ program: await installedDshAcceptanceProgram(), apiKey: 'workspace-probe', model: 'deepseek-flash', baseURL: `http://127.0.0.1:${address.port}/v1` });
    try {
      let client = await native.instances.ensureHost(native.instance.id);
      const cwd = path.join(native.root, 'partner-work', 'fish'), otherCwd = path.join(native.root, 'partner-work', 'other');
      await mkdir(cwd, { recursive: true }); await mkdir(otherCwd, { recursive: true });
      const ids = [randomUUID(), randomUUID()];
      const sessions = await Promise.all(ids.map(sessionId => client.request<Created>('/sessions', { sessionId, cwd, workspaceTitle: '小肥鱼' })));
      const grouped = await client.request<Created>('/sessions', { sessionId: ids[0], cwd, workspaceTitle: '小肥鱼' });
      expect(sessions[0]!.workspace!.id).toBe(sessions[1]!.workspace!.id);
      expect(grouped.workspace).toMatchObject({ title: '小肥鱼', sessionIds: expect.arrayContaining(ids) });
      const other = await client.request<Created>('/sessions', { sessionId: randomUUID(), cwd: otherCwd, workspaceTitle: '小肥鱼' });
      expect(other.workspace!.id).not.toBe(grouped.workspace!.id);
      const renamed = await client.request<Created>('/sessions', { sessionId: ids[0], cwd, workspaceTitle: '小肥鱼改名' });
      expect(renamed.workspace).toMatchObject({ id: grouped.workspace!.id, title: '小肥鱼改名' });
      const pid = client.pid; await native.instances.stop(native.instance.id); client = await native.instances.ensureHost(native.instance.id);
      const restored = await client.request<Created>('/sessions', { sessionId: ids[0], resume: true, cwd, workspaceTitle: '小肥鱼改名' });
      expect(restored.workspace).toMatchObject({ id: grouped.workspace!.id, title: '小肥鱼改名', sessionIds: expect.arrayContaining(ids) });
      const reset = await client.request<{ archived: string[]; removedWorkspaces: string[] }>('/companions/reset', { sessionIds: ids, workspacePaths: [cwd] });
      expect(reset.archived).toEqual(expect.arrayContaining(ids)); expect(reset.removedWorkspaces).toEqual([grouped.workspace!.id]);
      await client.request('/companions/reset', { sessionIds: ids, workspacePaths: [cwd] });
      const preserved = await client.request<Created>('/sessions', { sessionId: other.sessionId, resume: true, cwd: otherCwd, workspaceTitle: '小肥鱼' });
      expect(preserved.workspace!.id).toBe(other.workspace!.id);
      expect(requests).toBe(0);
      const report = { status: 'passed', runtimeVersion: native.runtimeVersion, pid, restartedPid: client.pid, grouped, renamed, restored, reset, resetIdempotent: true, otherWorkspace: preserved.workspace, modelRequests: requests };
      await mkdir(path.resolve('artifacts/companion-workspace-native'), { recursive: true });
      await writeFile(path.resolve('artifacts/companion-workspace-native/result.json'), JSON.stringify(report, null, 2));
    } finally { await native.dispose(); await new Promise<void>(resolve => server.close(() => resolve())); }
  }, 120000,
);
