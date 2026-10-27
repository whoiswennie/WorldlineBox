import type { CompanionConnection } from './store';
import type { CompanionStorageCommand, CompanionStorageResponse } from '../shared/companion-storage';
import { companionDshMailSchema } from '../shared/companion-dsh-background';

/** Task communication is a separate durable ledger, never a chat or memory source. */
export class CompanionDshMailboxStore {
  constructor(private readonly db: CompanionConnection) {
    db.exec(`CREATE TABLE IF NOT EXISTS companion_dsh_mailbox (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id TEXT NOT NULL REFERENCES actions(id) ON DELETE CASCADE,
      deduplication_key TEXT NOT NULL, data TEXT NOT NULL,
      UNIQUE(action_id,deduplication_key)
    ); CREATE INDEX IF NOT EXISTS companion_dsh_mailbox_action ON companion_dsh_mailbox(action_id,sequence)`);
  }
  execute(command: CompanionStorageCommand): CompanionStorageResponse | undefined {
    if (command.type === 'action.mail.append') return this.db.transaction(() => {
      const action = this.db.prepare('SELECT id FROM actions WHERE id=?').get(command.mail.actionId);
      if (!action) throw new Error('后台任务已不存在，不能投递消息。');
      const prior = this.db.prepare('SELECT data FROM companion_dsh_mailbox WHERE action_id=? AND deduplication_key=?')
        .get(command.mail.actionId, command.mail.deduplicationKey) as { data: string } | undefined;
      if (prior) {
        const saved = JSON.parse(prior.data);
        if (Object.entries(command.mail).some(([key, value]) => saved[key] !== value)) throw new Error('同一后台消息标识不能替换正文或方向。');
        return { ok: true };
      }
      const mail = { ...command.mail, createdAt: new Date().toISOString() };
      this.db.prepare('INSERT INTO companion_dsh_mailbox(action_id,deduplication_key,data) VALUES(?,?,?)')
        .run(mail.actionId, mail.deduplicationKey, JSON.stringify(mail));
      return { ok: true };
    }).immediate();
    if (command.type !== 'action.mail.read') return;
    for (const id of command.actionIds) {
      const action = this.db.prepare('SELECT data FROM actions WHERE id=?').get(id) as { data: string } | undefined;
      const value = action && JSON.parse(action.data);
      if (!value || value.companionId !== command.companionId || value.conversationId !== command.conversationId
        || value.parentMessageId !== command.parentMessageId || value.thought) throw new Error('后台邮箱不属于当前伙伴和任务入口。');
    }
    const rows = this.db.prepare(`SELECT sequence,data FROM companion_dsh_mailbox WHERE action_id IN(${command.actionIds.map(() => '?').join(',')}) AND sequence>? ORDER BY sequence LIMIT 51`)
      .all(...command.actionIds, command.after ?? 0) as Array<{ sequence: number; data: string }>;
    const items = []; let chars = 0;
    for (const row of rows.slice(0, 50)) {
      if (items.length && chars + row.data.length > 20000) break;
      items.push(companionDshMailSchema.parse({ ...JSON.parse(row.data), sequence: row.sequence })); chars += row.data.length;
    }
    return { ok: true, dshMailbox: { items, nextAfter: items.at(-1)?.sequence ?? command.after ?? 0, hasMore: rows.length > items.length } };
  }
}
