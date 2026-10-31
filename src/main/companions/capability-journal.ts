import { companionCapabilityRecordId } from '../../shared/companion-capability-id';
export { companionCapabilityRecordId } from '../../shared/companion-capability-id';
import type { CompanionAction, CompanionActionEvent } from '../../shared/companions';
import type { CompanionLoopCall } from '../../shared/companion-loop';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../../shared/companion-storage';

export interface CompanionCapabilityScope {
  companionId: string; conversationId: string; invocationId: string;
  sourceMessageId?: string; parentMessageId?: string; loopStep?: number; agendaRunId?: string; leaseToken?: string; authorizationGrantId?: string;
}
export function companionCapabilityTitle(call: CompanionLoopCall): string {
  let action = ''; try { action = (JSON.parse(call.arguments) as { action?: string }).action ?? ''; } catch { /* Invalid arguments still have a visible failed call. */ }
  if (call.name === 'agenda') return ({ read: '看看日程与任务', 'tasks.read': '看看手头的任务', 'rule.create': '安排一件事', 'rule.update': '调整已有安排',
    'rule.control': '调整安排的执行状态', 'goal.create': '为长期任务做好准备', 'goal.update': '调整长期任务', 'goal.control': '调整长期任务的状态' } as Record<string, string>)[action] ?? '查看与维护自己的安排';
  return ({ observe: '看看你正在忙什么', memory: '回想相关经历', research: '查阅相关资料', think: '仔细想一想', agenda_files: '查看与整理获准的文件',
    browser: '浏览需要了解的内容', world: '留意身边的情况并行动', wait: '等一会儿，留意后续变化', read_file: '阅读一份文件', send_file: '把文件交给你',
    read_image: '看看图片里的内容', list_files: '查找需要的文件', dsh_capabilities: '看看现在能使用哪些能力', dsh_control: '查看与跟进正在做的事' } as Record<string, string>)[call.name]
    ?? (call.name.startsWith('memory') ? '回想与整理相关经历' : '使用能力：' + call.name);
}
function visibleInput(text: string): string {
  try { return JSON.stringify(JSON.parse(text), (key: string, value: unknown) => /^(?:apiKey|api_key|password|secret|token|authorization|cookie|credential)$/iu.test(key) ? '[已隐藏凭据]' : value); }
  catch { return text; }
}
function visibleData(value: unknown): unknown {
  if (typeof value === 'string') return visibleInput(value);
  if (value === undefined) return value;
  return JSON.parse(visibleInput(JSON.stringify(value))) as unknown;
}
function resultData(value: unknown) {
  let data: unknown = value;
  if (value && typeof value === 'object' && 'content' in value && typeof value.content === 'string') {
    try { data = JSON.parse(value.content) as unknown; } catch { data = value.content; }
  }
  return data;
}
/** A presentation receipt for an actual tool invocation, never a second
 * scheduler or authority to replay an unconfirmed effect. */
export class CompanionCapabilityJournal {
  private readonly active = new Map<string, Promise<unknown>>();
  constructor(private readonly options: {
    request(command: CompanionStorageCommand): Promise<CompanionStorageResponse>;
    changed(): void; controller(id: string, controller?: AbortController): void;
    report(error: unknown): void;
  }) {}
  run<T>(scope: CompanionCapabilityScope, call: CompanionLoopCall, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const key = JSON.stringify([scope.companionId, scope.conversationId, scope.invocationId, call.id]);
    const pending = this.active.get(key); if (pending) return pending as Promise<T>;
    const promise = this.perform(scope, call, signal, execute).finally(() => this.active.delete(key));
    this.active.set(key, promise); return promise;
  }
  private async perform<T>(scope: CompanionCapabilityScope, call: CompanionLoopCall, signal: AbortSignal, execute: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted();
    const id = companionCapabilityRecordId(scope, call.id);
    const existing = await this.options.request({ type: 'action.get', id }).catch(error => {
      if (error instanceof Error && /^(?:Error: )?行动不存在。?$/u.test(error.message)) return { ok: true } as CompanionStorageResponse;
      throw error;
    });
    if (!existing.ok && !/^(?:Error: )?行动不存在。?$/u.test(existing.error ?? '')) throw new Error(existing.error ?? '原能力过程尚未核对，未重复执行操作。');
    if (existing.action) throw new Error('这次能力调用已有原过程，未通过过程卡自动重发；请在原任务核对实际结果。');
    const title = companionCapabilityTitle(call);
    const begun = await this.options.request({ type: 'capability.begin', ...scope, name: call.name, callId: call.id, title, input: visibleInput(call.arguments) });
    const action = begun.action;
    if (!begun.ok || !action?.capability) throw new Error(begun.error ?? '能力过程尚未登记，未隐藏启动操作。');
    const controller = new AbortController(), effective = AbortSignal.any([signal, controller.signal]);
    this.options.controller(id, controller); this.options.changed();
    const finish = async (status: CompanionAction['status'], summary: string, data?: unknown) => {
      summary = visibleInput(summary);
      const content = data === undefined ? undefined : typeof data === 'string' ? data : JSON.stringify(data);
      const event: CompanionActionEvent = { sequence: 1, type: 'capability.' + status, summary: summary.slice(0, 1000), toolName: call.name,
        callId: call.id, receivedAt: new Date().toISOString(), contentKind: 'output',
        ...(content ? { content: content.slice(0, 15900) + (content.length > 15900 ? '\n[展示已截短，原始结果保留在本次调用记录中。]' : '') } : {}) };
      const settled = await this.options.request({ type: 'action.update', id, patch: { status, stage: summary.slice(0, 1000),
        ...(status === 'failed' ? { error: summary.slice(0, 1000) } : {}), result: content?.slice(0, 65000), events: [...action.events ?? [], event] } });
      if (!settled.ok) throw new Error(settled.error ?? '能力已返回，但完成过程尚未保存。');
      this.options.changed();
    };
    try {
      effective.throwIfAborted();
      const value = await execute(effective); effective.throwIfAborted();
      const data = visibleData(resultData(value));
      const outcome = data && typeof data === 'object' && 'outcome' in data ? data.outcome : undefined;
      const failed = outcome === 'failed' || !!(data && typeof data === 'object' && 'ok' in data && data.ok === false);
      const stopped = outcome === 'cancelled';
      const error = failed || stopped ? data && typeof data === 'object' && 'error' in data && typeof data.error === 'string'
        ? data.error : stopped ? '本次能力已停止。' : '本次能力没有完成。' : undefined;
      await finish(stopped ? 'cancelled' : failed ? 'failed' : 'succeeded', error ?? '本次调用已有实际返回。', data).catch(error => {
        try { this.options.report(error); } catch { /* Reporting cannot invalidate the actual operation's result. */ }
      });
      return value;
    } catch (error) {
      await finish(effective.aborted ? 'cancelled' : 'failed', error instanceof Error ? error.message : '本次调用未完成。').catch(() => undefined);
      throw error;
    } finally { this.options.controller(id); }
  }
}
