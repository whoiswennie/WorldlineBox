import BetterSqlite3 from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { toolResultView } from './app-brain-tool-view';
import { projectAppHistoricalPrompt } from './app-brain-history-view';
import type { BotDshTool } from './dsh-brain';

export interface AppBrainCall { id: string; name: string; arguments: string }
export interface AppBrainMessage { role: 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }>; tool_call_id?: string }
export interface AppBrainTurn {
  seq: number; eventId: string; laneId: string; fingerprint: string; state: string; prompt: string;
  text: string; error?: string; cancelRequested: boolean; leaseOwner?: string; leaseUntil: number; leasePid: number;
}
export interface AppBrainStoredCall extends AppBrainCall { step: number; position: number; state: string; result?: unknown }
export interface AppBrainStep { ordinal: number; state: string; assistant?: AppBrainMessage; calls: AppBrainStoredCall[] }
export interface AppBrainSummary { through: number; text: string }
export interface AppBrainBinding { system: string; cwd: string; tools: readonly BotDshTool[] }
type Row = Record<string, unknown>;
interface Statement { all(...values: unknown[]): unknown[]; get(...values: unknown[]): unknown; run(...values: unknown[]): { changes: number } }
interface Connection {
  prepare(sql: string): Statement; exec(sql: string): void; pragma(sql: string): unknown;
  transaction<T>(fn: () => T): (() => T) & { immediate(): T }; close(): void;
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; } };
const terminal = new Set(['succeeded', 'failed', 'cancelled', 'quarantined']);
// At most seven bounded disk views per receipt and projection version. There
// is no process-wide raw-receipt or view map that grows with conversation age.
const viewBudgets = [250, 350, 600, 800, 1800, 3500, 7500];
const viewBudget = (requested: number) => viewBudgets.filter(value => value <= requested).at(-1) ?? 250;

/** Small transactional journal for the App Agent, independent of DSH files.
 * Intent is committed before a tool leaves the process. No credential or
 * ephemeral callback capability is part of this journal. */
export class BotAppBrainStore {
  private readonly db: Connection;
  readonly owner = `${process.pid}:${randomUUID()}`;
  constructor(filename: string) {
    mkdirSync(path.dirname(filename), { recursive: true });
    const Database = BetterSqlite3 as { new(filename: string): Connection };
    this.db = new Database(filename);
    this.db.pragma('journal_mode = WAL'); this.db.pragma('synchronous = FULL'); this.db.pragma('foreign_keys = ON');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS app_lanes(lane_id TEXT PRIMARY KEY,summary_through INTEGER NOT NULL DEFAULT 0,summary_text TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS app_turns(seq INTEGER PRIMARY KEY AUTOINCREMENT,event_id TEXT UNIQUE NOT NULL,lane_id TEXT NOT NULL REFERENCES app_lanes(lane_id),fingerprint TEXT NOT NULL,prompt TEXT NOT NULL,state TEXT NOT NULL,text TEXT NOT NULL DEFAULT '',error TEXT,cancel_requested INTEGER NOT NULL DEFAULT 0,lease_owner TEXT,lease_pid INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS app_turns_lane ON app_turns(lane_id,seq);
      CREATE TABLE IF NOT EXISTS app_steps(event_id TEXT NOT NULL REFERENCES app_turns(event_id),ordinal INTEGER NOT NULL,state TEXT NOT NULL,assistant_json TEXT,PRIMARY KEY(event_id,ordinal));
      CREATE TABLE IF NOT EXISTS app_calls(event_id TEXT NOT NULL,step INTEGER NOT NULL,position INTEGER NOT NULL,call_id TEXT NOT NULL,name TEXT NOT NULL,args_json TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT,PRIMARY KEY(event_id,call_id),FOREIGN KEY(event_id,step) REFERENCES app_steps(event_id,ordinal));
      CREATE INDEX IF NOT EXISTS app_calls_identity ON app_calls(call_id);
      CREATE TABLE IF NOT EXISTS app_call_views(event_id TEXT NOT NULL,call_id TEXT NOT NULL,budget INTEGER NOT NULL,version INTEGER NOT NULL,view_json TEXT NOT NULL,
        PRIMARY KEY(event_id,call_id,budget,version),FOREIGN KEY(event_id,call_id) REFERENCES app_calls(event_id,call_id));
      CREATE TABLE IF NOT EXISTS app_handoffs(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    `);
    const columns = this.db.prepare('PRAGMA table_info(app_turns)').all() as Row[];
    if (!columns.some(column => column.name === 'binding_json')) this.db.exec('ALTER TABLE app_turns ADD COLUMN binding_json TEXT');
    if (!columns.some(column => column.name === 'recovery_attempts')) this.db.exec('ALTER TABLE app_turns ADD COLUMN recovery_attempts INTEGER NOT NULL DEFAULT 0');
  }
  private turn(row: Row): AppBrainTurn { return { seq: Number(row.seq), eventId: String(row.event_id), laneId: String(row.lane_id), fingerprint: String(row.fingerprint),
    prompt: String(row.prompt), state: String(row.state), text: String(row.text), error: row.error ? String(row.error) : undefined,
    cancelRequested: !!row.cancel_requested, leaseOwner: row.lease_owner ? String(row.lease_owner) : undefined, leasePid: Number(row.lease_pid), leaseUntil: Number(row.lease_until) }; }
  get(eventId: string): AppBrainTurn | undefined { const value = this.db.prepare('SELECT * FROM app_turns WHERE event_id=?').get(eventId); return value ? this.turn(value as Row) : undefined; }
  hasLane(laneId: string): boolean { return !!this.db.prepare('SELECT 1 FROM app_lanes WHERE lane_id=?').get(laneId); }
  binding(eventId: string): AppBrainBinding | undefined {
    const value = this.db.prepare('SELECT binding_json FROM app_turns WHERE event_id=?').get(eventId) as Row | undefined;
    return value?.binding_json ? JSON.parse(String(value.binding_json)) as AppBrainBinding : undefined;
  }
  admit(input: { laneId: string; eventId: string; fingerprint: string; prompt: string; binding?: AppBrainBinding }): AppBrainTurn {
    return this.db.transaction(() => {
      const prior = this.get(input.eventId);
      if (prior) {
        const saved = this.binding(input.eventId);
        const sameInput = saved && input.binding && prior.prompt === input.prompt && saved.system === input.binding.system && saved.cwd === input.binding.cwd;
        if (prior.laneId !== input.laneId || prior.fingerprint !== input.fingerprint && !sameInput) throw new Error('App主脑事件标识对应其他输入或旧工具版本尚未核实。');
        return prior;
      }
      this.db.prepare('INSERT OR IGNORE INTO app_lanes(lane_id) VALUES(?)').run(input.laneId);
      this.db.prepare("INSERT INTO app_turns(event_id,lane_id,fingerprint,prompt,state) VALUES(?,?,?,?,'pending')").run(input.eventId, input.laneId, input.fingerprint, input.prompt);
      if (input.binding) this.db.prepare('UPDATE app_turns SET binding_json=? WHERE event_id=?').run(JSON.stringify(input.binding), input.eventId);
      return this.get(input.eventId)!;
    }).immediate();
  }
  predecessors(laneId: string, before: number): AppBrainTurn[] {
    const family = this.laneFamily(laneId);
    return (this.db.prepare("SELECT * FROM app_turns WHERE (lane_id=? OR lane_id LIKE ? ESCAPE '\\') AND seq<? AND state NOT IN ('succeeded','failed','cancelled') ORDER BY seq LIMIT 32")
      .all(...family, before) as Row[]).map(value => this.turn(value));
  }
  private laneFamily(laneId: string): [string, string] {
    const base = laneId.replace(/-epoch-[1-9]\d*$/u, '');
    return [base, base.replace(/[\\%_]/gu, value => '\\' + value) + '-epoch-%'];
  }
  unresolvedCalls(laneId: string): Array<{ eventId: string; callId: string; name: string }> {
    return (this.db.prepare("SELECT c.event_id,c.call_id,c.name FROM app_calls c JOIN app_turns t ON t.event_id=c.event_id WHERE (t.lane_id=? OR t.lane_id LIKE ? ESCAPE '\\') AND t.state IN ('quarantined','tool_unknown','suspended','running') AND c.state='invoking' ORDER BY t.seq LIMIT 64")
      .all(...this.laneFamily(laneId)) as Row[]).map(value => ({ eventId: String(value.event_id), callId: String(value.call_id), name: String(value.name) }));
  }
  noteUnknown(eventId: string): number {
    this.assertLease(eventId); this.db.prepare('UPDATE app_turns SET recovery_attempts=recovery_attempts+1 WHERE event_id=?').run(eventId);
    return Number((this.db.prepare('SELECT recovery_attempts FROM app_turns WHERE event_id=?').get(eventId) as Row).recovery_attempts);
  }
  claim(eventId: string, recovery = false): AppBrainTurn {
    return this.db.transaction(() => {
      const turn = this.get(eventId); if (!turn) throw new Error('App主脑事件不存在。');
      if (terminal.has(turn.state) && !(recovery && turn.state === 'quarantined')) return turn;
      if (turn.leaseOwner && turn.leaseOwner !== this.owner && turn.leaseUntil > Date.now() && alive(turn.leasePid)) throw Object.assign(new Error('App主脑事件仍由另一个执行器持有。'), { code: 'BOT_LANE_BUSY' });
      const other = this.db.prepare("SELECT event_id FROM app_turns WHERE lane_id=? AND seq<? AND state NOT IN ('succeeded','failed','cancelled','quarantined') ORDER BY seq LIMIT 1").get(turn.laneId, turn.seq) as Row | undefined;
      if (other) throw Object.assign(new Error('App主脑通道的较早事件尚未核实或完成。'), { code: 'BOT_LANE_BUSY' });
      this.db.prepare("UPDATE app_turns SET state='running',lease_owner=?,lease_pid=?,lease_until=? WHERE event_id=?").run(this.owner, process.pid, Date.now() + 60000, eventId);
      return this.get(eventId)!;
    }).immediate();
  }
  assertLease(eventId: string): AppBrainTurn {
    const turn = this.get(eventId);
    if (!turn || turn.leaseOwner !== this.owner || turn.leaseUntil <= Date.now()) throw Object.assign(new Error('App主脑事件租约已失效。'), { code: 'BOT_LANE_BUSY' });
    return turn;
  }
  heartbeat(eventId: string): boolean { return !!this.db.prepare('UPDATE app_turns SET lease_until=? WHERE event_id=? AND lease_owner=?').run(Date.now() + 60000, eventId, this.owner).changes; }
  release(eventId: string): void { this.db.prepare('UPDATE app_turns SET lease_owner=NULL,lease_pid=0,lease_until=0 WHERE event_id=? AND lease_owner=?').run(eventId, this.owner); }
  requestCancel(eventId: string): void { this.db.prepare('UPDATE app_turns SET cancel_requested=1 WHERE event_id=?').run(eventId); }
  draft(eventId: string, value: string): void { this.assertLease(eventId); this.db.prepare('UPDATE app_turns SET text=? WHERE event_id=?').run(value, eventId); }
  finish(eventId: string, state: 'succeeded' | 'failed' | 'cancelled' | 'suspended' | 'tool_unknown' | 'quarantined', text: string, error?: string): AppBrainTurn {
    this.assertLease(eventId); this.db.prepare('UPDATE app_turns SET state=?,text=?,error=? WHERE event_id=?').run(state, text, error ?? null, eventId); return this.get(eventId)!;
  }
  steps(eventId: string): AppBrainStep[] {
    const rows = this.db.prepare('SELECT * FROM app_steps WHERE event_id=? ORDER BY ordinal').all(eventId) as Row[];
    return rows.map(row => ({ ordinal: Number(row.ordinal), state: String(row.state), assistant: row.assistant_json ? JSON.parse(String(row.assistant_json)) as AppBrainMessage : undefined,
      calls: (this.db.prepare('SELECT step,position,call_id,name,args_json,state FROM app_calls WHERE event_id=? AND step=? ORDER BY position').all(eventId, row.ordinal) as Row[]).map(call => ({ id: String(call.call_id), name: String(call.name), arguments: String(call.args_json),
        step: Number(call.step), position: Number(call.position), state: String(call.state) })) }));
  }
  requestStep(eventId: string, ordinal: number): void { this.assertLease(eventId); this.db.prepare("INSERT OR IGNORE INTO app_steps(event_id,ordinal,state) VALUES(?,?,'requesting')").run(eventId, ordinal); }
  commitAssistant(eventId: string, ordinal: number, assistant: AppBrainMessage, calls: AppBrainCall[]): void {
    this.db.transaction(() => {
      this.assertLease(eventId);
      const prior = this.db.prepare('SELECT assistant_json FROM app_steps WHERE event_id=? AND ordinal=?').get(eventId, ordinal) as Row | undefined;
      if (prior?.assistant_json) { if (prior.assistant_json !== JSON.stringify(assistant)) throw new Error('App模型步骤已提交，不能替换。'); return; }
      this.db.prepare("UPDATE app_steps SET state='completed',assistant_json=? WHERE event_id=? AND ordinal=?").run(JSON.stringify(assistant), eventId, ordinal);
      for (const [position, call] of calls.entries()) this.db.prepare("INSERT INTO app_calls(event_id,step,position,call_id,name,args_json,state) VALUES(?,?,?,?,?,?,'planned')").run(eventId, ordinal, position, call.id, call.name, call.arguments);
    }).immediate();
  }
  invoke(eventId: string, callId: string): void { if (this.assertLease(eventId).cancelRequested) throw new Error('主脑工具派发前已收到停止请求。'); if (!this.db.prepare("UPDATE app_calls SET state='invoking' WHERE event_id=? AND call_id=? AND state='planned'").run(eventId, callId).changes) throw new Error('工具步骤已经投递，必须先核实回执。'); }
  commitTool(eventId: string, callId: string, result: unknown): void {
    this.assertLease(eventId); const raw = JSON.stringify(result ?? null); if (raw.length > 1024 * 1024) throw new Error('App主脑工具回执超过持久化容量。');
    const call = this.db.prepare('SELECT name FROM app_calls WHERE event_id=? AND call_id=?').get(eventId, callId) as Row | undefined;
    const budget = call?.name === 'agent_read_tool_result' ? 7500 : 3500, view = toolResultView(callId, result, budget);
    this.db.transaction(() => {
      this.assertLease(eventId);
      const committed = this.db.prepare("UPDATE app_calls SET state='committed',result_json=? WHERE event_id=? AND call_id=? AND state IN ('planned','invoking')").run(raw, eventId, callId).changes;
      if (committed) this.db.prepare('INSERT OR IGNORE INTO app_call_views VALUES(?,?,?,?,?)').run(eventId, callId, budget, 1, view);
    }).immediate();
  }
  private resultView(eventId: string, call: AppBrainStoredCall, budget: number): string {
    budget = viewBudget(budget);
    const cached = this.db.prepare('SELECT view_json FROM app_call_views WHERE event_id=? AND call_id=? AND budget=? AND version=1').get(eventId, call.id, budget) as Row | undefined;
    if (cached) return String(cached.view_json);
    const raw = this.db.prepare("SELECT result_json FROM app_calls WHERE event_id=? AND call_id=? AND state='committed'").get(eventId, call.id) as Row | undefined;
    if (!raw) throw new Error('App主脑缺少已确认工具回执。');
    const view = toolResultView(call.id, JSON.parse(String(raw.result_json)) as unknown, budget);
    this.db.prepare('INSERT OR IGNORE INTO app_call_views VALUES(?,?,?,?,?)').run(eventId, call.id, budget, 1, view);
    return view;
  }
  durableResult(laneId: string, throughSeq: number, callId: string): { found: boolean; value?: unknown } {
    if (callId === 'summary') return { found: true, value: this.summary(laneId) };
    if (callId.startsWith('turn:')) {
      const turn = this.get(callId.slice(5));
      if (!turn || turn.laneId !== laneId || turn.seq > throughSeq) return { found: false };
      return { found: true, value: { eventId: turn.eventId, prompt: turn.prompt, steps: this.steps(turn.eventId).filter(step => step.assistant && step.calls.every(call => call.state === 'committed'))
        .map(step => ({ step: step.ordinal, text: step.assistant!.content, calls: step.calls.map(call => ({ callId: call.id, name: call.name,
          arguments: JSON.parse(call.arguments) as unknown, state: call.state, read: { callId: call.id } })) })) } };
    }
    const value = this.db.prepare(`SELECT c.result_json FROM app_calls c JOIN app_turns t ON t.event_id=c.event_id
      WHERE t.lane_id=? AND t.seq<=? AND c.call_id=? AND c.state='committed'`).get(laneId, throughSeq, callId) as Row | undefined;
    return value ? { found: true, value: JSON.parse(String(value.result_json)) as unknown } : { found: false };
  }
  messages(turn: AppBrainTurn, viewBytes = 3500, compactSteps: boolean | 'all' = false, promptView = turn.prompt): AppBrainMessage[] {
    const messages: AppBrainMessage[] = [{ role: 'user', content: promptView }];
    const steps = this.steps(turn.eventId);
    let visibleSteps = steps;
    if (compactSteps && steps.length) {
      const completed = steps.filter(step => step.assistant && step.calls.every(call => call.state === 'committed'));
      const pending = steps.filter(step => step.assistant && step.calls.some(call => call.state !== 'committed'));
      // Reader page sizing runs before its receipt is committed. Older groups
      // may become a ledger already; every unresolved call stays whole.
      const older = compactSteps === 'all' || pending.length ? completed : completed.slice(0, -1);
      visibleSteps = pending.length ? pending : compactSteps === 'all' ? [] : completed.slice(-1);
      if (older.length) messages.push({ role: 'assistant', content: JSON.stringify({ kind: 'durable_tool_steps_summary',
        detail: '这是宿主从已确认步骤生成的有界资料。原工具不应重执行；需要细节时按read回读原件。',
        completedSteps: older.length, confirmedCalls: older.reduce((sum, step) => sum + step.calls.length, 0),
        read: { tool: 'agent_read_tool_result', callId: `turn:${turn.eventId}`, jsonPath: '/steps', offset: 0, limit: 4 },
        recent: older.slice(viewBytes < 400 ? -1 : -3).map(step => ({ step: step.ordinal, text: step.assistant!.content?.slice(0, 160),
          calls: step.calls.slice(viewBytes < 400 ? -1 : -3).map(call => ({ callId: call.id, name: call.name, state: call.state,
            result: JSON.parse(this.resultView(turn.eventId, call, Math.min(600, viewBytes))) as unknown })) })) }) });
    }
    for (const step of visibleSteps) if (step.assistant) {
      messages.push(step.assistant);
      for (const call of step.calls) if (call.state === 'committed') {
        messages.push({ role: 'tool', tool_call_id: call.id, content: this.resultView(turn.eventId, call, call.name === 'agent_read_tool_result' ? Math.max(7500, viewBytes) : viewBytes) });
      }
    }
    if (turn.state !== 'succeeded' && terminal.has(turn.state)) messages.push({ role: 'assistant', content: JSON.stringify({ kind: 'historical_turn_ended', status: turn.state,
      detail: '本轮已停止。上述工具回执是已确认记录，不代表旧请求仍待执行，不要重复已发生的动作。' }) });
    return messages;
  }
  contextCommitted(turn: AppBrainTurn): boolean {
    if (turn.state === 'succeeded') return true;
    if (!terminal.has(turn.state)) return false;
    const steps = this.steps(turn.eventId), calls = steps.flatMap(step => step.calls);
    return steps.some(step => !!step.assistant) && calls.every(call => call.state === 'committed');
  }
  history(laneId: string): Array<{ turn: AppBrainTurn; messages: AppBrainMessage[] }> {
    const summary = this.summary(laneId);
    const rows = this.db.prepare(`SELECT t.* FROM app_turns t WHERE lane_id=? AND seq>? AND
      (state='succeeded' OR state IN ('failed','cancelled') AND EXISTS(SELECT 1 FROM app_steps s WHERE s.event_id=t.event_id AND s.assistant_json IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM app_calls c WHERE c.event_id=t.event_id AND c.state<>'committed')) ORDER BY seq`).all(laneId, summary.through) as Row[];
    const seenHandoffs = new Set<string>();
    return rows.map(row => { const turn = this.turn(row), promptView = projectAppHistoricalPrompt(turn, seenHandoffs); let messages = this.messages(turn, 3500, false, promptView);
      if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 12000) messages = this.messages(turn, 600, true, promptView);
      if (Buffer.byteLength(JSON.stringify(messages), 'utf8') > 12000) messages = this.messages(turn, 250, 'all', promptView);
      return { turn, messages }; });
  }
  summary(laneId: string): AppBrainSummary { const row = this.db.prepare('SELECT summary_through,summary_text FROM app_lanes WHERE lane_id=?').get(laneId) as Row | undefined; return { through: Number(row?.summary_through ?? 0), text: String(row?.summary_text ?? '') }; }
  saveSummary(laneId: string, expected: number, summary: AppBrainSummary): boolean { return !!this.db.prepare('UPDATE app_lanes SET summary_through=?,summary_text=? WHERE lane_id=? AND summary_through=?').run(summary.through, summary.text, laneId, expected).changes; }
  getHandoff(key: string): string | undefined { const row = this.db.prepare('SELECT value FROM app_handoffs WHERE key=?').get(key) as Row | undefined; return row ? String(row.value) : undefined; }
  putHandoff(key: string, value: string): void { this.db.prepare('INSERT OR IGNORE INTO app_handoffs VALUES(?,?)').run(key, value); }
  close(): void { this.db.close(); }
}
