import path from 'node:path';

import { z } from 'zod';

import { companionStorageRequestSchema } from '../shared/companion-storage';
import { CompanionsStore } from './store';

const port = process.parentPort;
if (!port) throw new Error('Companion storage requires an Electron UtilityProcess.');
let store: CompanionsStore | undefined;
const initializeSchema = z.strictObject({ type: z.literal('storage.initialize'), databasePath: z.string().min(1).max(4096) });

port.on('message', (event: { data: unknown }) => {
  const input = event.data;
  if (typeof input !== 'object' || !input) return;
  if ('type' in input && input.type === 'storage.initialize') {
    try {
      if (store) throw new Error('伙伴存储已经启动。');
      const { databasePath } = initializeSchema.parse(input);
      if (!path.isAbsolute(databasePath)) throw new Error('伙伴存储路径必须是绝对路径。');
      store = new CompanionsStore(databasePath);
      port.postMessage({ type: 'storage.ready' });
    } catch (error) {
      port.postMessage({ type: 'storage.failed', error: error instanceof Error ? error.message : '伙伴存储无法启动。' });
    }
    return;
  }
  if ('type' in input && input.type === 'storage.close') {
    store?.close();
    store = undefined;
    port.postMessage({ type: 'storage.closed' });
    process.exit(0);
  }
  const request = companionStorageRequestSchema.safeParse(input);
  if (!request.success) return;
  const { requestId, command } = request.data;
  try {
    if (!store) throw new Error('伙伴存储尚未启动。');
    port.postMessage({ requestId, response: store.request(command) });
  } catch (error) {
    port.postMessage({ requestId, response: { ok: false, error: error instanceof Error ? error.message : '伙伴记录操作失败。' } });
  }
});

process.on('exit', () => store?.close());
port.postMessage({ type: 'storage.booted' });
