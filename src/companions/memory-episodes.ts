import { createHash, randomUUID } from 'node:crypto';
import type { CompanionConnection } from './store';

type Capture = { id: string; companion_id: string; conversation_id: string; message_id: string };
type Episode = { id: string; first_at: number; last_at: number; source_count: number; immediate: number; sealed: number };
export const MEMORY_CAPTURE_QUIET_MS = 60_000;
export const MEMORY_CAPTURE_MAX_WAIT_MS = 300_000;
export const MEMORY_CAPTURE_BATCH_SIZE = 12;

/** Durable event windows. Continued traffic never moves the first deadline,
 * and claiming a stable prefix closes its window before newer input arrives. */
export class CompanionMemoryEpisodes {
  constructor(private readonly db: CompanionConnection) {}
  initialize(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS companion_memory_capture_episodes(id TEXT PRIMARY KEY,companion_id TEXT NOT NULL,conversation_id TEXT NOT NULL,topic_key TEXT NOT NULL,first_at INTEGER NOT NULL,last_at INTEGER NOT NULL,source_count INTEGER NOT NULL DEFAULT 0,immediate INTEGER NOT NULL DEFAULT 0,sealed INTEGER NOT NULL DEFAULT 0);
      CREATE INDEX IF NOT EXISTS companion_memory_episode_open ON companion_memory_capture_episodes(companion_id,conversation_id,topic_key,sealed,last_at);
      CREATE TABLE IF NOT EXISTS companion_memory_episode_sources(job_id TEXT PRIMARY KEY REFERENCES vcp_capture_jobs(id) ON DELETE CASCADE,episode_id TEXT NOT NULL REFERENCES companion_memory_capture_episodes(id) ON DELETE CASCADE);
      CREATE INDEX IF NOT EXISTS companion_memory_episode_jobs ON companion_memory_episode_sources(episode_id,job_id);
    `);
  }
  observe(job: Capture, observedAt?: number): Episode {
    const existing = this.db.prepare('SELECT e.* FROM companion_memory_episode_sources s JOIN companion_memory_capture_episodes e ON e.id=s.episode_id WHERE s.job_id=?').get(job.id) as Episode | undefined;
    if (existing) return existing;
    const source = this.db.prepare('SELECT kind,content,created_at,author_id,action_id FROM messages WHERE id=?').get(job.message_id) as { kind: string; content: string; created_at: string; author_id: string; action_id?: string } | undefined;
    if (!source) throw new Error('记忆片段缺少正式来源。');
    const at = observedAt ?? Math.min(Date.now(), Date.parse(source.created_at));
    const topic = this.db.prepare('SELECT topic_id FROM companion_message_topics WHERE message_id=?').get(job.message_id) as { topic_id: string } | undefined;
    const topicKey = createHash('sha256').update(JSON.stringify([job.conversation_id, topic?.topic_id ?? '', source.action_id ?? ''])).digest('hex');
    // These hints accelerate encoding, never discard or classify a fact. The
    // model still decides value and verifies identity against the actual author.
    const immediate = source.kind === 'action' || !!source.action_id || source.author_id === 'system'
      || source.author_id === 'user' && /(?:我叫|我的名字是|请叫我|叫我|请记住|记住这|更正一下|之前说错|纠正一下)/u.test(source.content);
    let episode = this.db.prepare(`SELECT * FROM companion_memory_capture_episodes WHERE companion_id=? AND conversation_id=? AND topic_key=? AND sealed=0
      AND last_at>? AND first_at>? AND source_count<? ORDER BY rowid DESC LIMIT 1`)
      .get(job.companion_id, job.conversation_id, topicKey, at - MEMORY_CAPTURE_QUIET_MS, at - MEMORY_CAPTURE_MAX_WAIT_MS, MEMORY_CAPTURE_BATCH_SIZE) as Episode | undefined;
    if (!episode) {
      const id = 'episode_' + randomUUID().replaceAll('-', '');
      this.db.prepare('INSERT INTO companion_memory_capture_episodes(id,companion_id,conversation_id,topic_key,first_at,last_at) VALUES(?,?,?,?,?,?)')
        .run(id, job.companion_id, job.conversation_id, topicKey, at, at);
      episode = { id, first_at: at, last_at: at, source_count: 0, immediate: 0, sealed: 0 };
    }
    this.db.prepare('INSERT INTO companion_memory_episode_sources VALUES(?,?)').run(job.id, episode.id);
    this.db.prepare('UPDATE companion_memory_capture_episodes SET last_at=MAX(last_at,?),source_count=source_count+1,immediate=MAX(immediate,?) WHERE id=?')
      .run(at, Number(immediate), episode.id);
    return { ...episode, last_at: Math.max(episode.last_at, at), source_count: episode.source_count + 1, immediate: Number(immediate || episode.immediate) };
  }
  due(episode: Episode): number {
    return episode.sealed || episode.immediate || episode.source_count >= MEMORY_CAPTURE_BATCH_SIZE ? episode.first_at
      : Math.min(episode.first_at + MEMORY_CAPTURE_MAX_WAIT_MS, episode.last_at + MEMORY_CAPTURE_QUIET_MS);
  }
  seal(id: string): void { this.db.prepare('UPDATE companion_memory_capture_episodes SET sealed=1 WHERE id=?').run(id); }
  nextAt(owner: string): number | undefined {
    const value = this.db.prepare(`SELECT MIN(MAX(j.next_attempt,CASE WHEN e.sealed=1 OR e.immediate=1 OR e.source_count>=? THEN e.first_at ELSE MIN(e.first_at+?,e.last_at+?) END)) AS at
      FROM vcp_capture_jobs j JOIN companion_memory_episode_sources s ON s.job_id=j.id JOIN companion_memory_capture_episodes e ON e.id=s.episode_id
      WHERE j.companion_id=? AND j.status IN('pending','failed') AND j.attempts<8`)
      .get(MEMORY_CAPTURE_BATCH_SIZE, MEMORY_CAPTURE_MAX_WAIT_MS, MEMORY_CAPTURE_QUIET_MS, owner) as { at?: number };
    return value.at ?? undefined;
  }
  /** Management projection is pure: polling never seals or backfills episodes. */
  eligibility(owner: string, now = Date.now()): { eligible: number; nextAt?: string } {
    const result = this.db.prepare(`WITH due AS (
      SELECT MAX(j.next_attempt,CASE
        WHEN EXISTS(SELECT 1 FROM metadata r WHERE r.key='vcp-capture-reconsideration/'||j.companion_id||'/'||j.id) THEN 0
        WHEN e.id IS NOT NULL THEN CASE WHEN e.sealed=1 OR e.immediate=1 OR e.source_count>=? THEN e.first_at ELSE MIN(e.first_at+?,e.last_at+?) END
        WHEN m.kind='action' OR m.action_id IS NOT NULL OR m.author_id='system' THEN CAST(unixepoch(m.created_at,'subsec')*1000 AS INTEGER)
        ELSE CAST(unixepoch(m.created_at,'subsec')*1000 AS INTEGER)+? END) AS at
      FROM vcp_capture_jobs j JOIN companions c ON c.id=j.companion_id JOIN messages m ON m.id=j.message_id
      LEFT JOIN companion_memory_episode_sources s ON s.job_id=j.id LEFT JOIN companion_memory_capture_episodes e ON e.id=s.episode_id
      WHERE j.companion_id=? AND j.status IN('pending','failed') AND j.attempts<8 AND c.deleted_at IS NULL AND json_extract(c.data,'$.active')=1
        AND NOT EXISTS(SELECT 1 FROM companion_reset_jobs r WHERE r.companion_id=j.companion_id AND r.status!='completed')
    ) SELECT COALESCE(SUM(at<=?),0) AS eligible,MIN(at) AS next_at FROM due`)
      .get(MEMORY_CAPTURE_BATCH_SIZE, MEMORY_CAPTURE_MAX_WAIT_MS, MEMORY_CAPTURE_QUIET_MS, MEMORY_CAPTURE_QUIET_MS, owner, now) as { eligible: number; next_at: number | null };
    return { eligible: Number(result.eligible), ...(result.next_at !== null ? { nextAt: new Date(result.next_at).toISOString() } : {}) };
  }
}
