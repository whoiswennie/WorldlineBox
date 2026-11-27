import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { createBotNativeHost } from '../fixtures/bot-native-host';

const program = process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
type Frame = { role: string; content: string | Array<{ text?: string }> };
const content = (frame: Frame) =>
  typeof frame.content === 'string' ? frame.content : (frame.content ?? []).map((part) => part.text ?? '').join('\n');

it.skipIf(!program)(
  'withdraws the source and prior DSH reminder from the entire next provider request, including after restart',
  async () => {
    const secret = '朱砂八角铜匣',
      privateDiary = `航海图纸装在${secret}里。`,
      retained = '靛蓝鲸鱼卡套',
      publicDiary = `我的借书证收在${retained}里。`;
    const diagnostics: Array<{ at: string; detail: string }> = [];
    const observe = (detail: string) => {
      diagnostics.push({ at: new Date().toISOString(), detail });
      if (process.env.WORLDLINEBOX_VCP_WIRE_TRACE) process.stdout.write(detail + '\n');
    };
    class TraceMemory extends BotMemoryService {
      override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]) {
        const start = Date.now();
        try {
          const result = await super.prepareTurn(input);
          observe('preprocess ' + input.requestId + ' ' + (Date.now() - start) + 'ms');
          return result;
        } catch (error) {
          observe('preprocess ' + String(error));
          throw error;
        }
      }
    }
    const host = await createBotNativeHost(program!);
    const encoder = new GlobalEmbeddingService({
      userDataPath: host.root,
      bundleDirectory: path.resolve('resources/embedding-models'),
      koffiPath: createRequire(path.resolve('package.json')).resolve('koffi'),
      devicePreference: () => ({ backend: 'cpu' }),
    });
    const gateway = new VcpEmbeddingGateway(encoder);
    const frames: Frame[][] = [];
    const provider = createServer(async (req, res) => {
      const bytes: Buffer[] = [];
      for await (const part of req) bytes.push(Buffer.from(part));
      const request = JSON.parse(Buffer.concat(bytes).toString('utf8')) as { messages: Frame[] };
      frames.push(request.messages);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(
        'data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '已收到这条消息。' }, finish_reason: null }] }) + '\n\n',
      );
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    const lanes = new Map<string, string>();
    const legacyQuestion = '登记一个不含回忆的空白目录。',
      legacyText = '旧版独有的松石九边信柜';
    class ObservedBrain extends BotDshBrain {
      override run(input: BotDshRun) {
        lanes.set(input.eventId, input.laneId);
        if (JSON.parse(input.prompt).message?.content === legacyQuestion) {
          // Reproduce the v21 adapter exactly where its frozen envelope was handed to native DSH.
          const packet = JSON.stringify({ kind: 'passive-memory-evidence', items: [{ origin: 'vcp-rag-result', text: legacyText }] });
          const prompt = JSON.stringify({ ...JSON.parse(input.prompt), memoryEvidence: packet });
          service!.store.setMetadata('native-input:' + input.eventId, JSON.stringify({ system: input.system, prompt }));
          return super.run({ ...input, prompt, memoryContext: '' });
        }
        return super.run(input);
      }
    }
    let service: BotService | undefined;
    try {
      const root = path.join(host.root, 'companion');
      await mkdir(root);
      const client = await host.instances.ensureHost(host.instance.id);
      provider.listen(0, '127.0.0.1');
      await once(provider, 'listening');
      const endpoint = provider.address();
      if (!endpoint || typeof endpoint === 'string') throw Error('Local provider did not start');
      const open = () => {
        const packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
        const nativeClient = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
        const createSession: BotMemoryOptions['createSession'] = (options) => {
          const client = nativeClient.createSession({
            ...options,
            onLog: (message: string) => {
              for (const line of message.split('\n'))
                if (/处理占位符时出错|处理消息失败|处理错误|warped insufficient|\bError:/u.test(line)) observe(line.trim().slice(0, 600));
            },
          });
          return {
            closed: client.closed,
            close: () => client.close(),
            request: async (operation, payload, config) => {
              const result = await client.request(operation, payload, config);
              if (operation === 'preprocess') {
                for (const message of result.messages ?? []) {
                  const failures = String(message.content)
                    .replace(/<!-- VCP_RAG_BLOCK_START[\s\S]*?<!-- VCP_RAG_BLOCK_END -->/gu, '')
                    .match(/\[\[Companion日记本[^\]]*\]\]|\[(?:RAG处理失败|处理失败:|聚合检索处理失败:|冷知识库检索失败:)[^\]]*\]/gu);
                  if (failures?.length) observe('native RAG message: ' + JSON.stringify(failures));
                }
              }
              return result;
            },
          };
        };
        const memory = new TraceMemory({
          root: path.join(host.root, 'memory'),
          createSession,
          runtime: async () => ({
            nodePath: path.resolve('.tools/node-v24.15.0-win-x64/node.exe'),
            packageRoot: path.resolve('.tools/bot-memory-release/vcp-memory'),
          }),
          embedding: async () => {
            const profile = await encoder.resolveProfile();
            return gateway.configuration(profile.selectionId, profile);
          },
        });
        const app = new BotService({
          root,
          memory,
          brain: new ObservedBrain({ getHost: async () => ({ client }) }),
          prewarmMemory: false,
          report: (error) => observe(String(error)),
          onEvent: () => undefined,
          model: () => ({
            apiFormat: 'openai_chat',
            baseUrl: 'http://127.0.0.1:' + endpoint.port,
            apiKey: 'local-only',
            model: 'protocol',
          }),
        });
        service = app;
        return { app, memory };
      };
      let session = open();
      const room = (await session.app.handle({ type: 'state' })).snapshot!.conversations.find((room) => room.kind === 'direct')!;
      const audience = { companionId: room.memberIds.find((id) => id !== 'user')!, conversationId: room.id };
      const scope = { ...audience, securityDomainId: session.app.store.getConversation(room.id)!.securityDomainId };
      const idle = async () =>
        vi.waitFor(
          () => {
            expect(session.app.store.listPendingMemory().filter((job) => ['queued', 'running'].includes(job.status))).toHaveLength(0);
            expect(session.memory.isBusy(scope)).toBe(false);
          },
          { timeout: 60000, interval: 75 },
        );
      let serial = 0;
      const send = async (question: string) => {
        await idle();
        const from = frames.length;
        const result = await session.app.handle({
          type: 'message.send',
          conversationId: room.id,
          content: question,
          requestId: 'wire-' + ++serial,
        });
        await vi.waitFor(
          () => {
            const event = session.app.store.eventForReply(result.replyMessageIds![0]!)!;
            expect(event.status, event.error).toBe('done');
          },
          { timeout: 60000, interval: 75 },
        );
        const event = session.app.store.eventForReply(result.replyMessageIds![0]!)!;
        const requests = frames
          .slice(from)
          .filter((set) =>
            set.some(
              (frame) => frame.role === 'user' && content(frame).includes(event.sourceMessageRecordId) && content(frame).includes(question),
            ),
          );
        expect(requests.length).toBeGreaterThan(0);
        observe('provider ' + question + ' admission=' + session.app.store.getMetadata('native-memory-prepared:' + event.id));
        return {
          event,
          lane: lanes.get(event.id)!,
          requests,
          prepared: session.app.store.getMetadata('native-memory-prepared:' + event.id),
        };
      };
      await session.app.handle({ type: 'memory.maintenance.settings.update', ...audience, settings: { enabled: false } });
      const separate = session.app.store.enqueue({
        conversationId: room.id,
        senderId: 'user',
        recipientIds: [],
        sourceMessageId: 'unrelated',
        content: publicDiary,
      });
      const legal = (await session.memory.remember(scope, {
        content: publicDiary,
        sourceMessageIds: [separate.message.id],
        sourceEventId: 'legal',
        tags: '借书证,图书馆',
        waitForIndex: true,
      })) as { receipts: Array<{ id: string; state: string }> };
      const source = await send(privateDiary);
      const saved = (await session.memory.remember(scope, {
        content: privateDiary,
        sourceMessageIds: [source.event.sourceMessageRecordId, source.event.replyMessageId],
        sourceEventId: source.event.id,
        tags: '航海图纸,收藏',
        waitForIndex: true,
      })) as { receipts: Array<{ id: string; state: string }> };
      expect(saved.receipts[0]?.state).toBe('indexed');
      const before = await send('之前说的航海图纸最终是放在哪里的？');
      expect(before.lane).toBe(source.lane);
      const hasOfficialBlock = (messages: Frame[], needle: string) =>
        messages.some((message) =>
          [...content(message).matchAll(/<!-- VCP_RAG_BLOCK_START[\s\S]*?-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/gu)].some((block) =>
            block[1]!.includes(needle),
          ),
        );
      expect(before.requests.some((messages) => hasOfficialBlock(messages, secret))).toBe(true);
      await idle();
      const forgotten = await session.app.handle({ type: 'memory.forget', ...audience, id: saved.receipts[0]!.id });
      expect(forgotten.memory).toMatchObject({
        forgotten: true,
        sourceMessageIds: expect.arrayContaining([source.event.sourceMessageRecordId]),
      });
      const after = await send('现在还能查到航海图纸的位置吗？');
      expect(after.lane).not.toBe(before.lane);
      await idle();
      await session.app.shutdown();
      session = open();
      await session.app.handle({ type: 'state' });
      await session.memory.warm(scope);
      expect(await session.memory.readNote(scope, { id: legal.receipts[0]!.id })).toMatchObject({
        indexState: 'indexed',
        content: publicDiary,
      });
      const restart = await send('我去图书馆时应该在哪里取借书证？');
      expect(restart.lane).toBe(after.lane);
      for (const request of [...after.requests, ...restart.requests]) {
        expect(request.map(content).join('\n')).not.toContain(secret);
        expect(request.map(content).join('\n')).not.toContain(source.event.sourceMessageRecordId);
      }
      // The first optional recall after an application restart may yield to
      // native recovery. Its entire request must still pass the withdrawal check.
      const cleanTopic = (await session.app.handle({ type: 'topic.new', conversationId: room.id, requestId: 'clean-topic' })).topic!;
      const clean = await send('保存独立话题中的绿色标题。');
      const dirtyTopic = (await session.app.handle({ type: 'topic.new', conversationId: room.id, requestId: 'old-topic' })).topic!;
      const legacy = await send(legacyQuestion);
      const prior = await send('空白目录是不是已经登记完成？');
      const carries = (messages: Frame[], needle: string) => messages.some((message) => content(message).includes(needle));
      expect(legacy.requests.some((messages) => carries(messages, legacyText))).toBe(true);
      expect(prior.requests.some((messages) => carries(messages, legacyText))).toBe(true);
      expect(prior.lane).toBe(legacy.lane);
      await idle();
      session.app.store.taskTransaction((sql) => sql.prepare('PRAGMA user_version=22').run());
      await session.app.shutdown();
      session = open();
      await session.app.handle({ type: 'state' });
      await session.memory.warm(scope);
      expect(await session.memory.readNote(scope, { id: legal.receipts[0]!.id })).toMatchObject({
        indexState: 'indexed',
        content: publicDiary,
      });
      expect(session.app.store.retiredNativeLane(legacy.event.id)).toBe(legacy.lane);
      expect(session.app.store.getMessage(legacy.event.sourceMessageRecordId)?.content).toBe(legacyQuestion);
      expect((await session.app.handle({ type: 'topic.select', conversationId: room.id, topicId: dirtyTopic.id })).topic!.id).toBe(
        dirtyTopic.id,
      );
      const switched = await send('我的借书证收在哪里？');
      expect(switched.lane).not.toBe(legacy.lane);
      expect(switched.requests.every((messages) => !carries(messages, legacyText))).toBe(true);
      const checks = [switched];
      for (const question of ['我打算去图书馆，借书证收藏在哪？', '之前收起的借书证该去哪里找？']) {
        if (checks.some((turn) => turn.requests.some((messages) => hasOfficialBlock(messages, retained)))) break;
        checks.push(await send(question));
      }
      expect(
        checks.every(
          (turn) =>
            turn.lane === switched.lane && turn.requests.every((messages) => !carries(messages, legacyText) && !carries(messages, secret)),
        ),
      ).toBe(true);
      expect(
        checks.some((turn) => turn.requests.some((messages) => hasOfficialBlock(messages, retained))),
        JSON.stringify(diagnostics),
      ).toBe(true);
      await session.app.handle({ type: 'topic.select', conversationId: room.id, topicId: cleanTopic.id });
      const preserved = await send('上一条标题是什么颜色？');
      expect(preserved.lane).toBe(clean.lane);
      expect(preserved.requests.some((messages) => carries(messages, '保存独立话题中的绿色标题'))).toBe(true);
      await idle();
      await session.app.shutdown();
      session = open();
      await session.app.handle({ type: 'state' });
      await session.memory.warm(scope);
      await session.app.handle({ type: 'topic.select', conversationId: room.id, topicId: dirtyTopic.id });
      const reopened = await send('借书证还能找得到吗？');
      expect(reopened.lane).toBe(switched.lane);
      expect(reopened.requests.every((messages) => !carries(messages, legacyText))).toBe(true);
      const output = process.env.WORLDLINEBOX_VCP_WITHDRAWAL_EVIDENCE;
      if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(
          path.join(output, 'result.json'),
          JSON.stringify(
            {
              runtime: host.runtimeVersion,
              withdrawn: privateDiary,
              independent: publicDiary,
              sourceId: source.event.sourceMessageRecordId,
              scope,
              legacyText,
              legacyTopicId: dirtyTopic.id,
              cleanTopicId: cleanTopic.id,
              retainedV5NoteId: legal.receipts[0]!.id,
              diagnostics,
              turns: [source, before, after, restart, clean, legacy, prior, ...checks, preserved, reopened].map((turn) => ({
                lane: turn.lane,
                sessionId: BotDshBrain.sessionId(turn.lane),
                question: turn.event.content,
                requests: turn.requests.map((messages) => ({
                  roles: messages.map((m) => m.role),
                  messageDigest: createHash('sha256').update(JSON.stringify(messages)).digest('hex'),
                  secretText: messages.some((m) => content(m).includes(secret)),
                  secretInRag: hasOfficialBlock(messages, secret),
                  independentInRag: hasOfficialBlock(messages, retained),
                  legacyEvidence: carries(messages, legacyText),
                })),
              })),
            },
            null,
            2,
          ) + '\n',
        );
      }
    } finally {
      try {
        await service?.shutdown();
        await gateway.close();
        await encoder.close();
      } finally {
        provider.closeAllConnections();
        if (provider.listening) await new Promise<void>((resolve) => provider.close(() => resolve()));
        await host.close();
      }
    }
  },
  420000,
);
