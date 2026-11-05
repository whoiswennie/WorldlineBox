import { z } from 'zod';
import type { BotMediaRef } from './companion-bot-media';

export const LOCAL_SPEECH_CHANNEL = 'local-speech:request';
export const SPEECH_SAMPLE_RATE = 16000;
export const SPEECH_RECORDING_SECONDS = 60;
export const SPEECH_CHUNK_SECONDS = 20;
export const SPEECH_MAX_WAV_BYTES = 44 + SPEECH_SAMPLE_RATE * 2 * SPEECH_RECORDING_SECONDS;
export const SPEECH_MAX_TRANSCRIPT = 64000;
const id = z.string().min(1).max(160).regex(/^[A-Za-z0-9_-]+$/u);
const audio = z.string().min(60).max(Math.ceil(SPEECH_MAX_WAV_BYTES / 3) * 4).regex(/^[A-Za-z0-9+/]+={0,2}$/u);
export const localSpeechRequestSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('speech.status') }),
  z.strictObject({ type: z.literal('speech.prepare'), requestId: id }),
  z.strictObject({ type: z.literal('speech.cancel'), requestId: id }),
  z.strictObject({ type: z.literal('speech.transcribe'), requestId: id, audio }),
  z.strictObject({ type: z.literal('speech.voice'), requestId: id, conversationId: id, audio }),
  z.strictObject({ type: z.literal('speech.attachment'), requestId: id, conversationId: id, attachmentId: id }),
]);
export type LocalSpeechRequest = z.infer<typeof localSpeechRequestSchema>;
export interface LocalSpeechStatus { phase: 'unprepared' | 'preparing' | 'standby' | 'loading' | 'ready' | 'transcribing' | 'failed'; completedBytes?: number; totalBytes?: number; error?: string }
export interface LocalSpeechTranscript { text: string; audioSeconds: number; engine: 'sensevoice-int8-cpu' }
export interface LocalSpeechResponse { ok: boolean; cancelled?: boolean; error?: string; status?: LocalSpeechStatus; transcript?: LocalSpeechTranscript; media?: BotMediaRef }
export interface WorldlineBoxLocalSpeechApi { request(input: LocalSpeechRequest): Promise<LocalSpeechResponse> }

/** Canonical PCM16 WAV only. A renderer cannot bypass the recording limit with a false duration. */
export function validateSpeechWave(bytes: Uint8Array): number {
  if (bytes.byteLength < 46 || bytes.byteLength > SPEECH_MAX_WAV_BYTES) throw Error('录音必须在 60 秒以内。');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (offset: number) => String.fromCharCode(...bytes.subarray(offset, offset + 4));
  if (tag(0) !== 'RIFF' || tag(8) !== 'WAVE' || tag(12) !== 'fmt ' || tag(36) !== 'data'
    || view.getUint32(4, true) !== bytes.length - 8 || view.getUint32(16, true) !== 16
    || view.getUint16(20, true) !== 1 || view.getUint16(22, true) !== 1 || view.getUint32(24, true) !== SPEECH_SAMPLE_RATE
    || view.getUint32(28, true) !== 32000 || view.getUint16(32, true) !== 2 || view.getUint16(34, true) !== 16
    || view.getUint32(40, true) !== bytes.length - 44 || (bytes.length - 44) % 2) throw Error('录音格式无效，需要 16kHz 单声道 PCM WAV。');
  return (bytes.length - 44) / 32000;
}
