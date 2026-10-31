import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionReportedUsage } from '../../src/shared/companion-model-usage';
import { companionProviderUsage, mergeCompanionProviderUsage } from '../../src/main/companions/model-usage';

export interface FullRespondProviderObservation {
  label?: string; purpose?: string; phase?: string; format: AiApiFormat; requestCharacters: number; requestBytes: number;
  startedAtMs: number; headersAtMs?: number; firstBodyChunkAtMs?: number; firstContentDeltaAtMs?: number; bodyCompletedAtMs?: number;
  streamed?: boolean;
  status?: number; responseBytes?: number; actualUsage?: CompanionReportedUsage; observationFailure?: string;
}

/** Drain only a clone of the actual response. The real parser receives the
 * original untouched stream. Retain timing and native token counters only. */
export async function observeFullRespondProviderResponse(response: Response, value: FullRespondProviderObservation, nowMs: () => number): Promise<void> {
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    reader = response.clone().body?.getReader(); if (!reader) return;
    const eventStream = response.headers.get('content-type')?.toLowerCase().includes('text/event-stream');
    value.streamed = !!eventStream;
    const decoder = new TextDecoder(); let pending = '', received = 0;
    const inspect = (text: string) => {
      if (!text.trim() || text.trim() === '[DONE]') return;
      let parsed: unknown; try { parsed = JSON.parse(text); } catch { return; }
      const usage = companionProviderUsage(value.format, parsed);
      if (usage) value.actualUsage = mergeCompanionProviderUsage(value.actualUsage, usage);
      if (eventStream && value.firstContentDeltaAtMs === undefined && hasContentDelta(parsed)) value.firstContentDeltaAtMs = nowMs();
    };
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      if (chunk.value.length) value.firstBodyChunkAtMs ??= nowMs();
      received += chunk.value.length; pending += decoder.decode(chunk.value, { stream: true });
      if (pending.length > 2 * 1024 * 1024) throw new Error('Provider usage observation exceeded its bounded buffer.');
      if (eventStream) {
        const lines = pending.split('\n'); pending = lines.pop()!;
        for (const line of lines) if (line.startsWith('data:')) inspect(line.slice(5));
      }
    }
    pending += decoder.decode();
    if (eventStream) { if (pending.startsWith('data:')) inspect(pending.slice(5)); }
    else inspect(pending);
    value.responseBytes = received; value.bodyCompletedAtMs = nowMs();
  } catch (error) { value.observationFailure = error instanceof Error ? error.name : 'UnknownObservationFailure'; }
  finally { reader?.releaseLock(); }
}

function hasContentDelta(value: unknown): boolean {
  const object = (input: unknown): Record<string, unknown> => input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const root = object(value), choices = Array.isArray(root.choices) ? root.choices : [];
  const delta = object(object(choices[0]).delta), nested = object(root.delta);
  if (typeof delta.content === 'string' && delta.content || typeof nested.text === 'string' && nested.text
    || root.type === 'response.output_text.delta' && typeof root.delta === 'string' && root.delta) return true;
  return (Array.isArray(root.candidates) ? root.candidates : []).some(candidate => {
    const parts = object(object(candidate).content).parts;
    return Array.isArray(parts) && parts.some(part => typeof object(part).text === 'string' && !!object(part).text);
  });
}
