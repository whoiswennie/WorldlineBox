import { createHash, timingSafeEqual } from 'node:crypto';
import { DshMessageNotReadyError } from '../dsh/host-errors';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, appendFile, readdir, rename, truncate, statfs, realpath, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { constants as zlib, createGzip } from 'node:zlib';
import { z } from 'zod';
import { botRequestSchema, type BotEvent, type BotMessage, type BotRequest } from '../../shared/companion-bot';
import { callCaptionPlaybackPages, callCaptionHoldMs } from '../../shared/companion-call-captions';
import { botCallProgressIcon, botReplyProgressLabel } from '../../shared/companion-bot-progress';
import { MOBILE_UPLOAD_MAX_BYTES, MOBILE_UPLOAD_CHUNK_BYTES, MOBILE_ACCESS_PORT, mobileDeviceName, mobileToken } from '../../shared/mobile-access';
import type { MobileAccessSettings } from './mobile-access-settings';
import type { BotMediaService } from './media-service';
import type { BotService } from './service';
import type { BotConversation } from './types';
import { speechText, type DeepSeekSpeech } from './deepseek-speech';
import { callReplyText } from '../../shared/companion-bot-reply';

const configSchema = z.strictObject({
  port: z.number().int().min(1024).max(65535).default(47831),
  token: z.string().regex(/^[a-f0-9]{64}$/),
});
const id = z.string().min(1).max(160).regex(/^[^\/\\\x00-\x1f\x7f]+$/u);
const requestTypes = new Set<BotRequest['type']>([
  'state', 'conversation.open', 'message.send', 'message.guide', 'message.dequeue', 'call.open', 'call.interrupt', 'user.identity',
  'reply.cancel', 'execution.answer', 'execution.continue', 'topic.list', 'topic.new', 'topic.select', 'topic.compact',
]);

interface Options {
  root: string;
  access?: MobileAccessSettings;
  port?: number;
  speech?: DeepSeekSpeech;
  callAssetsRoot?: string;
  bot(): Promise<BotService>;
  media(): Promise<BotMediaService>;
  report(error: unknown): void;
}

class RequestError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

function canChat(room: BotConversation | undefined): boolean {
  return !!room && !room.dissolvedAt && room.memberIds.includes('user') && ['direct', 'group'].includes(room.kind);
}

function digest(value: string) { return createHash('sha256').update(value).digest(); }

function json(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  res.end(JSON.stringify(data));
}

function limit(max: number) {
  let length = 0;
  return new Transform({ transform(chunk: Buffer, _encoding, callback) {
    length += chunk.length;
    if (length > max) callback(new RequestError(413, '文件或请求超出大小限制。'));
    else callback(null, chunk);
  } });
}

async function readJson(req: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 512 * 1024) throw new RequestError(413, '请求超出大小限制。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new RequestError(400, '请求格式不正确。'); }
}

function fileName(value: string | null) {
  const name = value?.trim();
  if (!name || name.length > 180 || /[<>:"/\\|?*\x00-\x1f\x7f]|[. ]$/u.test(name) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(name)) {
    throw new RequestError(400, '文件名不受支持。');
  }
  return name;
}

function projectProgress(status: BotMessage['status'], progress: NonNullable<BotMessage['progress']>) {
  return { ...progress, label: botReplyProgressLabel(status, progress, 'zh-CN'), icon: botCallProgressIcon(progress.phase) };
}

const projectedPages = (text: string, partId?: string) => callCaptionPlaybackPages(text, partId).map(({ text }, speechPage) => ({ text, speechPage, holdMs: callCaptionHoldMs(text) }));

function projectMessage(message: BotMessage, meeting = false) {
  const { id, conversationId, senderId, senderName, content, sequence, status, createdAt, attachments, timing, progress, execution, topic, quote, error } = message;
  const cues = message.parts?.filter(part => part.presentation);
  const caption = meeting && senderId !== 'user' && !cues?.length ? callReplyText(message) : '';
  return { id, conversationId, senderId, senderName, content, sequence, status, createdAt, attachments, timing,
    progress: progress && projectProgress(status, progress), topic, quote,
    ...(error ? { error: '伙伴回复失败，请在电脑端查看详情后重试。' } : {}),
    ...(cues?.length ? { cues: cues.map(({ id, text, presentation }) => ({
      id, text, ...presentation,
      pages: projectedPages(text ?? '', id),
    })) } : caption ? { captionPages: projectedPages(caption) } : {}),
    ...(execution ? { execution: { status: execution.status, phase: execution.phase, question: execution.question,
      continuation: execution.continuation, interruption: execution.interruption,
      steps: execution.steps.slice(-50).map(({ id, type, summary, toolName, status, at }) => ({ id, type, summary, toolName, status, at })) } } : {}) };
}

export async function startMobileGateway(options: Options) {
  let port = options.port ?? MOBILE_ACCESS_PORT;
  let token: Buffer | undefined;
  if (!options.access) {
    let raw: string;
    try { raw = await readFile(path.join(options.root, 'mobile-access.json'), 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const config = configSchema.parse(JSON.parse(raw.replace(/^\uFEFF/u, '')));
    port = config.port;
    token = digest(`Bearer ${config.token}`);
  }
  const subscribers = new Map<ServerResponse, string | undefined>();
  const inboxStreams = new Set<ServerResponse>();
  const responses = new Map<ServerResponse, string>();
  const staging = path.join(options.root, 'mobile-upload-staging');
  let transfers = 0;
  const uploads = new Map<string, { directory: string; file: string; room: string; name: string; total: number; offset: number; touched: number; busy: boolean; attachment?: unknown }>();

  const uploadLifetime = 24 * 60 * 60_000;
  type Upload = NonNullable<ReturnType<typeof uploads.get>>;
  const checkpoint = async (key: string, item: Upload) => {
    const target = path.join(item.directory, 'resume.json');
    await writeFile(target + '.tmp', JSON.stringify({ key, room: item.room, name: item.name, total: item.total, attachment: item.attachment }));
    await rename(target + '.tmp', target);
  };
  // A dropped SSH connection or desktop restart can resume at the bytes already on disk.
  await mkdir(staging, { recursive: true });
  for (const entry of await readdir(staging, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^resumable-[a-zA-Z0-9]+$/u.test(entry.name)) continue;
    const directory = path.join(staging, entry.name);
    try {
      const journal = path.join(directory, 'resume.json');
      const saved = JSON.parse(await readFile(journal, 'utf8'));
      if (typeof saved.key !== 'string' || !id.safeParse(saved.room).success || !Number.isSafeInteger(saved.total) ||
          saved.total < 0 || saved.total > MOBILE_UPLOAD_MAX_BYTES) continue;
      const file = path.join(directory, 'data', fileName(saved.name));
      const info = await stat(saved.attachment ? journal : file);
      if (Date.now() - info.mtimeMs > uploadLifetime) { await rm(directory, { recursive: true, force: true }); continue; }
      if (!saved.attachment && info.size > saved.total) continue;
      uploads.set(saved.key, { directory, file, room: saved.room, name: saved.name, total: saved.total,
        offset: saved.attachment ? saved.total : info.size, touched: info.mtimeMs, busy: false, attachment: saved.attachment });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') options.report(error);
    }
  }

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    if (req.headers.origin || !/^127\.0\.0\.1(?::\d+)?$/u.test(req.headers.host ?? '')) throw new RequestError(401, '移动访问凭据无效。');
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method;
    if (options.access && method === 'POST' && url.pathname === '/mobile/v1/pair') {
      const body = z.strictObject({ code: mobileToken, token: mobileToken, name: mobileDeviceName }).safeParse(await readJson(req));
      if (!body.success || !await options.access.redeem(body.data.code, body.data.token, body.data.name)) {
        throw new RequestError(403, '配对信息无效、已使用或已过期。');
      }
      return json(res, 201, { ok: true });
    }
    const device = options.access?.authenticate(req.headers.authorization);
    if (!device && (!token || !timingSafeEqual(token, digest(req.headers.authorization ?? '')))) {
      throw new RequestError(401, '移动访问凭据无效或设备已断开。');
    }
    if (device) {
      responses.set(res, device);
      res.once('close', () => responses.delete(res));
    }
    if (method === 'GET' && url.pathname === '/mobile/v1/health') return json(res, 200, { ok: true, protocol: 1, inbox: true, downloadOriginal: true, remoteHost: options.access?.remoteHost(), maxUploadBytes: MOBILE_UPLOAD_MAX_BYTES, uploadChunkBytes: MOBILE_UPLOAD_CHUNK_BYTES, pagedSpeech: !!options.speech });
    if (device && options.access && url.pathname === '/mobile/v1/profile') {
      if (method === 'PUT') {
        const profile = z.strictObject({ name: mobileDeviceName }).safeParse(await readJson(req));
        if (!profile.success) throw new RequestError(400, '请输入 1 到 80 字的名字。');
        await options.access.renameDevice(device, profile.data.name);
      }
      if (method === 'GET' || method === 'PUT') return json(res, 200, { ok: true, name: options.access.deviceName(device) });
    }

    const bot = await options.bot();
    const requireDevice = () => {
      if (device && !options.access?.authenticate(req.headers.authorization)) throw new RequestError(401, '设备访问已撤销。');
    };
    requireDevice();
    const requireRoom = (roomId: string) => {
      requireDevice();
      if (!canChat(bot.store.getConversation(roomId))) throw new RequestError(403, '此会话未开放移动访问。');
    };

    if (options.speech && url.pathname === '/mobile/v1/speech' && (method === 'POST' || method === 'GET')) {
      const controller = new AbortController();
      res.once('close', () => controller.abort());
      const roomId = id.safeParse(url.searchParams.get('conversationId'));
      if (!roomId.success) throw new RequestError(400, '语音请求缺少会话。');
      requireRoom(roomId.data);
      try {
        if (method === 'POST') {
          const parts: Buffer[] = [];
          let length = 0;
          for await (const part of req) {
            length += part.length;
            if (length > 8 * 1024 * 1024) throw new RequestError(413, '录音超过大小限制。');
            parts.push(part);
          }
          requireRoom(roomId.data);
          return json(res, 200, { ok: true, text: await options.speech.transcribe(Buffer.concat(parts), controller.signal) });
        }
        const messageId = id.safeParse(url.searchParams.get('messageId'));
        const partId = id.nullable().safeParse(url.searchParams.get('partId'));
        if (!messageId.success || !partId.success) throw new RequestError(400, '语音请求中的消息编号无效。');
        const pageParam = url.searchParams.get('pageIndex');
        if (pageParam !== null && !/^\d{1,8}$/u.test(pageParam)) throw new RequestError(400, '语音请求中的对白页码无效。');
        const text = speechText(bot.store.getMessage(messageId.data), roomId.data, partId.data ?? undefined, pageParam === null ? undefined : Number(pageParam));
        const acceptsGzip = req.headers['accept-encoding']?.split(',').some(value => value.trim().toLowerCase() === 'gzip');
        let gzip: ReturnType<typeof createGzip> | undefined;
        let transfer: Promise<void> | undefined;
        try {
          await options.speech.play(text, !!partId.data, async audio => {
            requireRoom(roomId.data);
            if (!res.headersSent) {
              res.writeHead(200, { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', vary: 'Accept-Encoding',
                ...(acceptsGzip ? { 'content-encoding': 'gzip' } : {}) });
              if (acceptsGzip) {
                gzip = createGzip({ level: zlib.Z_BEST_SPEED, flush: zlib.Z_SYNC_FLUSH });
                transfer = pipeline(gzip, res);
                void transfer.catch(() => undefined);
              }
            }
            const output = gzip ?? res;
            if (!output.write(audio)) await once(output, 'drain', { signal: controller.signal });
          }, controller.signal);
          if (!res.headersSent) throw Error('DeepSeek 没有返回音频。');
          (gzip ?? res).end();
          await transfer;
        } finally {
          gzip?.destroy();
        }
        return;
      } catch (error) {
        if (error instanceof RequestError || res.headersSent) throw error;
        throw new RequestError(502, error instanceof Error ? error.message : '语音服务暂不可用。');
      }
    }

    if (method === 'POST' && url.pathname === '/mobile/v1/requests') {
      const raw = await readJson(req);
      const state = z.strictObject({ type: z.literal('state'), conversationId: id.optional(), after: z.number().int().min(0).optional(),
        callAfter: z.number().int().nonnegative().optional(), inboxAfter: z.number().int().min(-1).optional(), tracked: z.array(id).max(20).default([]), history: z.literal(true).optional(), before: z.number().int().positive().optional() }).safeParse(raw);
      const parsed = botRequestSchema.safeParse(state.success ? { type: 'state', conversationId: state.data.conversationId, before: state.data.before,
        ...(state.data.callAfter !== undefined && { surface: 'call', callAfter: state.data.callAfter }) } : raw);
      requireDevice();
      if (!parsed.success) throw new RequestError(400, '伙伴请求格式不正确。');
      const input = parsed.data;
      if (!requestTypes.has(input.type)) throw new RequestError(403, '此操作仅在电脑端提供。');
      if ('conversationId' in input && input.conversationId) requireRoom(input.conversationId);
      if (input.type === 'conversation.open' &&
          !bot.store.listCompanions().some(item => item.id === input.companionId && item.enabled !== false)) {
        throw new RequestError(403, '该伙伴当前不可用。');
      }
      if (input.type === 'message.send' && (input.browserContextId || input.apps?.length)) throw new RequestError(403, '此操作仅在电脑端提供。');
      if (input.type === 'reply.cancel' || input.type === 'execution.answer' || input.type === 'execution.continue') {
        requireRoom(bot.store.eventForReply(input.messageId)?.conversationId ?? '');
      }
      const origin = device ? { id: 'mobile:' + device, kind: 'mobile' as const, label: options.access?.deviceName(device) ?? 'Android' } : undefined;
      const scoped = origin && (input.type === 'message.send' || input.type === 'topic.new' || input.type === 'topic.compact')
        ? { ...input, requestId: digest(origin.id + '\0' + input.requestId).toString('hex') } : input;
      const result = await bot.handle(scoped, origin).catch((error: unknown) => {
        options.report(error);
        const code = (error as { code?: string })?.code;
        if (error instanceof DshMessageNotReadyError) throw new RequestError(409, error.message);
        if (code === 'BOT_EXECUTION_INSTANCE_REQUIRED' || code === 'BOT_COMPANION_INSTANCE_REQUIRED') {
          throw new RequestError(409, '电脑上的伙伴执行环境需要配置。');
        }
        if (input.type === 'topic.compact' && error instanceof Error && [
          '请等待当前任务完成后压缩话题；执行中的补充可使用引导。',
          '请等待当前会话空闲后压缩。',
          '当前 DSH 连接不支持原生压缩。',
          '这位伙伴尚未在此话题中开始会话。',
        ].includes(error.message)) throw new RequestError(409, error.message);
        throw new RequestError(409, '电脑未接受这次操作，请检查伙伴状态后重试。');
      });
      const snapshot = result.snapshot;
      const sent = result.messageId && input.type === 'message.send' ? bot.store.getMessage(result.messageId) : undefined;
      if (!snapshot) return json(res, 200, { ...result, topicListError: undefined, message: sent ? projectMessage(sent) : undefined });
      const { chatRuntime } = snapshot;
      const { messages } = snapshot;
      const after = state.success ? state.data.after : undefined;
      const tracked = new Set(state.success ? state.data.tracked : []);
      const history = state.success && state.data.history;
      const latest = messages.reduce((last, message) => Math.max(last, message.sequence), 0);
      const selected = after === undefined ? messages.slice(-6) : messages.filter(message => message.sequence > after).slice(-24);
      const updates = messages.filter(message => tracked.has(message.id) || message.status === 'running' || message.status === 'queued').slice(-24);
      const published = new Set(snapshot.callDelivery?.messageIds);
      const projected = history ? messages : [...new Map([...selected, ...updates, ...messages.filter(message => published.has(message.id))].map(message => [message.id, message])).values()].sort((a,b) => a.sequence - b.sequence);
      const projectedRoom = result.conversationId ?? ('conversationId' in input ? input.conversationId : undefined);
      const meeting = input.type === 'call.open' || input.type === 'state' && input.surface === 'call'
        || !!projectedRoom && bot.store.getConversation(projectedRoom)?.kind === 'direct';
      const rooms = snapshot.conversations.filter(room => canChat(bot.store.getConversation(room.id)));
      const inboxAfter = state.success ? state.data.inboxAfter : undefined;
      return json(res, 200, { ok: true, conversationId: result.conversationId, callStage: result.callStage,
        callModel: result.callModel && !result.callModel.modelUrl ? { model: result.callModel.model, manifest: result.callModel.manifest, vts: result.callModel.vtsParameters } : undefined,
        message: sent ? projectMessage(sent) : undefined, snapshot: {
        companions: snapshot.companions.map(({ id, name, enabled }) => ({ id, name, enabled, presence: snapshot.presence?.[id]?.status })),
        conversations: rooms.map(({ id, title, kind, memberIds, pinned }) => ({ id, title, kind, memberIds, pinned, activity: snapshot.conversationActivity?.[id] })),
        ...(inboxAfter !== undefined ? { inbox: { ...bot.store.companionInbox(rooms.map(room => room.id), inboxAfter === -1 ? undefined : inboxAfter), pushAfter: device ? options.access?.pushAfter(device) : undefined } } : {}),
        messages: projected.map(message => projectMessage(message, meeting && message.conversationId === projectedRoom)), cursor: latest, ...(history ? { hasMore: snapshot.hasMore } : {}),
        callDelivery: snapshot.callDelivery, ready: snapshot.runtime.ready,
        ...(chatRuntime ? { chatRuntime: { topic: chatRuntime.topic, queued: chatRuntime.queued, running: chatRuntime.running, hiddenMessageIds: chatRuntime.hiddenMessageIds,
          contexts: Object.fromEntries(Object.entries(chatRuntime.contexts ?? {}).map(([companionId, context]) =>
            [companionId, { pressure: context.pressure, phase: context.activity?.phase }])) } } : {}),
      } });
    }

    const roomId = id.safeParse(url.searchParams.get('conversationId'));
    if (method === 'GET' && url.pathname === '/mobile/v1/events') {
      if (url.searchParams.has('conversationId') && !roomId.success) throw new RequestError(400, '缺少有效的会话。');
      if (roomId.success) requireRoom(roomId.data);
      if (subscribers.size >= 12) throw new RequestError(429, '移动连接过多。');
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
      res.write('data: {"type":"ready"}\n\n');
      subscribers.set(res, roomId.data);
      if (url.searchParams.get('inbox') === '1') inboxStreams.add(res);
      res.once('close', () => { subscribers.delete(res); inboxStreams.delete(res); });
      return;
    }
    if (!roomId.success) throw new RequestError(400, '缺少有效的会话。');
    requireRoom(roomId.data);
    if (method === 'GET' && url.pathname === '/mobile/v1/call-asset') {
      const room = bot.store.getConversation(roomId.data);
      const relative = url.searchParams.get('path') ?? '';
      if (room?.kind !== 'direct' || !options.callAssetsRoot || !/^[^:\\?#%\x00]+\.(?:js|json|moc3|png)$/iu.test(relative)
          || relative.split('/').some(segment => !segment || segment === '.' || segment === '..')) {
        throw new RequestError(404, '会面形象资源不可用。');
      }
      const root = await realpath(options.callAssetsRoot);
      const candidate = await realpath(path.join(root, relative)).catch(() => undefined);
      if (!candidate || path.relative(root, candidate).startsWith('..')) throw new RequestError(404, '会面形象资源不存在。');
      const info = await stat(candidate);
      if (!info.isFile() || info.size > 24 * 1024 * 1024) throw new RequestError(404, '会面形象资源不可用。');
      const extension = path.extname(candidate).toLowerCase();
      const mime = extension === '.js' ? 'application/javascript' : extension === '.json' ? 'application/json' : extension === '.png' ? 'image/png' : 'application/octet-stream';
      res.writeHead(200, { 'content-type': mime, 'content-length': info.size });
      await pipeline(createReadStream(candidate), res);
      return;
    }
    if (url.pathname === '/mobile/v1/upload') {
      const parsed = z.uuid().safeParse(url.searchParams.get('id'));
      if (!parsed.success) throw new RequestError(400, '上传标识无效。');
      const key = (device ?? 'local') + ':' + parsed.data;
      let item = uploads.get(key);
      if (item && item.room !== roomId.data) throw new RequestError(403, '上传会话不匹配。');
      if (method === 'GET') {
        if (item) item.touched = Date.now();
        return json(res, 200, { ok: true, offset: item?.offset ?? 0, attachment: item?.attachment });
      }
      if (method === 'DELETE') {
        if (item?.busy) throw new RequestError(409, '当前分段仍在写入。');
        uploads.delete(key);
        if (item) await rm(item.directory, { recursive: true, force: true });
        return json(res, 200, { ok: true });
      }
      if (method !== 'PUT') throw new RequestError(405, '上传请求无效。');
      const name = fileName(url.searchParams.get('name'));
      const total = Number(url.searchParams.get('total')), offset = Number(url.searchParams.get('offset'));
      const length = Number(req.headers['content-length']);
      if (total > MOBILE_UPLOAD_MAX_BYTES) throw new RequestError(413, '单个文件最多 4 GiB。');
      if (![total, offset, length].every(value => Number.isSafeInteger(value) && value >= 0) ||
          length > MOBILE_UPLOAD_CHUNK_BYTES || offset + length > total || length === 0 && offset !== total) throw new RequestError(400, '文件分段参数无效。');
      if (!item) {
        if (offset !== 0) throw new RequestError(409, '上传已过期，请重试。');
        if ([...uploads.values()].filter(upload => !upload.attachment).length >= 24) throw new RequestError(429, '电脑正在接收其他文件。');
        // Reserve before awaiting I/O so retries cannot allocate a second file.
        item = { directory: '', file: '', room: roomId.data, name, total, offset: 0, touched: Date.now(), busy: true };
        uploads.set(key, item);
        try {
          const disk = await statfs(staging);
          if (disk.bsize * disk.bavail < total * 2) throw new RequestError(507, '电脑存储空间不足，请腾出空间后重试。');
          item.directory = await mkdtemp(path.join(staging, 'resumable-'));
          await mkdir(path.join(item.directory, 'data'));
          item.file = path.join(item.directory, 'data', name);
          await writeFile(item.file, '', { flag: 'wx' });
          await checkpoint(key, item);
        } catch (error) {
          uploads.delete(key);
          if (item.directory) await rm(item.directory, { recursive: true, force: true }).catch(options.report);
          throw error;
        }
        finally { item.busy = false; }
      }
      if (item.busy || item.name !== name || item.total !== total || item.offset !== offset) throw new RequestError(409, '上传进度已变化，请重试。');
      if (item.attachment) return json(res, 200, { ok: true, offset: item.offset, attachment: item.attachment });
      item.busy = true;
      try {
        const chunks: Buffer[] = [];
        let received = 0;
        for await (const chunk of req) {
          received += chunk.length;
          if (received > length) throw new RequestError(400, '文件分段长度无效。');
          chunks.push(chunk);
        }
        if (received !== length) throw new RequestError(400, '文件分段未完整接收。');
        requireRoom(roomId.data);
        if (length) try { await appendFile(item.file, Buffer.concat(chunks)); }
        catch (error) { await truncate(item.file, item.offset); throw error; }
        item.offset += received;
        if (item.offset === total) {
          const media = await options.media();
          const [attachment] = await media.importFiles({ conversationId: roomId.data, paths: [item.file], mobileUpload: true });
          if (!attachment) throw new RequestError(400, '电脑无法接收此附件。');
          await checkpoint(key, { ...item, attachment });
          item.attachment = attachment;
          await rm(item.file, { force: true }).catch(options.report);
        }
        return json(res, 200, { ok: true, offset: item.offset, attachment: item.attachment });
      } finally {
        item.busy = false;
        item.touched = Date.now();
      }
    }
    if (method === 'GET' && url.pathname === '/mobile/v1/stickers') {
      const media = await options.media();
      const packId = url.searchParams.get('packId');
      if (packId === null) {
        const packs = await media.listPacks({ conversationId: roomId.data });
        requireRoom(roomId.data);
        return json(res, 200, { ok: true, packs });
      }
      if (!id.safeParse(packId).success) throw new RequestError(400, '缺少有效的表情包。');
      const stickers = await media.listStickers({ conversationId: roomId.data, packId });
      requireRoom(roomId.data);
      return json(res, 200, { ok: true, stickers });
    }

    if (method === 'PUT' && url.pathname === '/mobile/v1/files') {
      const name = fileName(url.searchParams.get('name'));
      const length = Number(req.headers['content-length']);
      if (!Number.isSafeInteger(length) || length < 0) throw new RequestError(411, '上传需要有效的文件大小。');
      if (length > MOBILE_UPLOAD_MAX_BYTES) throw new RequestError(413, '单个文件最多 4 GiB。');
      if (transfers >= 4) throw new RequestError(429, '同时上传的文件过多。');
      transfers++;
      let directory: string | undefined;
      try {
        await mkdir(staging, { recursive: true });
        directory = await mkdtemp(path.join(staging, 'transfer-'));
        const target = path.join(directory, name);
        await pipeline(req, limit(length), createWriteStream(target, { flags: 'wx' }));
        requireRoom(roomId.data);
        const media = await options.media();
        const [attachment] = await media.importFiles({ conversationId: roomId.data, paths: [target], mobileUpload: true });
        requireRoom(roomId.data);
        return json(res, 201, { ok: true, attachment });
      } finally {
        transfers--;
        if (directory) await rm(directory, { recursive: true, force: true }).catch(options.report);
      }
    }

    if ((method === 'GET' || method === 'HEAD') && url.pathname === '/mobile/v1/files') {
      const messageId = id.safeParse(url.searchParams.get('messageId'));
      const attachmentId = id.safeParse(url.searchParams.get('id'));
      if (!messageId.success || !attachmentId.success) throw new RequestError(400, '缺少有效的附件标识。');
      const message = bot.store.getMessage(messageId.data);
      const attachment = message?.conversationId === roomId.data && message.attachments?.find(item => item.id === attachmentId.data);
      if (!attachment) throw new RequestError(404, '此消息没有这个附件。');
      const signal = new AbortController();
      res.once('close', () => signal.abort());
      const headers = new Headers();
      if (req.headers.range) headers.set('range', req.headers.range);
      const media = await options.media();
      const response = await media.response(new Request(attachment.url, { method, headers, signal: signal.signal }), true);
      requireRoom(roomId.data);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res);
      else res.end();
      return;
    }

    throw new RequestError(404, '移动接口不存在。');
  };

  const server = createServer({ headersTimeout: 10_000, requestTimeout: 10 * 60_000 }, (req, res) => {
    void route(req, res).catch((error: unknown) => {
      if (res.destroyed || res.headersSent) { res.destroy(); return; }
      if (error instanceof RequestError) json(res, error.status, { ok: false, error: error.message });
      else if ((error as NodeJS.ErrnoException).code === 'ENOSPC') json(res, 507, { ok: false, error: '电脑存储空间不足，请腾出空间后重试。' });
      else { options.report(error); json(res, 500, { ok: false, error: '电脑暂时无法完成这次请求。' }); }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => { server.off('error', reject); resolve(); });
  });
  server.on('error', options.report);
  const send = (res: ServerResponse, data: string) => { if (!res.write(data)) res.destroy(); };
  const heartbeat = setInterval(() => {
    for (const res of subscribers.keys()) send(res, ': heartbeat\n\n');
    for (const [key, item] of uploads) {
      if (item.busy || Date.now() - item.touched < uploadLifetime) continue;
      uploads.delete(key);
      if (item.directory) void rm(item.directory, { recursive: true, force: true }).catch(options.report);
    }
  }, 15_000);
  heartbeat.unref();
  return {
    port: (server.address() as { port: number }).port,
    supportsPush(id: string) { return [...inboxStreams].some(res => responses.get(res) === id); },
    pushChanged(id: string) { for (const res of inboxStreams) if (responses.get(res) === id) send(res, 'data: {"type":"changed"}\n\n'); },
    connected(id: string) { return [...responses].some(([res, device]) => device === id && subscribers.has(res)); },
    disconnect(id: string) { for (const [res, device] of responses) if (device === id) res.destroy(); },
    notify(event: BotEvent) {
      if (event.type === 'data-cleared') {
        for (const res of subscribers.keys()) send(res, 'data: {"type":"changed"}\n\n');
        return;
      }
      if (event.type !== 'changed' && event.type !== 'text' && event.type !== 'progress') return;
      const payload = `data: ${JSON.stringify(event.type === 'progress' ? { ...event, progress: projectProgress('running', event.progress) } : event)}\n\n`;
      for (const [res, roomId] of subscribers) {
        if (roomId && event.conversationId && event.conversationId !== roomId && !(event.type === 'changed' && inboxStreams.has(res))) continue;
        if (event.type === 'changed') { send(res, 'data: {"type":"changed"}\n\n'); continue; }
        if (!roomId) continue;
        void options.bot().then(bot => {
          if (subscribers.has(res) && canChat(bot.store.getConversation(roomId))) send(res, payload);
        }).catch(options.report);
      }
    },
    close() { clearInterval(heartbeat); subscribers.clear(); server.close(); server.closeAllConnections(); },
  };
}
