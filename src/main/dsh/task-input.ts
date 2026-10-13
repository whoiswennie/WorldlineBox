import { randomUUID } from 'node:crypto';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';

/** Owns bounded input admission receipts for one native CLI agent's lifetime. */
export class DshTaskInput {
  private child?: ChildProcessWithoutNullStreams;
  private readonly waiting = new Map<string, { resolve: () => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly ready = new Promise<void>((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
  private closed = false;
  constructor() { void this.ready.catch(() => undefined); }
  begin(child: ChildProcessWithoutNullStreams, prompt: string, inputs?: Array<{ id: string; content: string; mode: 'steer' | 'queue' }>, sourceInputId?: string) {
    if (this.closed) throw new Error('Task input is closed.');
    this.child = child;
    child.stdin.write(JSON.stringify({ type: 'start', content: prompt, inputs, sourceInputId }) + '\n');
    this.resolveReady();
  }
  async send(content: string, mode: 'steer' | 'queue', sourceInputId?: string): Promise<void> {
    if (this.closed || this.waiting.size >= 100) throw new Error('Task input is closed or its queue is full.');
    await this.ready;
    if (this.closed || this.waiting.size >= 100 || !this.child || !this.child.stdin.writable) throw new Error('The task no longer accepts input or its queue is full.');
    const requestId = randomUUID();
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(requestId); reject(new Error('Task input admission timed out.')); }, 120_000);
      this.waiting.set(requestId, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ type: mode, content, requestId, sourceInputId }) + '\n', error => { if (error) this.settle(requestId, false); });
    });
  }
  receive(value: Record<string, unknown>) {
    if (typeof value.requestId === 'string' && ['input_accepted', 'input_rejected'].includes(String(value.type))) this.settle(value.requestId, value.type === 'input_accepted');
  }
  private settle(id: string, accepted: boolean) {
    const request = this.waiting.get(id); if (!request) return;
    clearTimeout(request.timer); this.waiting.delete(id);
    if (accepted) request.resolve(); else request.reject(new Error('The task did not accept this input.'));
  }
  cancel() { if (this.child?.stdin.writable) this.child.stdin.write('{"type":"cancel"}\n'); }
  close() {
    this.closed = true; const error = new Error('The task stopped accepting input.');
    this.rejectReady(error); for (const pending of this.waiting.values()) { clearTimeout(pending.timer); pending.reject(error); } this.waiting.clear();
  }
}
