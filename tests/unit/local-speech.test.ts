import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterEach, expect, it, vi } from 'vitest';
import { SPEECH_MAX_WAV_BYTES, localSpeechRequestSchema, validateSpeechWave } from '../../src/shared/local-speech';
import { speechPcmChunks } from '../../src/main/local-speech-audio';
import { LocalSpeechService } from '../../src/main/local-speech-service';
import { encodeSpeechWave } from '../../src/renderer/companion-bot/voice-recorder';
import { BotMediaService } from '../../src/main/companion-bot/media-service';
import { botMessageEvidence } from '../../src/shared/bot-message-content';

const directories: string[] = [], services: LocalSpeechService[] = [];
afterEach(async () => { vi.useRealTimers(); for (const service of services.splice(0)) await service.close(); for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true }); });
async function directory() { const root = await mkdtemp(path.join(tmpdir(), 'wlb-speech-unit-')); directories.push(root); return root; }

it('enforces actual sample format and 60-second recording size, not a renderer duration hint', () => {
  const wave = encodeSpeechWave(new Float32Array(16000 * 61));
  expect(wave.length).toBe(SPEECH_MAX_WAV_BYTES); expect(validateSpeechWave(wave)).toBe(60);
  const invalid = wave.slice(); new DataView(invalid.buffer).setUint32(24, 8000, true);
  expect(() => validateSpeechWave(invalid)).toThrow('格式');
  expect(() => validateSpeechWave(new Uint8Array(SPEECH_MAX_WAV_BYTES + 2))).toThrow('60');
  expect(localSpeechRequestSchema.safeParse({ type: 'speech.transcribe', requestId: 'a', audio: 'A'.repeat(100), filePath: 'C:/private' }).success).toBe(false);
});

it('splits long PCM with backpressure into at most 20-second chunks without dropping or repeating samples', async () => {
  const input = Buffer.alloc(32000 * 187 + 18); for (let offset = 0; offset < input.length; offset += 2) input.writeInt16LE((offset % 19000) - 9500, offset);
  const pieces: Buffer[] = [];
  for await (const chunk of speechPcmChunks(Readable.from([input.subarray(0, 1), input.subarray(1, 19003), input.subarray(19003)]), new AbortController().signal)) {
    expect(chunk.length).toBeLessThanOrEqual(20 * 32000); expect(chunk.length % 2).toBe(0); pieces.push(chunk);
  }
  expect(pieces.length).toBeGreaterThan(9); expect(Buffer.concat(pieces)).toEqual(input);
});

it('does not pull the rest of a long file while a segment is being recognized and observes cancellation', async () => {
  let pulls = 0; const controller = new AbortController();
  async function* source() { for (let i = 0; i < 100; i++) { pulls++; yield Buffer.alloc(20 * 32000, 4); } }
  const iterator = speechPcmChunks(source(), controller.signal);
  expect((await iterator.next()).value?.length).toBeLessThanOrEqual(20 * 32000); expect(pulls).toBe(1);
  controller.abort(); await expect(iterator.next()).rejects.toThrow(); await iterator.return(undefined);
});

it('serializes inference, rejects excess admissions and cancels queued work without executing it', async () => {
  const root = await directory(), service = new LocalSpeechService({ root, resources: root, appPath: root }); services.push(service);
  let release!: () => void, executed = false;
  const first = service.run('one', () => new Promise<void>(resolve => { release = resolve; }));
  const second = service.run('two', async () => { executed = true; });
  const third = service.run('three', async () => undefined);
  await expect(service.run('four', async () => undefined)).rejects.toThrow('繁忙'); service.cancel('two');
  const cancelled = expect(second).rejects.toThrow(); await Promise.resolve(); release(); await first; await cancelled; await third; expect(executed).toBe(false);
  await service.close(); await expect(service.run('closed', async () => undefined)).rejects.toThrow('关闭');
});

async function warmingFixture() {
  const root = await directory(), bundle = path.join(root, 'speech-models'), runtime = path.join(root, 'speech-runtime');
  await mkdir(bundle); await mkdir(runtime);
  const model = Buffer.from('test-model');
  await writeFile(path.join(bundle, 'model.int8.onnx'), model);
  await writeFile(path.join(bundle, 'manifest.json'), JSON.stringify({ files: [{ path: 'model.int8.onnx', bytes: model.length, sha256: createHash('sha256').update(model).digest('hex') }] }));
  // A tiny protocol worker tests queue/lifecycle with an actual child process.
  // Native model inference is covered separately by the Electron acceptance test.
  const starts = path.join(root, 'starts.txt');
  await writeFile(path.join(runtime, 'worker.cjs'), `require('node:fs').appendFileSync(${JSON.stringify(starts)}, 'start\\n');
process.stdout.write(JSON.stringify({ ready: true }) + '\\n');
require('node:readline').createInterface({ input: process.stdin }).on('line', () => process.stdout.write(JSON.stringify({ text: '你好' }) + '\\n'));`);
  const service = new LocalSpeechService({ root, resources: root, appPath: process.cwd() }); services.push(service);
  return { root, starts, service };
}

it('coalesces startup warmup, loads without microphone/audio input and reuses the resident worker for first dictation', async () => {
  const { service, starts } = await warmingFixture();
  const first = service.prewarm(); expect(service.prewarm()).toBe(first); await first;
  expect(service.status()).toEqual({ phase: 'ready' }); expect(await readFile(starts, 'utf8')).toBe('start\n');
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  await vi.advanceTimersByTimeAsync(6 * 60_000); expect(service.status().phase).toBe('ready');
  vi.useRealTimers();
  await service.prewarm();
  const transcript = await service.run('dictate', signal => service.transcribeWave(Buffer.from(encodeSpeechWave(new Float32Array(16000))), signal));
  expect(transcript.text).toBe('你好'); expect(service.status().phase).toBe('ready');
  expect(await readFile(starts, 'utf8')).toBe('start\n');
});

it('does not let cancelling an operation queued during startup abort the shared warmup', async () => {
  const { service } = await warmingFixture();
  const warming = service.prewarm(), next = service.run('cancelled-dictation', async () => { throw Error('must not run'); });
  service.cancel('cancelled-dictation'); const cancelled = expect(next).rejects.toThrow();
  await warming; await cancelled; expect(service.status().phase).toBe('ready');
});

it('keeps a failed startup recoverable on the next automatic warmup', async () => {
  const { root, service } = await warmingFixture();
  await writeFile(path.join(root, 'speech-runtime', 'worker.cjs'), 'process.exit(1);');
  await expect(service.prewarm()).rejects.toThrow(); expect(service.status().phase).toBe('failed');
  await writeFile(path.join(root, 'speech-runtime', 'worker.cjs'), "process.stdout.write('{\"ready\":true}\\n');process.stdin.resume();");
  await service.prewarm(); expect(service.status().phase).toBe('ready');
});

it('stores a playable voice and model transcript together and keeps them in the authorized conversation', async () => {
  const root = await directory(), builtinRoot = path.join(root, 'builtin'); await mkdir(builtinRoot);
  await writeFile(path.join(builtinRoot, 'manifest.json'), JSON.stringify({ schema: 1, media: [], packs: [] }));
  const media = new BotMediaService({ root: path.join(root, 'media'), builtinRoot });
  const transcript = { text: '你好，帮我整理一下今天的计划。', audioSeconds: 1, engine: 'sensevoice-int8-cpu' as const };
  const wave = Buffer.from(encodeSpeechWave(new Float32Array(16000)));
  const voice = await media.importVoice('room', wave, transcript);
  expect(voice.voice?.durationSeconds).toBe(1); expect(voice.transcript).toEqual(transcript);
  expect(await readFile((await media.getForAgent('room', voice.id)).path)).toEqual(wave);
  expect(botMessageEvidence({ content: '', attachments: [voice] })).toContain(transcript.text);
  await expect(media.resolveForConversation('other', [voice.id])).rejects.toThrow('当前会话');
  const restarted = new BotMediaService({ root: path.join(root, 'media'), builtinRoot });
  expect((await restarted.resolveForConversation('room', [voice.id]))[0]?.transcript).toEqual(transcript);
});
