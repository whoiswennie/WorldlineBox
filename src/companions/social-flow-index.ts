import type { CompanionConnection } from './store';

type Row = Record<string, string | number | null>;
const kinds = "'visit_request','visit_response','scene_depart','scene_enter','travel_blocked','visit_leave','social_interrupt','social_resume'";
const visibleWorld = `json_extract(data,'$.kind') IN(${kinds}) AND json_extract(data,'$.privateOwner') IS NULL AND COALESCE(json_extract(data,'$.withdrawn'),0)=0`;
/** Keep tombstoned topic content out of every observer projection, including indexed branches. */
export const visibleSocialTopic = (messageId: string): string => `NOT EXISTS(SELECT 1 FROM companion_message_topics association JOIN companion_topics topic ON topic.id=association.topic_id WHERE association.message_id=${messageId} AND json_extract(topic.data,'$.deletedAt') IS NOT NULL)`;

/** A rebuildable disk index of actual audiences, never model memory or a second message authority. */
export function initializeSocialFlowIndex(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_social_audience(
    companion_id TEXT NOT NULL,message_id TEXT NOT NULL REFERENCES companion_social_messages(message_id) ON DELETE CASCADE,
    conversation_id TEXT NOT NULL,virtual_at TEXT NOT NULL,PRIMARY KEY(companion_id,message_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS companion_social_audience_time ON companion_social_audience(companion_id,virtual_at DESC,message_id DESC,conversation_id);
    CREATE INDEX IF NOT EXISTS companion_social_audience_message ON companion_social_audience(message_id);
    CREATE TRIGGER IF NOT EXISTS companion_social_audience_insert AFTER INSERT ON companion_social_messages BEGIN
      INSERT OR IGNORE INTO companion_social_audience SELECT author_id,NEW.message_id,NEW.conversation_id,NEW.virtual_at FROM messages WHERE id=NEW.message_id;
      INSERT OR IGNORE INTO companion_social_audience SELECT value,NEW.message_id,NEW.conversation_id,NEW.virtual_at FROM json_each(NEW.recipient_ids);
    END;
    CREATE TRIGGER IF NOT EXISTS companion_social_audience_update AFTER UPDATE OF virtual_at,recipient_ids,conversation_id ON companion_social_messages BEGIN
      DELETE FROM companion_social_audience WHERE message_id=OLD.message_id;
      INSERT OR IGNORE INTO companion_social_audience SELECT author_id,NEW.message_id,NEW.conversation_id,NEW.virtual_at FROM messages WHERE id=NEW.message_id;
      INSERT OR IGNORE INTO companion_social_audience SELECT value,NEW.message_id,NEW.conversation_id,NEW.virtual_at FROM json_each(NEW.recipient_ids);
    END;
    CREATE TRIGGER IF NOT EXISTS companion_social_audience_delete AFTER DELETE ON companion_social_messages BEGIN
      DELETE FROM companion_social_audience WHERE message_id=OLD.message_id;
    END;
    CREATE INDEX IF NOT EXISTS companion_world_observer_actor_recent ON companion_world_events(json_extract(data,'$.actorId'),json_extract(data,'$.at') DESC,id DESC) WHERE ${visibleWorld};
    CREATE INDEX IF NOT EXISTS companion_world_observer_target_recent ON companion_world_events(json_extract(data,'$.targetId'),json_extract(data,'$.at') DESC,id DESC) WHERE ${visibleWorld};
    CREATE INDEX IF NOT EXISTS companion_social_job_room_status ON companion_social_jobs(conversation_id,status);
    CREATE INDEX IF NOT EXISTS companion_social_outbox_room_status ON companion_social_outbox(conversation_id,status);
    CREATE INDEX IF NOT EXISTS companion_world_visit_guest_recent ON companion_world_visit_records(guest_id,json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS companion_world_visit_host_recent ON companion_world_visit_records(host_id,json_extract(data,'$.createdAt') DESC,id DESC);
    CREATE INDEX IF NOT EXISTS companion_world_visit_pair ON companion_world_visit_records(guest_id,host_id);
    CREATE TABLE IF NOT EXISTS companion_social_visit_contacts(guest_id TEXT NOT NULL,host_id TEXT NOT NULL,PRIMARY KEY(guest_id,host_id)) WITHOUT ROWID;
    CREATE INDEX IF NOT EXISTS companion_social_visit_contacts_host ON companion_social_visit_contacts(host_id,guest_id);
    CREATE TRIGGER IF NOT EXISTS companion_social_visit_contact_insert AFTER INSERT ON companion_world_visit_records BEGIN
      INSERT OR IGNORE INTO companion_social_visit_contacts VALUES(NEW.guest_id,NEW.host_id);
    END;
    CREATE TRIGGER IF NOT EXISTS companion_social_visit_contact_delete AFTER DELETE ON companion_world_visit_records BEGIN
      DELETE FROM companion_social_visit_contacts WHERE guest_id=OLD.guest_id AND host_id=OLD.host_id AND NOT EXISTS(SELECT 1 FROM companion_world_visit_records WHERE guest_id=OLD.guest_id AND host_id=OLD.host_id);
    END;`);
  if (!db.prepare("SELECT 1 FROM metadata WHERE key='social-audience-index-v1'").get()) db.transaction(() => {
    db.exec(`INSERT OR IGNORE INTO companion_social_audience SELECT m.author_id,s.message_id,s.conversation_id,s.virtual_at FROM companion_social_messages s JOIN messages m ON m.id=s.message_id;
      INSERT OR IGNORE INTO companion_social_audience SELECT j.value,s.message_id,s.conversation_id,s.virtual_at FROM companion_social_messages s,json_each(s.recipient_ids) j;
      INSERT INTO metadata(key,value) VALUES('social-audience-index-v1','1');`);
  }).immediate();
  if (!db.prepare("SELECT 1 FROM metadata WHERE key='social-visit-contacts-v1'").get()) db.transaction(() => {
    db.exec(`INSERT OR IGNORE INTO companion_social_visit_contacts SELECT guest_id,host_id FROM companion_world_visit_records;
      INSERT INTO metadata(key,value) VALUES('social-visit-contacts-v1','1');`);
  }).immediate();
}

const validRoom = `EXISTS(SELECT 1 FROM conversations c JOIN conversation_members cm ON cm.conversation_id=c.id WHERE c.id=a.conversation_id AND c.dissolved_at IS NULL AND cm.companion_id=a.companion_id)
  AND NOT EXISTS(SELECT 1 FROM conversation_members bad JOIN companions p ON p.id=bad.companion_id WHERE bad.conversation_id=a.conversation_id AND (p.deleted_at IS NOT NULL OR EXISTS(SELECT 1 FROM companion_reset_jobs j WHERE j.companion_id=p.id AND j.status!='completed')))`;

/** Each ordered branch stops at K rows, so the final merge is bounded independently of audit age. */
export function recentSocialFacts(db: CompanionConnection, owner: string, now: string, limit: number): Row[] {
  const worldBranch = (field: 'actorId' | 'targetId', index: string) => `SELECT * FROM(SELECT 'w' AS source,id,json_extract(data,'$.at') AS at FROM companion_world_events INDEXED BY ${index}
    WHERE json_extract(data,'$.${field}')=? AND ${visibleWorld} AND json_extract(data,'$.at')<=? ORDER BY json_extract(data,'$.at') DESC,id DESC LIMIT ?)`;
  return db.prepare(`SELECT * FROM(
    SELECT * FROM(SELECT 'm' AS source,a.message_id AS id,a.virtual_at AS at FROM companion_social_audience a INDEXED BY companion_social_audience_time JOIN messages m ON m.id=a.message_id
      WHERE a.companion_id=? AND a.virtual_at<=? AND m.status='sent' AND ${validRoom} AND ${visibleSocialTopic('m.id')} ORDER BY a.virtual_at DESC,a.message_id DESC LIMIT ?)
    UNION ${worldBranch('actorId', 'companion_world_observer_actor_recent')}
    UNION ${worldBranch('targetId', 'companion_world_observer_target_recent')}
  ) ORDER BY at DESC,id DESC LIMIT ?`).all(owner, now, limit, owner, now, limit, owner, now, limit, limit) as Row[];
}

export function recentSocialMessageCounts(db: CompanionConnection, owner: string, now: string): Row[] {
  return db.prepare(`SELECT m.author_id,s.recipient_ids,s.channel,s.virtual_at FROM companion_social_audience a INDEXED BY companion_social_audience_time
    JOIN companion_social_messages s ON s.message_id=a.message_id JOIN messages m ON m.id=a.message_id
    WHERE a.companion_id=? AND a.virtual_at<=? AND m.status='sent' AND ${validRoom} AND ${visibleSocialTopic('m.id')}
    ORDER BY a.virtual_at DESC,a.message_id DESC LIMIT 1000`).all(owner, now) as Row[];
}
