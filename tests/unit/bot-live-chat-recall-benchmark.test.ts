import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it } from 'vitest';
import { BotDshBrain, type BotDshRun } from '../../src/main/companion-bot/dsh-brain';
import { BotHistoryProjector } from '../../src/main/companion-bot/history-projection';
import { BotMemoryService, type BotMemoryOptions } from '../../src/main/companion-bot/memory-service';
import { BotService } from '../../src/main/companion-bot/service';
import { GlobalEmbeddingService } from '../../src/main/embedding-global-service';
import { VcpEmbeddingGateway } from '../../src/main/vcp-embedding-gateway';
import { createBotNativeHost } from '../fixtures/bot-native-host';

const facts = [
  ['我的备用钥匙放在玄关橙色雨靴里。', '出门忘带家门钥匙了，另一把收在哪里？', '玄关橙色雨靴', '家门,备用钥匙,玄关'],
  ['给猫打疫苗预约的是云杉动物诊所。', '小猫补种疫苗要去哪家诊所？', '云杉动物诊所', '宠物,疫苗,诊所'],
  ['团队演示的转接头收在灰色相机包内袋。', '投屏演示用的转接头上回收进哪了？', '灰色相机包内袋', '演示,转接头,设备'],
  ['海边露营订在松针湾二号营位。', '我们海边扎帐篷预订的是哪个营位？', '松针湾二号营位', '海边,露营,营位'],
  ['给爸爸过生日要订茉莉香梨蛋糕。', '爸爸生日要选什么口味的蛋糕来着？', '茉莉香梨蛋糕', '生日,蛋糕,家人'],
  ['修自行车车链条的店是柳树坡车房。', '我的单车链条又响了，上次找哪家店修的？', '柳树坡车房', '自行车,链条,维修'],
  ['看完的旅行笔记暂时借给了顾老师。', '那本旅行笔记借谁拿走了？', '顾老师', '图书,旅行笔记,借阅'],
  ['阳台番茄育苗的补光灯用琥珀色插座。', '给阳台番茄苗开灯应该接哪个插座？', '琥珀色插座', '番茄,补光灯,阳台'],
  ['周末合唱排练改到银杏厅西侧。', '合唱队周末在哪儿排练？', '银杏厅西侧', '合唱,排练,周末'],
  ['我们洗好的胶片底片收进深蓝铁皮盒。', '之前冲洗的相机底片放在哪？', '深蓝铁皮盒', '胶片,底片,收纳'],
  ['给新咖啡机买的滤纸规格叫蜂鸟一号。', '给咖啡机补滤纸要买哪个型号？', '蜂鸟一号', '咖啡机,滤纸,采购'],
  ['外婆做米糕用的是桂花酒酿。', '外婆那款米糕里加了什么？', '桂花酒酿', '米糕,食谱,外婆'],
] as const;
const distractors = [
  '天气变化与湿度',
  '园区步行观察',
  '每周采购清单',
  '图书整理安排',
  '设备例行保养',
  '工作会议记录',
  '餐后菜谱比较',
  '通勤出行记录',
];
type Phase = 'cold' | 'warm' | 'contention';
type Sample = {
  phase: Phase;
  query: string;
  target: string;
  started: number;
  prepareStart?: number;
  prepareEnd?: number;
  preparationHistoryMessages?: number;
  originalInPreparationHistory?: boolean;
  prepareError?: string;
  dispatched?: number;
  provider?: number;
  exact?: boolean;
  injected?: boolean;
  ragResults?: number;
  documentedNoteRank?: number;
  exactInRagBlock?: boolean;
  exactInOneRing?: boolean;
  sourceMessageId?: string;
  wire?: {
    question: boolean;
    memoryContext: boolean;
    targetInContext: boolean;
    targetInRag: boolean;
    targetInOtherMessages: boolean;
    targetInSupersededContexts: boolean;
    candidateContextRole?: string;
    contextSha256?: string;
  };
  decision?: 'admitted' | 'busy-yield' | 'deadline' | 'unavailable';
  marker?: string;
};
const percentile = (samples: number[]) => {
  const v = [...samples].sort((a, b) => a - b);
  const at = (p: number) => v[Math.ceil(p * v.length) - 1] ?? null;
  return { count: v.length, p50Ms: at(0.5), p95Ms: at(0.95), maxMs: at(1) };
};

function hasRagAnswer(text: string, answer: string) {
  return [...text.matchAll(/<!-- VCP_RAG_BLOCK_START[\s\S]*?-->([\s\S]*?)<!-- VCP_RAG_BLOCK_END -->/gu)].some((match) =>
    match[1]?.includes(answer),
  );
}

type WireMessage = { role: string; content: string | Array<{ text?: string }> };
function captureModelRequest(sample: Sample, context: string, messages: WireMessage[]) {
  const wire = messages.map((message) => ({
    role: message.role,
    text: typeof message.content === 'string' ? message.content : (message.content ?? []).map((part) => part.text ?? '').join('\n'),
  }));
  // The installed DSH model serializer emits systemPrompt.context as its own
  // user-role reminder. Match the exact serialized context for this request,
  // never count text in the user question, earlier turns or a tool response.
  const question = wire.findLast(
    (message) =>
      message.role === 'user' &&
      message.text.includes(sample.query) &&
      sample.sourceMessageId &&
      message.text.includes(sample.sourceMessageId),
  );
  if (!question) return;
  const isContext = (message: (typeof wire)[number]) =>
    message.role === 'user' &&
    message.text.includes('<system-reminder>') &&
    /The following information describes your current session|Current runtime context: none/u.test(message.text);
  const latest = wire.findLast(isContext);
  const memory = context && latest?.text.includes(context) ? latest : undefined;
  sample.wire = {
    question: true,
    memoryContext: Boolean(memory),
    targetInContext: Boolean(memory && context.includes(sample.target)),
    targetInRag: Boolean(memory && hasRagAnswer(context, sample.target)),
    targetInOtherMessages: wire.some((message) => !isContext(message) && message !== question && message.text.includes(sample.target)),
    targetInSupersededContexts: wire.some((message) => isContext(message) && message !== latest && message.text.includes(sample.target)),
    ...(memory && { candidateContextRole: memory.role, contextSha256: createHash('sha256').update(context).digest('hex') }),
  };
}

it('scores only the current verified DSH context and current source message on the provider wire', () => {
  const sample: Sample = { phase: 'warm', started: 0, query: '我的伞呢？', target: '黄铜挂钩', sourceMessageId: 'current-question' };
  const context = '<!-- VCP_RAG_BLOCK_START {} -->在黄铜挂钩上<!-- VCP_RAG_BLOCK_END -->';
  const reminder = (body: string): WireMessage => ({
    role: 'user',
    content: `<system-reminder>\nThe following information describes your current session:\n${body}\n</system-reminder>`,
  });
  const question = { role: 'user', content: '{"id":"current-question","content":"我的伞呢？"}' };
  const messages = [reminder(context), { role: 'assistant', content: '旧答复提过黄铜挂钩。' }, reminder('今天下雨'), question];
  captureModelRequest(sample, context, messages);
  expect(sample.wire).toMatchObject({
    question: true,
    memoryContext: false,
    targetInRag: false,
    targetInOtherMessages: true,
    targetInSupersededContexts: true,
  });
  captureModelRequest(sample, context, [...messages, reminder(context)]);
  expect(sample.wire).toMatchObject({ memoryContext: true, targetInContext: true, targetInRag: true, candidateContextRole: 'user' });
});

it.skipIf(!process.env.WORLDLINEBOX_VCP_CHAT_BENCH)(
  'measures ordinary chat from message.send through scoped CPU recall and the actual DSH model request',
  async () => {
    const noteCount = Number(process.env.WORLDLINEBOX_BENCH_NOTES || 24),
      historyCount = Number(process.env.WORLDLINEBOX_BENCH_HISTORY || 64);
    const coldCount = Number(process.env.WORLDLINEBOX_BENCH_COLD || 5),
      hotCount = Number(process.env.WORLDLINEBOX_BENCH_HOT || 25);
    expect(noteCount).toBeGreaterThanOrEqual(facts.length);
    expect(historyCount).toBeGreaterThanOrEqual(noteCount);
    const host = await createBotNativeHost(process.env.WORLDLINEBOX_BOT_DSH_PROGRAM!);
    const nodePath = path.resolve('.tools/node-v24.15.0-win-x64/node.exe'),
      packageRoot = path.resolve('.tools/bot-memory-release/vcp-memory');
    const stamp = new Date().toISOString(),
      out =
        process.env.WORLDLINEBOX_BENCH_OUTPUT ??
        path.resolve('artifacts/superagent-bot-development', 'chat-recall-' + stamp.replace(/[:.]/g, '-'));
    let active: Sample | undefined, held: { entered(): void; gate: Promise<void> } | undefined;
    let dispatchedContext = '';
    const samples: Sample[] = [];
    const notes: Array<{ id: string; checksum: string }> = [];
    const references: Array<{
      noteId: string;
      checksum: string;
      originalMessageId: string;
      body: string;
      tags: string;
      query: string;
      target: string;
    }> = [];
    const server = createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      if (active && active.dispatched !== undefined && active.provider === undefined) {
        const received = performance.now();
        const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages: WireMessage[] };
        captureModelRequest(active, dispatchedContext, request.messages);
        if (active.wire?.question) active.provider = received;
      }
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('data: ' + JSON.stringify({ choices: [{ index: 0, delta: { content: '收到。' }, finish_reason: null }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
    });
    let providerUrl = '';
    const frames = new Map<string, Sample>();
    class Memory extends BotMemoryService {
      override async prepareTurn(input: Parameters<BotMemoryService['prepareTurn']>[0]) {
        const sample = frames.get(input.requestId) ?? (active && input.query === active.query ? active : undefined);
        if (!sample || sample.dispatched !== undefined) return super.prepareTurn(input);
        frames.set(input.requestId, sample);
        sample.prepareStart = performance.now();
        sample.preparationHistoryMessages = input.messages.length;
        const reference = references.find((item) => item.query === sample.query)!;
        sample.originalInPreparationHistory = input.messages.some(
          (message) => message.id === reference.originalMessageId && message.content.includes(reference.body),
        );
        try {
          const prepared = await super.prepareTurn(input),
            citations = (prepared.citations ?? []).filter((hit) => hit.origin === 'vcp-rag-result');
          const fact = facts.find((row) => row[1] === sample.query)!;
          const rank = citations.findIndex((hit) => hit.text.includes(fact[0]));
          sample.ragResults = citations.length;
          sample.exactInOneRing = (prepared.citations ?? []).some(
            (hit) => hit.origin === 'vcp-onering-history' && hit.text.includes(fact[0]),
          );
          if (rank !== -1) sample.documentedNoteRank = rank + 1;
          return prepared;
        } catch (e) {
          sample.prepareError = (e as Error).message;
          throw e;
        } finally {
          sample.prepareEnd = performance.now();
        }
      }
    }
    class Brain extends BotDshBrain {
      override async run(input: BotDshRun) {
        if (active && input.prompt.includes(active.query)) {
          dispatchedContext = input.memoryContext ?? '';
          active.sourceMessageId = JSON.parse(input.prompt).message.id;
          active.dispatched = performance.now();
          active.exact = Boolean(input.memoryContext?.includes(active.target));
          active.exactInRagBlock = hasRagAnswer(dispatchedContext, active.target);
          active.injected = Boolean(input.memoryContext);
          active.marker = app.store.getMetadata('native-memory-prepared:' + input.eventId);
          if (active.marker === '1') active.decision = 'admitted';
          else if (active.prepareError) active.decision = 'unavailable';
          else active.decision = active.prepareStart === undefined ? 'busy-yield' : 'deadline';
        }
        return super.run(input);
      }
    }
    const projectRequire = createRequire(path.resolve('package.json')),
      client = createRequire(path.join(packageRoot, 'package.json'))('./lib/client.cjs');
    const root = path.join(host.root, 'bot');
    let encoder!: GlobalEmbeddingService, gateway!: VcpEmbeddingGateway, app!: BotService, memory!: Memory;
    let dsh: Awaited<ReturnType<typeof host.instances.ensureHost>>;
    const open = () => {
      encoder = new GlobalEmbeddingService({
        userDataPath: path.join(host.root, 'embedding'),
        bundleDirectory: path.resolve('resources/embedding-models'),
        koffiPath: projectRequire.resolve('koffi'),
        devicePreference: () => ({ backend: 'cpu' }),
      });
      gateway = new VcpEmbeddingGateway(encoder);
      const createSession: BotMemoryOptions['createSession'] = (options) => {
        const raw = client.createSession(options);
        return {
          closed: raw.closed,
          close: () => raw.close(),
          request: async (op, payload, config) => {
            if (op === 'bot.diaries.associate' && held) {
              const latch = held;
              latch.entered();
              await latch.gate;
            }
            return raw.request(op, payload, config);
          },
        };
      };
      memory = new Memory({
        root: path.join(host.root, 'memory'),
        runtime: async () => ({ nodePath, packageRoot }),
        authorName: () => '基准伙伴',
        createSession,
        embedding: async () => {
          const profile = await encoder.resolveProfile();
          return gateway.configuration(profile.selectionId, profile);
        },
      });
      app = new BotService({
        root,
        memory,
        brain: new Brain({ getHost: async () => ({ client: dsh }) }),
        prewarmMemory: false,
        onEvent: () => undefined,
        model: () => ({
          apiFormat: 'openai_chat',
          baseUrl: providerUrl,
          model: 'local-protocol',
          apiKey: 'local-only',
          contextWindow: 128000,
        }),
      });
    };
    const close = async () => {
      try {
        await app?.shutdown();
      } finally {
        try {
          await gateway?.close();
        } finally {
          await encoder?.close();
        }
      }
    };
    const until = async (probe: () => boolean, limit = 90000) => {
      const end = performance.now() + limit;
      while (!probe()) {
        if (performance.now() > end) throw Error('Timed out waiting for benchmark ' + JSON.stringify(active));
        await delay(20);
      }
    };
    let gateRelease: (() => void) | undefined;
    try {
      await mkdir(out, { recursive: true });
      await mkdir(root);
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const address = server.address();
      if (!address || typeof address === 'string') throw Error('Fixture listen failed');
      providerUrl = 'http://127.0.0.1:' + address.port;
      dsh = await host.instances.ensureHost(host.instance.id);
      open();
      const room = (await app.handle({ type: 'state' })).snapshot!.conversations.find((room) => room.kind === 'direct')!;
      const scope = {
        conversationId: room.id,
        securityDomainId: app.store.getConversation(room.id)!.securityDomainId,
        companionId: room.memberIds.find((id) => id !== 'user')!,
      };
      await app.handle({
        type: 'memory.maintenance.settings.update',
        conversationId: room.id,
        companionId: scope.companionId,
        settings: { enabled: false },
      });
      const seedStart = performance.now();
      for (let i = 0; i < historyCount; i++) {
        const answer = facts[i],
          category = distractors[i % distractors.length]!;
        const content = answer?.[0] ?? `${category}第${i}项。当天已完成记录，计划在${(i % 12) + 1}月${(i % 28) + 1}日复查。`;
        // The source and its diary belong to the same room. Record whether
        // the original was still present in the bounded chat history per turn.
        const origin = app.store.enqueue({
          conversationId: room.id,
          senderId: i % 2 === 0 ? 'user' : scope.companionId,
          recipientIds: [],
          sourceMessageId: 'bench-original-' + i,
          content,
        });
        if (i < noteCount) {
          const r = (await memory.remember(scope, {
            content,
            tags: answer?.[3] ?? `${category},观察日记,复查`,
            sourceEventId: 'bench-observation-' + i,
            sourceMessageIds: [origin.message.id],
            waitForIndex: true,
          })) as { receipts: Array<{ id: string; checksum: string; state: string }> };
          expect(r.receipts[0]?.state).toBe('indexed');
          notes.push(r.receipts[0]!);
          if (answer)
            references.push({
              noteId: r.receipts[0]!.id,
              checksum: r.receipts[0]!.checksum,
              originalMessageId: origin.message.id,
              body: answer[0],
              tags: answer[3],
              query: answer[1],
              target: answer[2],
            });
        }
        if ((i + 1) % 100 === 0)
          await writeFile(
            path.join(out, 'progress.json'),
            JSON.stringify({ phase: 'seeding', sources: i + 1, indexed: notes.length, historyCount, updatedAt: new Date().toISOString() }),
          );
      }
      await new BotHistoryProjector({ store: app.store, memory }).project(scope);
      const seedMs = performance.now() - seedStart;
      if (process.env.WORLDLINEBOX_BENCH_AWAIT_SAMPLING === '1') {
        await writeFile(
          path.join(out, 'progress.json'),
          JSON.stringify({ phase: 'ready-for-timing', indexed: notes.length, historyCount, seedMs }),
        );
        await until(() => existsSync(path.join(out, 'sample.ready')), 900000);
      }
      const run = async (phase: Phase, i: number) => {
        const fact = facts[i % facts.length]!,
          sample: Sample = { phase, query: fact[1], target: fact[2], started: performance.now() };
        active = sample;
        const sent = await app.handle({ type: 'message.send', conversationId: room.id, content: fact[1], requestId: `${phase}-${i}` });
        const done = () => {
          const event = app.store.eventForReply(sent.replyMessageIds![0]!);
          if (event?.status === 'failed') throw Error(event.error);
          return event?.status === 'done';
        };
        await until(done);
        expect(sample.provider).toBeDefined();
        samples.push(sample);
        active = undefined;
        await until(
          () => !app.store.listPendingMemory().some((job) => ['queued', 'running'].includes(job.status)) && !memory.isBusy(scope),
        );
      };
      for (let i = 0; i < coldCount; i++) {
        await close();
        open();
        await app.handle({ type: 'state' });
        await run('cold', i);
      }
      for (let i = 0; i < hotCount; i++) await run('warm', i);
      // One controlled maintenance request stays in its real scoped worker slot
      // beyond the foreground grace; the latch opens after the model saw input.
      let enter!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      held = {
        entered: enter,
        gate: new Promise<void>((resolve) => {
          gateRelease = resolve;
        }),
      };
      const association = memory.associateDiaries(scope, { sources: [notes[0]!], expectedSourceRevision: '0' });
      await entered;
      const contended = run('contention', hotCount + 1);
      try {
        await until(() => active?.provider !== undefined || samples.some((s) => s.phase === 'contention'));
      } finally {
        gateRelease!();
        held = undefined;
      }
      await Promise.all([association, contended]);
      const summary = Object.fromEntries(
        (['cold', 'warm', 'contention'] as const).map((phase) => {
          const group = samples.filter((s) => s.phase === phase);
          return [
            phase,
            {
              n: group.length,
              exactTargetInAdmittedMemory: group.filter((s) => s.exact).length,
              currentQuestionAtProvider: group.filter((s) => s.wire?.question).length,
              currentContextAtProvider: group.filter((s) => s.wire?.memoryContext).length,
              exactTargetInCurrentProviderContext: group.filter((s) => s.wire?.targetInContext).length,
              exactTargetInCurrentProviderRag: group.filter((s) => s.wire?.targetInRag).length,
              targetAlsoInOtherProviderMessages: group.filter((s) => s.wire?.targetInOtherMessages).length,
              targetAlsoInSupersededProviderContexts: group.filter((s) => s.wire?.targetInSupersededContexts).length,
              originalInBoundedPrepareInput: group.filter((s) => s.originalInPreparationHistory).length,
              exactOriginalInAdmittedRag: group.filter((s) => s.decision === 'admitted' && s.documentedNoteRank).length,
              exactTargetInFormattedRag: group.filter((s) => s.exactInRagBlock).length,
              exactOriginalInAdmittedOneRing: group.filter((s) => s.decision === 'admitted' && s.exactInOneRing).length,
              admitted: group.filter((s) => s.decision === 'admitted').length,
              busyYields: group.filter((s) => s.decision === 'busy-yield').length,
              deadlines: group.filter((s) => s.decision === 'deadline').length,
              errors: group.filter((s) => s.decision === 'unavailable').length,
              sendToProvider: percentile(group.map((s) => s.provider! - s.started)),
              sendToBrainRunEntry: percentile(group.map((s) => s.dispatched! - s.started)),
              prepare: percentile(
                group.filter((s) => s.prepareStart !== undefined && s.prepareEnd !== undefined).map((s) => s.prepareEnd! - s.prepareStart!),
              ),
            },
          ];
        }),
      );
      const report = {
        started: stamp,
        finished: new Date().toISOString(),
        noteCount,
        historyCount,
        seedMs,
        hardware: { cpu: os.cpus()[0]?.model, logical: os.cpus().length, ramGiB: os.totalmem() / 2 ** 30, platform: os.release() },
        conditions: process.env.WORLDLINEBOX_BENCH_CONDITIONS,
        model: (await encoder.resolveProfile()).modelName,
        dshVersion: host.runtimeVersion,
        methods: {
          cold: 'New app service, VCP worker and embedding process per sample; existing indexed notes, DSH Host and OS file cache retained',
          warm: 'Same conversation, native VCP+CPU service live, previous response settled',
          boundary:
            'message.send to receipt of the real DSH model HTTP body at the local deterministic endpoint, excludes generated tokens and WAN',
          dispatch:
            'sendToBrainRunEntry measures entry to the app’s BotDshBrain.run. Time until the native DSH completes HTTP serialization is included separately in sendToProvider.',
          exact:
            'Question and current source message ID must occur in the actual HTTP messages. Match the entire current DSH context separately on the wire, then check the answer-only substring and RAG block. Other HTTP messages, OneRing, the RAG broadcast and host dispatch are measured separately. Twelve natural Chinese facts are mixed with numbered distractors.',
        },
        summary,
        references,
        samples,
      };
      await writeFile(path.join(out, 'result.json'), JSON.stringify(report, null, 2) + '\n');
      if (existsSync(path.join(out,'progress.json'))) await writeFile(path.join(out,'progress.json'),JSON.stringify({ phase:'completed',indexed:notes.length,historyCount,seedMs,finished:report.finished }));
      console.log(JSON.stringify({ out, summary }));
      expect(summary.contention!.busyYields).toBe(1);
    } catch (error) {
      await writeFile(
        path.join(out, 'failure.json'),
        JSON.stringify(
          {
            at: new Date().toISOString(),
            indexed: notes.length,
            active,
            samples,
            reason: error instanceof Error ? error.message : String(error),
          },
          null,
          2,
        ),
      );
      throw error;
    } finally {
      gateRelease?.();
      try {
        await close();
      } finally {
        server.closeAllConnections();
        if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
        await host.close();
      }
    }
  },
  1_800_000,
);
