import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import type { CompanionMessage } from '../shared/companions';
import type { CompanionInterruption } from '../shared/companion-interruption';
import type { CompanionWorkOrder } from '../shared/companion-work-order';
import type { CompanionWorkOrderStore } from './work-order-store';
type Stored = CompanionInterruption & { status: 'active' | 'done' };

/** Durable ownership of temporary work pauses. Human edits always win over automatic restoration. */
export class CompanionInterruptionStore {
  constructor(private db: CompanionConnection, private orders: CompanionWorkOrderStore,
    private visible: (scope: { companionId: string; conversationId: string }, ids: string[]) => CompanionMessage[],
    private urgent: (owner: string, source: string) => boolean,
    private event: (kind: 'social_interrupt' | 'social_resume', owner: string, source: string) => void) {}
  initialize(): void { this.db.exec("CREATE TABLE IF NOT EXISTS companion_focus_interruptions(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,status TEXT NOT NULL,data TEXT NOT NULL); CREATE INDEX IF NOT EXISTS companion_focus_interrupt_owner ON companion_focus_interruptions(companion_id,status)"); }
  private project(value: Stored): CompanionInterruption { return { id: value.id, companionId: value.companionId, sourceMessageId: value.sourceMessageId, orders: value.orders }; }
  private end(id: string): void {
    const saved = this.db.prepare('SELECT data FROM companion_focus_interruptions WHERE id=?').get(id) as { data: string } | undefined;
    if (!saved) return; const interruption = JSON.parse(saved.data) as Stored;
    if (interruption.status !== 'active') return;
    for (const paused of interruption.orders) {
      const found = this.db.prepare('SELECT data FROM companion_work_orders WHERE id=?').get(paused.id) as { data: string } | undefined;
      if (!found) continue; const order = JSON.parse(found.data) as CompanionWorkOrder;
      if (order.status !== 'paused' || order.revision !== paused.revision) continue;
      this.orders.execute({ type: 'work-order.pause', companionId: interruption.companionId, conversationId: paused.conversationId, id: paused.id, expectedRevision: paused.revision, paused: false });
    }
    this.event('social_resume', interruption.companionId, interruption.sourceMessageId);
    interruption.status = 'done'; this.db.prepare("UPDATE companion_focus_interruptions SET status='done',data=? WHERE id=?").run(JSON.stringify(interruption), id);
  }
  execute(input: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (!input.type.startsWith('interruption.')) return undefined;
    return this.db.transaction(() => {
      if (input.type === 'interruption.recover') {
        for (const found of this.db.prepare("SELECT id FROM companion_focus_interruptions WHERE status='active'").all() as { id: string }[]) this.end(found.id);
        return { ok: true };
      }
      if (input.type === 'interruption.end') { this.end(input.id); return { ok: true }; }
      if (input.type !== 'interruption.begin') return undefined;
      const source = this.visible(input, [input.sourceMessageId])[0];
      if (!source || source.status !== 'sent') return { ok: true };
      const verified = source.authorId === 'user' ? this.urgent(input.companionId, source.id)
        : !!this.db.prepare("SELECT 1 FROM companion_social_interruptions WHERE companion_id=? AND source_id=? AND status='active' AND until_real>?").get(input.companionId, source.id, Date.now());
      if (!verified) return { ok: true };
      const existing = this.db.prepare("SELECT data FROM companion_focus_interruptions WHERE companion_id=? AND status='active'").get(input.companionId) as { data: string } | undefined;
      if (existing) { const interruption = JSON.parse(existing.data) as Stored; return interruption.sourceMessageId === source.id ? { ok: true, interruption: this.project(interruption) } : { ok: true }; }
      const interruption: Stored = { id: randomUUID(), companionId: input.companionId, sourceMessageId: source.id, orders: [], status: 'active' };
      for (const found of this.db.prepare("SELECT data FROM companion_work_orders WHERE companion_id=? AND status IN('accepted','running') ORDER BY ordinal LIMIT 100").all(input.companionId) as { data: string }[]) {
        const order = JSON.parse(found.data) as CompanionWorkOrder;
        const paused = this.orders.execute({ type: 'work-order.pause', companionId: input.companionId, conversationId: order.conversationId, id: order.id, expectedRevision: order.revision, paused: true })!.workOrder!;
        interruption.orders.push({ id: paused.id, conversationId: paused.conversationId, revision: paused.revision, ...(paused.actionId ? { actionId: paused.actionId } : {}) });
      }
      this.event('social_interrupt', input.companionId, source.id);
      this.db.prepare("INSERT INTO companion_focus_interruptions VALUES(?,?,'active',?)").run(interruption.id, interruption.companionId, JSON.stringify(interruption));
      return { ok: true, interruption: this.project(interruption) };
    }).immediate();
  }
}
