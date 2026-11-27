import { createHash } from 'node:crypto';
import type { BotTaskSql } from './store';

export const legacyEvidenceRetirementKey = 'vcp-v5-retired-evidence-removed';
type LegacyInput = { key: string; value: string; companion_id: string; conversation_id: string; old_lane: string | null; submitted: number };

function parseObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch {
    /* Unrecognized historic payloads do not prove an old diary was sent. */
  }
}

function legacyDiaryBody(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim()) return false;
  let packet;
  try {
    packet = JSON.parse(value);
  } catch {
    return true;
  } // The earliest envelopes carried a plain-text excerpt.
  if (packet?.kind !== 'passive-memory-evidence' || !Array.isArray(packet.items)) return false;
  return packet.items.some((item: { text?: string; origin?: string; referenceOnly?: boolean }) => {
    if (!item || item.referenceOnly || typeof item.text !== 'string' || !item.text.trim()) return false;
    if (item.origin === 'vcp-system-fallback') {
      // Unknown unclassified system instructions alone do not retire a topic.
      return /<!-- VCP_RAG_BLOCK_START/u.test(item.text) && !/没有找到直接相关的记忆片段/u.test(item.text);
    }
    return item.origin === 'vcp-rag-result' || item.origin === 'vcp-onering-history';
  });
}

/** A VCP v4 evidence envelope already admitted to a DSH transcript cannot be
 * removed by changing the current prompt. Preserve event-to-lane identity for
 * reconciliation, while binding subsequent turns of just this owner/topic to
 * a fresh native Session. Runs once inside the store's upgrade transaction. */
export function retireLegacyMemorySessions(db: BotTaskSql & { exec(sql: string): void }) {
  db.exec(`CREATE TABLE IF NOT EXISTS bot_retired_memory_lanes(native_lane_id TEXT PRIMARY KEY,replacement_lane_id TEXT NOT NULL UNIQUE,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS bot_retired_memory_lane_owner ON bot_retired_memory_lanes(companion_id);
    CREATE INDEX IF NOT EXISTS bot_stale_session_lanes ON bot_lanes(companion_id,epoch) WHERE epoch>1;
    CREATE INDEX IF NOT EXISTS bot_topic_session_scope ON bot_topic_bindings(conversation_id,companion_id,lane_epoch);
    CREATE TABLE IF NOT EXISTS bot_retired_memory_events(event_id TEXT PRIMARY KEY REFERENCES bot_inbox(id) ON DELETE CASCADE,native_lane_id TEXT NOT NULL REFERENCES bot_retired_memory_lanes(native_lane_id) ON DELETE CASCADE);
    CREATE INDEX IF NOT EXISTS bot_retired_memory_event_lane ON bot_retired_memory_events(native_lane_id);`);
  const sent = `(i.dsh_event_id IS NOT NULL OR (m.key IS NOT NULL AND COALESCE(d.value,'unknown')<>'unsent' AND COALESCE(c.value,'unknown')<>'0'))`;
  const scope = `LEFT JOIN bot_topic_events t ON t.event_id=i.id LEFT JOIN bot_topic_bindings b ON b.topic_id=t.topic_id AND b.companion_id=i.companion_id
    LEFT JOIN bot_metadata d ON d.key='native-dispatch:'||i.id LEFT JOIN bot_metadata c ON c.key='native-input-committed:'||i.id`;
  const inputs =
    db.prepare(`SELECT m.key,m.value,i.conversation_id,i.companion_id,COALESCE(retired.native_lane_id,b.native_lane_id,'turn-'||i.id) AS old_lane,${sent} AS submitted
    FROM bot_metadata m LEFT JOIN bot_inbox i ON i.id=substr(m.key,14) ${scope}
    LEFT JOIN bot_retired_memory_events retired ON retired.event_id=i.id
    WHERE m.key GLOB 'native-input:*' AND m.key>? AND instr(m.value,'memoryEvidence')>0 ORDER BY m.key LIMIT 32`);
  const archive = db.prepare('INSERT OR IGNORE INTO bot_retired_memory_lanes VALUES(?,?,?,?)');
  const sanitize = db.prepare('UPDATE bot_metadata SET value=? WHERE key=?');
  let cursor = '';
  for (;;) {
    const page = inputs.all(cursor) as LegacyInput[];
    if (!page.length) break;
    for (const row of page) {
      const envelope = parseObject(row.value);
      if (typeof envelope?.prompt !== 'string') continue;
      const prompt = parseObject(envelope.prompt);
      if (!prompt || !Object.hasOwn(prompt, 'memoryEvidence')) continue;
      if (row.submitted && row.old_lane && legacyDiaryBody(prompt.memoryEvidence)) {
        const fresh = 'topic-vcp5-' + createHash('sha256').update(row.old_lane).digest('hex');
        archive.run(row.old_lane, fresh, row.companion_id, row.conversation_id);
      }
      // A retired event keeps its lane identity as proof. Its frozen copy of
      // the obsolete diary text is no longer needed, even after dispatch.
      delete prompt.memoryEvidence;
      sanitize.run(JSON.stringify({ ...envelope, prompt: JSON.stringify(prompt) }), row.key);
    }
    cursor = page.at(-1)!.key;
  }
  if (db.prepare('SELECT 1 FROM bot_retired_memory_lanes LIMIT 1').get()) db.exec(`INSERT OR IGNORE INTO bot_retired_memory_events(event_id,native_lane_id)
    SELECT i.id,old.native_lane_id FROM bot_inbox i LEFT JOIN bot_metadata m ON m.key='native-input:'||i.id ${scope}
    JOIN bot_retired_memory_lanes old ON old.native_lane_id=COALESCE(b.native_lane_id,'turn-'||i.id) WHERE ${sent};
    UPDATE bot_topic_bindings SET native_lane_id=(SELECT replacement_lane_id FROM bot_retired_memory_lanes old WHERE old.native_lane_id=bot_topic_bindings.native_lane_id)
    WHERE native_lane_id IN (SELECT native_lane_id FROM bot_retired_memory_lanes);
    DELETE FROM bot_topic_title_sync WHERE native_lane_id IN (SELECT native_lane_id FROM bot_retired_memory_lanes);`);
  db.prepare('INSERT OR REPLACE INTO bot_metadata(key,value) VALUES(?,?)').run(legacyEvidenceRetirementKey, '1');
}
