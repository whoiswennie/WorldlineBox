import { randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';

type Row = Record<string, unknown>;
const norm = (value: unknown) => String(value ?? '').normalize('NFKC').toLocaleLowerCase();
const decode = <T>(value: unknown, fallback: T): T => {
  try { return JSON.parse(String(value)) as T; } catch { return fallback; }
};
const retiredTables = [
  'memory_search', 'memory_dependencies', 'memory_relations', 'memory_tag_links', 'memory_sources',
  'memory_records', 'memory_tags', 'memory_jobs', 'memory_operations', 'memory_forget_rules',
  'memory_source_blocks', 'memory_observers', 'companion_reset_memories', 'companion_reset_invalidations', 'memories',
] as const;

/** One-way authorization migration. Old facts never become VCP notes or a fallback engine. */
export function retireFactMemory(db: CompanionConnection): void {
  db.transaction(() => {
    const marker = 'vcp-memory-replacement/authorization-v1';
    if (db.prepare('SELECT 1 FROM metadata WHERE key=?').get(marker)) return;
    const exists = (table: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
    const legacy = exists('memories') || exists('memory_forget_rules') || exists('memory_observers');
    if (legacy) {
      db.prepare('INSERT OR IGNORE INTO metadata(key,value) VALUES(?,?)').run('vcp-memory-replacement/retired-fact-events', 'pending');
      db.prepare("UPDATE metadata SET value='0' WHERE key='vcp-capture-backfill-through'").run();
      db.prepare("UPDATE metadata SET value=(SELECT CAST(COALESCE(MAX(sequence),0) AS TEXT) FROM messages) WHERE key='vcp-capture-backfill-target'").run();
    }
    if (exists('memory_observers')) db.exec(`INSERT OR IGNORE INTO vcp_source_observers
      SELECT o.message_id,o.companion_id FROM memory_observers o JOIN messages m ON m.id=o.message_id JOIN companions c ON c.id=o.companion_id`);
    if (exists('memory_source_blocks')) db.exec(`INSERT OR IGNORE INTO vcp_source_blocks
      SELECT b.message_id,b.companion_id,b.created_at FROM memory_source_blocks b JOIN messages m ON m.id=b.message_id JOIN companions c ON c.id=b.companion_id`);

    const memories = exists('memories') ? db.prepare('SELECT id,companion_id,data FROM memories').all() as Row[] : [];
    const sources = exists('memory_sources') ? db.prepare('SELECT memory_id,message_id FROM memory_sources').all() as Row[] : [];
    const byMemory = new Map<string, string[]>();
    for (const source of sources) {
      const ids = byMemory.get(String(source.memory_id)) ?? [];
      ids.push(String(source.message_id)); byMemory.set(String(source.memory_id), ids);
    }
    const block = db.prepare('INSERT OR IGNORE INTO vcp_source_blocks(message_id,companion_id,created_at) SELECT id,?,? FROM messages WHERE id=?');
    const blockedAt = new Date().toISOString();
    const blockSources = (owner: string, ids: string[]) => {
      if (!db.prepare('SELECT 1 FROM companions WHERE id=?').get(owner)) return;
      for (const id of new Set(ids)) block.run(owner, blockedAt, id);
    };
    const records = memories.map(entry => {
      const data = decode<Record<string, unknown>>(entry.data, {});
      const refs = decode<Array<{ messageId?: string }>>(JSON.stringify(data.sources ?? []), []);
      const ids = [...(byMemory.get(String(entry.id)) ?? []), ...refs.flatMap(ref => typeof ref.messageId === 'string' ? [ref.messageId] : [])];
      if (typeof data.sourceMessageId === 'string') ids.push(data.sourceMessageId);
      if (data.status === 'forgotten') blockSources(String(entry.companion_id), ids);
      return { id: String(entry.id), owner: String(entry.companion_id), data, ids };
    });
    if (exists('memory_forget_rules')) for (const rule of db.prepare('SELECT * FROM memory_forget_rules').all() as Row[]) {
      const owner = String(rule.companion_id), conversation = rule.conversation_id ? String(rule.conversation_id) : '*';
      const migratedTags: string[] = [];
      blockSources(owner, decode<string[]>(rule.source_message_ids, []));
      for (const note of records) {
        if (note.owner !== owner || conversation !== '*' && note.data.sourceConversationId !== conversation
          || !rule.persistent && Number(note.data.sourceSequence ?? 0) > Number(rule.through_sequence)) continue;
        const tags = (Array.isArray(note.data.tags) ? note.data.tags : []) as Array<{ name?: string; aliases?: string[] }>;
        const selected = rule.memory_id === note.id || !!(rule.subject || rule.fact_key || rule.tag)
          && (!rule.subject || norm(rule.subject) === norm(note.data.subject))
          && (!rule.fact_key || norm(rule.fact_key) === norm(note.data.factKey))
          && (!rule.tag || tags.some(tag => [tag.name, ...(tag.aliases ?? [])].some(name => norm(name) === norm(rule.tag))));
        if (selected) blockSources(owner, note.ids);
      }
      if (rule.tag) {
        const aliases = new Set([String(rule.tag)]);
        if (exists('memory_tags')) for (const tag of db.prepare('SELECT name,aliases FROM memory_tags WHERE companion_id=?').all(owner) as Row[]) {
          const names = [String(tag.name), ...decode<string[]>(tag.aliases, [])];
          if (names.some(name => norm(name) === norm(rule.tag))) names.forEach(name => aliases.add(name));
        }
        for (const tag of aliases) {
          const id = randomUUID(); migratedTags.push(id);
          db.prepare('INSERT INTO vcp_source_prohibitions VALUES(?,?,?,?,?,?)')
            .run(id, owner, conversation, tag, Number(rule.through_sequence), Number(rule.persistent));
          if (rule.request_message_id && db.prepare('SELECT 1 FROM messages WHERE id=?').get(rule.request_message_id))
            db.prepare('INSERT INTO vcp_source_prohibition_requests VALUES(?,?)').run(id, rule.request_message_id);
        }
      }
      if (rule.persistent && (rule.subject || rule.fact_key)) {
        const request = rule.request_message_id ? db.prepare('SELECT content FROM messages WHERE id=?').get(rule.request_message_id) as Row | undefined : undefined;
        db.prepare('INSERT INTO vcp_source_policy_holds VALUES(?,?,?,?,?,?,NULL)').run(
          String(rule.id), owner, conversation, rule.request_message_id ?? null,
          request ? String(request.content).slice(0, 600) : '旧版存在持续遗忘要求，无法自动转换为日记标签。', blockedAt);
        for (const id of migratedTags) db.prepare('INSERT INTO vcp_source_policy_tags VALUES(?,?)').run(rule.id, id);
      }
    }
    // Reset/publication boundaries and their metadata already belong to the host and remain intact.
    if (legacy && exists('companion_reset_jobs')) for (const entry of db.prepare("SELECT companion_id,phase,data FROM companion_reset_jobs WHERE status!='completed'").all() as Row[]) {
      const job = decode<Record<string, unknown>>(entry.data, {});
      job.phase = entry.phase === 'stopping' ? 'stopping' : 'rooms';
      const progress = typeof job.progress === 'object' && job.progress !== null ? job.progress as Record<string, unknown> : {};
      job.progress = { ...progress, step: 0, roomAfter: '', messageAfter: 0, refs: 0 };
      db.prepare('UPDATE companion_reset_jobs SET phase=?,data=? WHERE companion_id=?').run(job.phase, JSON.stringify(job), entry.companion_id);
    }
    for (const table of retiredTables) if (exists(table)) db.exec(`DROP TABLE "${table}"`);
    db.prepare("DELETE FROM metadata WHERE key IN('memory-backfill-through','memory-backfill-target') OR key GLOB 'memory-atom-change/*'").run();
    db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(marker, blockedAt);
  }).immediate();
}
