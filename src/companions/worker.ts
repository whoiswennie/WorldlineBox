import path from 'node:path';

import { z } from 'zod';

import { companionStorageRequestSchema } from '../shared/companion-storage';
import { CompanionsStore } from './store';
import { inspectSelectedCompanionBackup, restoreCompanionDatabase } from './recovery-package';

const port = process.parentPort;
if (!port) throw new Error('Companion storage requires an Electron UtilityProcess.');
let store: CompanionsStore | undefined;
let indexing: ReturnType<typeof setTimeout> | undefined;
let resetting: ReturnType<typeof setImmediate> | undefined;
let resetRunning = false, resetNotifiedAt = 0;
let recoveryRunning = false;
function resetNextBatch() {
  if (!store || resetRunning) return;
  const current = store; resetRunning = true;
  void current.advanceReset().then(pending => {
    if (store !== current) return;
    if (!pending || Date.now() - resetNotifiedAt >= 250) { resetNotifiedAt = Date.now(); port!.postMessage({ type: 'storage.retire-changed', ...current.takeMemoryInvalidations() }); }
    if (pending) resetting = setImmediate(resetNextBatch);
  }).catch(error => port!.postMessage({ type: 'storage.retire-changed', error: error instanceof Error ? error.message : '伙伴删除清理失败。', ...current.takeMemoryInvalidations() }))
    .finally(() => { resetRunning = false; });
}
function indexNextBatch() {
  if (!store) return;
  try {
    const ready = store.backfillSearchIndex();
    const traceReady = store.backfillTraceIndex(200);
    port!.postMessage({ type: 'storage.index-changed' });
    if (!ready || !traceReady) indexing = setTimeout(indexNextBatch, 50);
  } catch (error) {
    port!.postMessage({ type: 'storage.index-failed', error: error instanceof Error ? error.message : '消息搜索索引更新失败。' });
  }
}
const initializeSchema = z.strictObject({ type: z.literal('storage.initialize'), databasePath: z.string().min(1).max(4096),
  hostRetention: z.strictObject({ libraryPath: z.string().min(1).max(4096), libraryId: z.string().min(1).max(100) }).optional() });
const recoverySchema = z.strictObject({ type: z.literal('storage.recover.initialize'), selection: initializeSchema.shape.hostRetention.unwrap(),
  operationId: z.uuid(), packagePath: z.string().min(1).max(4096), expectedManifestHash: z.string().regex(/^[a-f0-9]{64}$/u) });
const recoveryInspectSchema=z.strictObject({type:z.literal('storage.recovery.inspect'),selection:initializeSchema.shape.hostRetention.unwrap(),packagePath:z.string().min(1).max(4096)});

port.on('message', (event: { data: unknown }) => {
  const input = event.data;
  if (typeof input !== 'object' || !input) return;
  if('type' in input&&input.type==='storage.recovery.inspect'){
    try{if(store)throw new Error('只读检查必须使用独立恢复子进程。');const command=recoveryInspectSchema.parse(input);port.postMessage({type:'storage.recovery-inspected',recovery:inspectSelectedCompanionBackup(command.selection,command.packagePath)});}
    catch(error){port.postMessage({type:'storage.recovery-failed',error:error instanceof Error?error.message:'无法只读核验备份。'});}return;
  }
  if ('type' in input && input.type === 'storage.recover.initialize') {
    try {
      if (store) throw new Error('普通存储尚未关闭，不能进行离线账本恢复。');
      const command = recoverySchema.parse(input), recovery = restoreCompanionDatabase(command.selection, command);
      port.postMessage({ type: 'storage.recovered', recovery });
    } catch (error) { port.postMessage({ type: 'storage.recovery-failed', error: error instanceof Error ? error.message : '恢复失败，原备份与未知目标均未被覆盖。' }); }
    return;
  }
  if ('type' in input && input.type === 'storage.initialize') {
    try {
      if (store) throw new Error('伙伴存储已经启动。');
      const { databasePath, hostRetention } = initializeSchema.parse(input);
      if (!path.isAbsolute(databasePath)) throw new Error('伙伴存储路径必须是绝对路径。');
      store = new CompanionsStore(databasePath, undefined, { hostRetention, recoveryAuthority: hostRetention });
      port.postMessage({ type: 'storage.ready' });
      indexing = setTimeout(indexNextBatch, 50);
      resetting = setImmediate(resetNextBatch);
    } catch (error) {
      port.postMessage({ type: 'storage.failed', error: error instanceof Error ? error.message : '伙伴存储无法启动。' });
    }
    return;
  }
  if ('type' in input && input.type === 'storage.close') {
    if (indexing) clearTimeout(indexing);
    if (resetting) clearImmediate(resetting);
    store?.close();
    store = undefined;
    port.postMessage({ type: 'storage.closed' });
    process.exit(0);
  }
  const request = companionStorageRequestSchema.safeParse(input);
  if (!request.success) {
    // A stale Main/worker pair must settle its pending request rather than
    // silently leave task execution and progress waiting indefinitely.
    const requestId = companionStorageRequestSchema.shape.requestId.safeParse('requestId' in input ? input.requestId : undefined);
    if (requestId.success) port.postMessage({ requestId: requestId.data,
      response: { ok: false, error: '伙伴存储请求格式不匹配，请重启应用后重试。' } });
    return;
  }
  const { requestId, command } = request.data;
  if (recoveryRunning) { port.postMessage({requestId,response:{ok:false,error:'备份恢复正在独占存储，请完成本操作后再执行其他请求。'}}); return; }
  if (command.type === 'recovery.backup.create' || command.type === 'recovery.package.inspect' || command.type === 'recovery.restore') {
    if (!store) { port.postMessage({requestId,response:{ok:false,error:'伙伴存储尚未启动。'}}); return; }
    if (resetRunning) { port.postMessage({requestId,response:{ok:false,error:'退役清理仍在执行，请完成后再备份。'}}); return; }
    recoveryRunning=true;if(indexing)clearTimeout(indexing);if(resetting)clearImmediate(resetting);
    void store.recovery(command).then(response=>port.postMessage({requestId,response})).catch(error=>port.postMessage({requestId,response:{ok:false,error:error instanceof Error?error.message:'备份恢复失败。'}}))
      .finally(()=>{recoveryRunning=false;if(store){indexing=setTimeout(indexNextBatch,50);resetting=setImmediate(resetNextBatch);}}); return;
  }
  try {
    if (!store) throw new Error('伙伴存储尚未启动。');
    port.postMessage({ requestId, response: store.request(command) });
    if (command.type.startsWith('companion.retire')) { if (resetting) clearImmediate(resetting); resetting = setImmediate(resetNextBatch); }
  } catch (error) {
    port.postMessage({ requestId, response: { ok: false, error: error instanceof Error ? error.message : '伙伴记录操作失败。' } });
  }
});

process.on('exit', () => store?.close());
port.postMessage({ type: 'storage.booted' });
