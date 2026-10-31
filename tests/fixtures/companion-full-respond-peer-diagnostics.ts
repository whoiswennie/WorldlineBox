/* eslint-disable @typescript-eslint/no-explicit-any -- Private benchmark-only journal observation. */
import { appendFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function createPeerToolDiagnostics(input: {
  root: string; targets(): Set<string>; now(): number;
  stopAfter?: number;
  cancel(task: { jobId: string; companionId: string; runId: string }): Promise<unknown>;
}) {
  const seen = new Set<string>(), begun = new Map<string, number>(), receipts: unknown[] = [];
  let finish!: (value: unknown) => void, stopping = false;
  const stopped = new Promise<unknown>(resolve => { finish = resolve; });
  async function observe(command: any) {
    if (command.type !== 'agent.run.save' || !command.run.sources.some((source: any) => input.targets().has(source.id))) return;
    const run = command.run;
    for (const [step, turn] of run.turns.entries()) for (const call of turn.calls) {
      if (call.name !== 'memory' && !call.name.startsWith('memory.')) continue;
      const key = run.id + '/' + step + '/' + call.id;
      if (!begun.has(key)) begun.set(key, input.now());
      const result = turn.results?.find((result: any) => result.callId === call.id);
      if (!result || seen.has(key)) continue;
      seen.add(key);
      let args: any = {}, value: any;
      try { args = JSON.parse(call.arguments); } catch { /* The actual schema failure remains in the result. */ }
      try { value = JSON.parse(result.content); } catch { value = undefined; }
      const query = typeof args.query === 'string' ? args.query : '';
      const notes = [value?.memories, value?.memoryNotes, value?.memorySearch?.results, value?.memoryRecall?.notes].find(Array.isArray);
      const rawError = value?.error;
      const publicError = typeof rawError === 'string' ? rawError : typeof rawError?.message === 'string' ? rawError.message : undefined;
      let schemaErrorCode: string | undefined;
      if (typeof rawError === 'string') try { const parsed = JSON.parse(rawError); if (Array.isArray(parsed) && typeof parsed[0]?.code === 'string') schemaErrorCode = parsed[0].code; } catch { /* A public domain error is not JSON. */ }
      const receipt = { kind: 'worldlinebox-peer-tool-diagnostic', step, tool: call.name, action: args.action,
        argumentKeys: Object.keys(args), argumentHash: digest(call.arguments), queryLength: query.length, queryHash: digest(query),
        ok: typeof value?.ok === 'boolean' ? value.ok : undefined,
        errorCode: typeof value?.code === 'string' ? value.code : typeof rawError?.code === 'string' ? rawError.code : schemaErrorCode,
        publicError: publicError?.slice(0, 240), resultKeys: value && typeof value === 'object' ? Object.keys(value) : ['non_json'],
        returnedNoteCount: notes?.length ?? (value?.ok === false ? 0 : undefined), durationMs: input.now() - begun.get(key)! };
      receipts.push(receipt);
      await appendFile(path.join(input.root, 'peer-tool-receipts.jsonl'), JSON.stringify(receipt) + '\n');
      await writeFile(path.join(input.root, 'peer-run-private-latest.json'), JSON.stringify(run));
      process.stdout.write(JSON.stringify(receipt) + '\n');
      if ((input.stopAfter ?? 5) > 0 && receipts.length >= (input.stopAfter ?? 5) && !stopping) {
        stopping = true;
        // The public agenda cancellation is applied after this real journal
        // save returns, so its original native source and lease remain exact.
        setImmediate(() => { void input.cancel({ jobId: run.invocationId, companionId: run.companionId, runId: run.id }).then(value => finish({ cancellationRequested: true, receipt: value }), error =>
          finish({ cancelled: false, name: error instanceof Error ? error.name : typeof error, message: error instanceof Error ? error.message : undefined })); });
      }
    }
  }
  return { observe, stopped, snapshot: () => receipts };
}
