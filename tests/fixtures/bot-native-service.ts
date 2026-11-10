import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { BotService, type BotServiceOptions } from '../../src/main/companion-bot/service';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryPrepared } from '../../src/main/companion-bot/memory-service';

export class NativeServiceMemory extends BotMemoryService {
  constructor(root: string) { super({ root, runtime: async () => { throw Error('No VCP subprocess in routing fixture'); }, embedding: async () => { throw Error('No embedding in routing fixture'); } }); }
  override async withdrawnSources() { return { revision: '0', sourceEventIds: [], sourceMessageIds: [] }; }
  override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]): Promise<BotMemoryPrepared> {
    return { requestId: input.requestId, scope: input.scope, messages: input.messages, inputHash: 'native-routing-fixture', status: 'ready', evidence: '', metadata: {}, events: [], omittedChars: 0 };
  }
  override async finishTurn() { return { recorded: true }; }
  override async appendHistory() { return { appended: [] }; }
  override async close() {}
}
export async function nativeServiceFixture(run: (input: BotDshRun) => Promise<string>, options?: Partial<Pick<BotServiceOptions, 'browserTool' | 'resolveBrowserContext'>>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wlb-native-routing-')), calls: BotDshRun[] = [];
  class Native extends BotDshBrain {
    constructor() { super({ getHost: async () => { throw Error('No DSH process in service routing fixture'); } }); }
    override async run(input: BotDshRun) {
      if (input.laneId.startsWith('memory-encoder-')) return { status: 'succeeded' as const, text: '{"notes":[]}', eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId) };
      calls.push(input); return { status: 'succeeded' as const, text: await run(input), eventId: input.eventId, sessionId: BotDshBrain.sessionId(input.laneId), inputContextCommitted: true };
    }
    override async archive() {}
    override async close() {}
  }
  const service = new BotService({ root, brain: new Native(), memory: new NativeServiceMemory(path.join(root, 'memory')),
    model: () => ({ apiFormat: 'openai_chat', model: 'fixture', baseUrl: 'http://127.0.0.1:9', apiKey: 'fixture' }), onEvent: () => undefined, ...options });
  await service.handle({ type: 'state' });
  return { root, service, calls, close: async () => {
    await service.shutdown();
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith('wlb-native-routing-')) throw Error('Invalid fixture root');
    await rm(root, { recursive: true, force: true });
  } };
}
export async function nativeCallback(input: BotDshRun, name: string, args: object, callId = name) {
  const response = await fetch(input.callback.url, { method: 'POST', headers: { authorization: 'Bearer ' + input.callback.token, 'content-type': 'application/json' },
    body: JSON.stringify({ laneId: input.laneId, eventId: input.eventId, callId, name, args }) });
  return { status: response.status, ...await response.json() as { ok: boolean; result?: Record<string, unknown>; error?: string } };
}
export async function waitNative(check: () => boolean) {
  const deadline = Date.now() + 8000;
  while (!check()) { if (Date.now() > deadline) throw Error('Native routing fixture did not settle'); await new Promise(resolve => setTimeout(resolve, 10)); }
}
