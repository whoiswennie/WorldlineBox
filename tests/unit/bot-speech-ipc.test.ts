import { EventEmitter } from 'node:events';
import type { BrowserWindow, IpcMainInvokeEvent, WebContents } from 'electron';
import { afterEach, expect, it, vi } from 'vitest';
import { registerBotSpeechIpc, type BotSpeechIpcService } from '../../src/main/companion-bot/speech-ipc';
import { BOT_SPEECH_CHANNEL, type BotSpeechRequest, type BotSpeechResponse } from '../../src/shared/companion-bot-speech';

class Owner extends EventEmitter {
  mainFrame = {}; destroyed = false;
  isDestroyed() { return this.destroyed; }
  navigate(inPlace = false, isMainFrame = true) { this.emit('did-start-navigation', {}, 'file:///new-document', inPlace, isMainFrame); }
  frame() { this.mainFrame = {}; }
}
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: Error) => void; return { promise: new Promise<T>((done, fail) => { resolve = done; reject = fail; }), resolve, reject }; }
function service() { return { request: vi.fn<(input: BotSpeechRequest) => Promise<BotSpeechResponse>>(async () => ({ ok: true })), cancel: vi.fn(), dispose: vi.fn() }; }
const message = (requestId = 'request'): BotSpeechRequest => ({ type: 'speech.synthesize', conversationId: 'room', messageId: 'reply', requestId });
const disposals: Array<() => void> = [];
afterEach(() => { for (const dispose of disposals.splice(0)) dispose(); vi.useRealTimers(); });
async function flush() { for (let index = 0; index < 8; index++) await Promise.resolve(); }
function setup() {
  const owner = new Owner(), ready = vi.fn<(room: string) => Promise<unknown>>(async () => undefined), created = service(), create = vi.fn<() => Promise<BotSpeechIpcService>>(async () => created), report = vi.fn();
  let closing = false, main: Owner | undefined = owner;
  let handler!: (event: IpcMainInvokeEvent, raw: unknown) => unknown;
  const ipc = { handle: vi.fn((_channel: string, listener: typeof handler) => { handler = listener; }), removeHandler: vi.fn() };
  const dispose = registerBotSpeechIpc({ ipc, getMainWindow: () => main ? { isDestroyed: () => false, webContents: main as unknown as WebContents } as Pick<BrowserWindow, 'isDestroyed' | 'webContents'> : undefined,
    ensureReady: ready, createSpeechService: create, isClosing: () => closing, report }); disposals.push(dispose);
  const event = (source = owner, frame = source.mainFrame) => ({ sender: source, senderFrame: frame }) as unknown as IpcMainInvokeEvent;
  const invoke = (input: unknown, supplied = event()) => Promise.resolve(handler(supplied, input) as BotSpeechResponse | Promise<BotSpeechResponse>);
  return { owner, created, create, ready, report, dispose, ipc, event, invoke, close: () => { closing = true; }, replaceMain: (next?: Owner) => { main = next; } };
}

it('registers lazily, rejects non-Main frames and accepts cancel without initializing the bot or speech service', async () => {
  const fixture = setup(); expect(fixture.ipc.handle).toHaveBeenCalledWith(BOT_SPEECH_CHANNEL, expect.any(Function));
  expect(fixture.ready).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
  expect((await fixture.invoke(message(), fixture.event(fixture.owner, {}))).ok).toBe(false);
  await fixture.invoke({ type: 'speech.cancel', requestId: 'future' }); expect(await fixture.invoke(message('future'))).toMatchObject({ cancelled: true });
  expect(fixture.ready).not.toHaveBeenCalled(); expect(fixture.create).not.toHaveBeenCalled();
  fixture.dispose(); expect(fixture.ipc.removeHandler).toHaveBeenCalledWith(BOT_SPEECH_CHANNEL); expect(fixture.owner.eventNames()).toEqual([]);
});
it('records cancellation synchronously while bot initialization is pending, including after more than 30 seconds', async () => {
  vi.useFakeTimers(); const fixture = setup(), initializing = deferred<unknown>(); fixture.ready.mockReturnValue(initializing.promise);
  const pending = fixture.invoke(message()); await flush();
  const stopped = fixture.invoke({ type: 'speech.cancel', requestId: 'request' }); await expect(stopped).resolves.toMatchObject({ cancelled: true });
  await expect(pending).resolves.toMatchObject({ ok: false, cancelled: true }); await vi.advanceTimersByTimeAsync(60_000);
  initializing.resolve(undefined); await flush(); expect(fixture.create).not.toHaveBeenCalled(); expect(fixture.created.request).not.toHaveBeenCalled();
});
it('disposes a late service from an old document without overwriting or disposing the new document service', async () => {
  const fixture = setup(), late = deferred<BotSpeechIpcService>(), newer = service(); fixture.create.mockReturnValueOnce(late.promise).mockResolvedValueOnce(newer);
  const pending = fixture.invoke(message('old')); await flush(); expect(fixture.create).toHaveBeenCalledOnce();
  fixture.owner.navigate(); await expect(pending).resolves.toMatchObject({ cancelled: true });
  await expect(fixture.invoke(message('new'))).resolves.toEqual({ ok: true }); expect(newer.request).toHaveBeenCalledOnce();
  late.resolve(fixture.created); await flush(); expect(fixture.created.dispose).toHaveBeenCalledOnce(); expect(fixture.created.request).not.toHaveBeenCalled(); expect(newer.dispose).not.toHaveBeenCalled();
  fixture.owner.destroyed = true; fixture.owner.emit('destroyed'); expect(newer.dispose).toHaveBeenCalledOnce();
});
it('rechecks the actual current Main frame after readiness and before returning audio', async () => {
  const fixture = setup(), initializing = deferred<unknown>(); fixture.ready.mockReturnValueOnce(initializing.promise);
  const pending = fixture.invoke(message()); await flush(); fixture.owner.frame(); initializing.resolve(undefined);
  await expect(pending).resolves.toMatchObject({ cancelled: true }); expect(fixture.create).not.toHaveBeenCalled();
  const audio = deferred<BotSpeechResponse>(); fixture.created.request.mockReturnValueOnce(audio.promise);
  const playing = fixture.invoke(message('playing')); await flush(); fixture.replaceMain(new Owner()); audio.resolve({ ok: true });
  await expect(playing).resolves.toMatchObject({ cancelled: true });
});
it('cancels active synthesis immediately, but ignores in-place and subframe navigation for the current document', async () => {
  const fixture = setup(), audio = deferred<BotSpeechResponse>(); fixture.created.request.mockReturnValueOnce(audio.promise);
  const pending = fixture.invoke(message()); await flush(); fixture.owner.navigate(true, true); fixture.owner.navigate(false, false);
  expect(fixture.created.dispose).not.toHaveBeenCalled(); expect(fixture.created.cancel).not.toHaveBeenCalled();
  await fixture.invoke({ type: 'speech.cancel', requestId: 'request' }); expect(fixture.created.cancel).toHaveBeenCalledWith('request');
  await expect(pending).resolves.toMatchObject({ cancelled: true }); audio.resolve({ ok: true }); await flush();
});
it('cleans up current and creating services on renderer crash and controller disposal', async () => {
  const fixture = setup(); await fixture.invoke(message()); fixture.owner.emit('render-process-gone'); expect(fixture.created.dispose).toHaveBeenCalledOnce();
  const late = deferred<BotSpeechIpcService>(), serviceAfter = service(); fixture.create.mockReturnValueOnce(late.promise);
  const pending = fixture.invoke(message('late')); await flush(); fixture.dispose(); await expect(pending).resolves.toMatchObject({ cancelled: true });
  late.resolve(serviceAfter); await flush(); expect(serviceAfter.dispose).toHaveBeenCalledOnce(); expect(serviceAfter.request).not.toHaveBeenCalled();
  expect(fixture.owner.eventNames()).toEqual([]);
});
it('never starts synthesis when app closing begins during initialization, and observes late failures after cancellation', async () => {
  const fixture = setup(), initializing = deferred<unknown>(); fixture.ready.mockReturnValueOnce(initializing.promise);
  const pending = fixture.invoke(message()); await flush(); fixture.close(); initializing.resolve(undefined); await expect(pending).resolves.toMatchObject({ cancelled: true }); expect(fixture.create).not.toHaveBeenCalled();
  const second = setup(), late = deferred<BotSpeechIpcService>(); second.create.mockReturnValueOnce(late.promise);
  const cancelled = second.invoke(message()); await flush(); await second.invoke({ type: 'speech.cancel', requestId: 'request' }); await expect(cancelled).resolves.toMatchObject({ cancelled: true });
  late.reject(Error('late module error')); await flush(); expect(second.report).not.toHaveBeenCalled();
});
it('coalesces retries, rejects conflicting IDs and bounds readiness waiters without allocating speech services', async () => {
  const fixture = setup(), initializing = deferred<unknown>(); fixture.ready.mockReturnValue(initializing.promise);
  const first = fixture.invoke(message('same')); const repeated = fixture.invoke(message('same')); await flush(); expect(fixture.ready).toHaveBeenCalledOnce();
  expect((await fixture.invoke({ ...message('same'), messageId: 'other' })).ok).toBe(false);
  const others = Array.from({ length: 7 }, (_, index) => fixture.invoke(message('other-' + index))); await flush();
  expect((await fixture.invoke(message('overflow'))).error).toContain('准备'); expect(fixture.ready).toHaveBeenCalledTimes(8);
  fixture.dispose(); expect(await first).toEqual(await repeated); await Promise.all(others); initializing.resolve(undefined); await flush(); expect(fixture.create).not.toHaveBeenCalled();
});
