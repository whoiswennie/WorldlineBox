import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { CompanionConnection } from './store';
import { companionMessagePublicationCanonicalJSON as canonical, companionPublishedActionFrontierSchema,
  type CompanionMessagePublicationCertificate, type CompanionPublishedActionFrontier } from '../shared/companion-message-publication';

const certificateHash = (value: CompanionMessagePublicationCertificate) => createHash('sha256').update(canonical(value)).digest('hex');
const ordered = (values: readonly CompanionPublishedActionFrontier[]) => [...values].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
export function initializePublishedMessageActionPins(db: CompanionConnection): void {
  db.exec(`CREATE TABLE IF NOT EXISTS companion_message_publication_action_pins(message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    certificate_hash TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(message_id,certificate_hash))`);
}
/** A pin is the exact action obligation that the successful Main frame
 * consumed. It cannot be inferred later from a newer mutable action row. */
export function readPublishedMessageActionPins(db: CompanionConnection, certificate: CompanionMessagePublicationCertificate): CompanionPublishedActionFrontier[] | undefined {
  const row = db.prepare('SELECT data FROM companion_message_publication_action_pins WHERE message_id=? AND certificate_hash=?')
    .get(certificate.messageId, certificateHash(certificate)) as { data: string } | undefined;
  if (!row) return;
  try {
    const values = companionPublishedActionFrontierSchema.array().max(10000).parse(JSON.parse(row.data));
    if (new Set(values.map(value => value.id)).size !== values.length) return;
    return ordered(values);
  } catch { return; }
}
/** Called only by the private certification transaction after it freshly
 * matched the supplied Main headers to this root's actual dependency subset. */
export function recordPublishedMessageActionPins(db: CompanionConnection, certificate: CompanionMessagePublicationCertificate,
  values: readonly CompanionPublishedActionFrontier[]): boolean {
  const existing = db.prepare('SELECT 1 FROM companion_message_publication_action_pins WHERE message_id=? AND certificate_hash=?')
    .get(certificate.messageId, certificateHash(certificate));
  const expected = ordered(values);
  if (existing) return isDeepStrictEqual(readPublishedMessageActionPins(db, certificate), expected);
  db.prepare('INSERT INTO companion_message_publication_action_pins VALUES(?,?,?)').run(certificate.messageId, certificateHash(certificate), canonical(expected));
  return true;
}
