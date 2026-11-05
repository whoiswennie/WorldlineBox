import type { BrowserWindow, IpcMain, IpcMainInvokeEvent, WebContents } from 'electron';
import { BOT_SPEECH_CHANNEL, botSpeechRequestSchema, type BotSpeechRequest, type BotSpeechResponse } from '../../shared/companion-bot-speech';

export interface BotSpeechIpcService {
  request(input: BotSpeechRequest): Promise<BotSpeechResponse>;
  cancel(requestId: string): unknown;
  dispose(): void;
}
export interface BotSpeechIpcDependencies {
  ipc: Pick<IpcMain, 'handle' | 'removeHandler'>;
  getMainWindow(): Pick<BrowserWindow, 'isDestroyed' | 'webContents'> | undefined;
  ensureReady(conversationId: string): Promise<unknown>;
  /** Return a new owned instance; do not reuse an external singleton. */
  createSpeechService(): BotSpeechIpcService | Promise<BotSpeechIpcService>;
  isClosing(): boolean;
  report?(error: unknown): void;
}
type Synthesize = Extract<BotSpeechRequest, { type: 'speech.synthesize' }>;
interface Pending { generation: number; fingerprint: string; abort: AbortController; promise: Promise<BotSpeechResponse> }
interface Creating { generation: number; promise: Promise<BotSpeechIpcService> }
interface Owner {
  contents: WebContents; generation: number; closed: boolean; pending: Map<string, Pending>; cancelled: Set<string>;
  service?: BotSpeechIpcService; creating?: Creating; detach(): void;
}
const cancelled = (): BotSpeechResponse => ({ ok: false, cancelled: true });
const cancelledError = () => Object.assign(Error('Speech request cancelled'), { name: 'AbortError' });

/** Waiters cancel immediately; a late shared initializer remains observed. */
function waitFor<T>(task: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (complete: () => void) => { if (settled) return; settled = true; signal.removeEventListener('abort', abort); complete(); };
    const abort = () => finish(() => reject(cancelledError()));
    void task.then(value => finish(() => resolve(value)), error => finish(() => reject(error)));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
}

/** Main-only IPC with per-document ownership across lazy initialization and navigation. */
export function registerBotSpeechIpc(deps: BotSpeechIpcDependencies): () => void {
  const owners = new WeakMap<WebContents, Owner>(), live = new Set<Owner>(); let disposed = false;
  const trusted = (event: IpcMainInvokeEvent): boolean => {
    try { const window = deps.getMainWindow(); return !disposed && !deps.isClosing() && !!window && !window.isDestroyed() && !event.sender.isDestroyed() && event.sender === window.webContents && event.senderFrame === window.webContents.mainFrame; }
    catch { return false; }
  };
  const safely = (run: () => void) => { try { run(); } catch (error) { deps.report?.(error); } };
  const invalidate = (owner: Owner, terminal = false) => {
    owner.generation++; owner.closed ||= terminal;
    for (const [id, pending] of owner.pending) { pending.abort.abort(); safely(() => { owner.service?.cancel(id); }); }
    owner.pending.clear(); owner.cancelled.clear();
    const service = owner.service; owner.service = undefined; if (service) safely(() => service.dispose());
    // The initializer's own completion handler disposes a late instance.
    owner.creating = undefined;
    if (terminal) { owner.detach(); owners.delete(owner.contents); live.delete(owner); }
  };
  const getOwner = (contents: WebContents): Owner => {
    const existing = owners.get(contents); if (existing) return existing;
    const owner: Owner = { contents, generation: 0, closed: false, pending: new Map(), cancelled: new Set(), detach: () => undefined };
    const navigate = (_event: Electron.Event, _url: string, inPlace: boolean, isMainFrame: boolean) => { if (isMainFrame && !inPlace) invalidate(owner); };
    const gone = () => invalidate(owner), destroyed = () => invalidate(owner, true);
    contents.on('did-start-navigation', navigate); contents.on('render-process-gone', gone); contents.once('destroyed', destroyed);
    owner.detach = () => { contents.removeListener('did-start-navigation', navigate); contents.removeListener('render-process-gone', gone); contents.removeListener('destroyed', destroyed); };
    owners.set(contents, owner); live.add(owner); return owner;
  };
  const current = (event: IpcMainInvokeEvent, owner: Owner, pending: Pending) => trusted(event) && !owner.closed && owner.generation === pending.generation && !pending.abort.signal.aborted;
  const serviceFor = (owner: Owner): Promise<BotSpeechIpcService> => {
    if (owner.service) return Promise.resolve(owner.service);
    if (owner.creating?.generation === owner.generation) return owner.creating.promise;
    const entry: Creating = { generation: owner.generation, promise: Promise.resolve().then(() => deps.createSpeechService()).then(service => {
      if (disposed || deps.isClosing() || owner.closed || owner.generation !== entry.generation) safely(() => service.dispose());
      else owner.service = service;
      return service;
    }).finally(() => { if (owner.creating === entry) owner.creating = undefined; }) };
    owner.creating = entry;
    return entry.promise;
  };
  const run = async (event: IpcMainInvokeEvent, owner: Owner, input: Synthesize, pending: Pending): Promise<BotSpeechResponse> => {
    try {
      if (!current(event, owner, pending)) return cancelled();
      await waitFor(deps.ensureReady(input.conversationId), pending.abort.signal);
      if (!current(event, owner, pending)) return cancelled();
      const service = await waitFor(serviceFor(owner), pending.abort.signal);
      if (!current(event, owner, pending)) return cancelled();
      const result = await waitFor(service.request(input), pending.abort.signal);
      return current(event, owner, pending) ? result : cancelled();
    } catch (error) {
      if (!current(event, owner, pending)) return cancelled();
      deps.report?.(error); return { ok: false, error: '语音暂时无法生成，请稍后重试。' };
    } finally { if (owner.pending.get(input.requestId) === pending) owner.pending.delete(input.requestId); }
  };
  deps.ipc.handle(BOT_SPEECH_CHANNEL, (event, raw: unknown): BotSpeechResponse | Promise<BotSpeechResponse> => {
    if (!trusted(event)) return { ok: false, error: '无权访问伙伴语音。' };
    const parsed = botSpeechRequestSchema.safeParse(raw); if (!parsed.success) return { ok: false, error: '语音请求格式不正确。' };
    const owner = getOwner(event.sender), input = parsed.data;
    if (input.type === 'speech.cancel') {
      // Runs before any await, even while Ready/createSpeechService is pending.
      owner.cancelled.add(input.requestId); while (owner.cancelled.size > 128) owner.cancelled.delete(owner.cancelled.values().next().value!);
      owner.pending.get(input.requestId)?.abort.abort(); safely(() => { owner.service?.cancel(input.requestId); });
      return { ok: true, cancelled: true };
    }
    if (owner.cancelled.has(input.requestId)) return cancelled();
    const fingerprint = JSON.stringify([input.conversationId, input.messageId, input.partIndex ?? 0]), existing = owner.pending.get(input.requestId);
    if (existing) return existing.fingerprint === fingerprint ? existing.promise : { ok: false, error: '同一语音请求标识不能用于其他消息。' };
    if (owner.pending.size >= 8) return { ok: false, error: '语音请求正在准备，请稍后重试。' };
    const pending: Pending = { generation: owner.generation, fingerprint, abort: new AbortController(), promise: Promise.resolve(cancelled()) };
    owner.pending.set(input.requestId, pending); pending.promise = run(event, owner, input, pending); return pending.promise;
  });
  return () => {
    if (disposed) return; disposed = true; deps.ipc.removeHandler(BOT_SPEECH_CHANNEL);
    for (const owner of [...live]) invalidate(owner, true);
  };
}
