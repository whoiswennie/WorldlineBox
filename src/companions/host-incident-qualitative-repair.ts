import { readFileSync } from 'node:fs';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { z } from 'zod';
import { companionCurrentExperienceSchema, companionRelationshipRecordSchema } from '../shared/companion-current-experience';
import { companionStateChangeSchema } from '../shared/companion-state-change';
import { companionMemorySchema } from '../shared/companion-memory';
import { companionArtifactPathSchema } from '../shared/companion-artifact';
import { hostIncidentRepairFile, hostIncidentRepairSHA as sha, hostIncidentRepairStateSHA } from './host-incident-repair';
import { inspectCompanionFencedMaintenance, openCompanionFencedMaintenance } from './fenced-maintenance';
import { CompanionMemoryStore } from './memory-store';
import type { CompanionConnection } from './store';
import type { CompanionRecoveryHead, CompanionRecoverySelection } from './recovery-fence';

const hash = z.string().regex(/^[a-f0-9]{64}$/u), id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/u);
const head = z.strictObject({ lineageId: id, generation: z.number().int().nonnegative().safe() });
export const companionHostQualitativeRepairManifestSchema = z.strictObject({
  schema: z.literal('worldlinebox.host-shutdown-qualitative-flags-v1'), operationId: id, libraryId: id, initialHead: head,
  beforeStateSHA: hash, incidentFrom: z.iso.datetime(), incidentUntil: z.iso.datetime(),
  parentRepair: z.strictObject({ operationId: id, manifestSHA: hash, receiptSHA: hash, afterHead: head }),
  flags: z.array(z.strictObject({ kind: z.enum(['experience', 'relationship', 'state_change']), id: z.string().min(1).max(200), owner: id, dataSHA: hash })).length(10),
  canonicalFiles: z.array(z.strictObject({ owner: id, relativePath: companionArtifactPathSchema, sha256: hash, size: z.number().int().nonnegative().safe() })).min(1).max(10000),
}).superRefine((value, context) => {
  if (value.flags.filter(flag => flag.kind === 'experience').length !== 1 || value.flags.filter(flag => flag.kind === 'relationship').length !== 2
    || value.flags.filter(flag => flag.kind === 'state_change').length !== 7 || new Set(value.flags.map(flag => `${flag.kind}:${flag.id}`)).size !== 10
    || value.operationId === value.parentRepair.operationId || value.incidentFrom > value.incidentUntil) context.addIssue({ code: 'custom', message: '定性修复只接受固定的十项事故标志。' });
});
export type CompanionHostQualitativeRepairManifest = z.infer<typeof companionHostQualitativeRepairManifestSchema>;
const tables = { experience: 'companion_current_experiences', relationship: 'companion_relationship_records', state_change: 'companion_state_changes' } as const;
const key = (operation: string) => `host-incident-repair/${operation}`;
const sameHead = (a: CompanionRecoveryHead, b: CompanionRecoveryHead) => a.lineageId === b.lineageId && a.generation === b.generation;
const get = <T>(db: CompanionConnection, sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as T | undefined;
type Row = { id: string; companion_id: string; active: number; data: string };
type Source = { messageId: string; revision: number; checksum: string };
type Link = { note_id: string; note_version: number };
type Receipt = { manifestSHA: string; parentManifestSHA: string; phase: 'completed'; initialHead: CompanionRecoveryHead; afterHead: CompanionRecoveryHead; postStateSHA: string };

function files(db: CompanionConnection, manifest: CompanionHostQualitativeRepairManifest, ownersRoot: string): void {
  for (const file of manifest.canonicalFiles) {
    const bytes = readFileSync(hostIncidentRepairFile(ownersRoot, file.owner, file.relativePath));
    if (bytes.length !== file.size || sha(bytes) !== file.sha256) throw new Error('定性修复的真实来源或当前人格文件已变化。');
  }
  const committed = db.prepare("SELECT owner_id,relative_path,content_hash FROM companion_artifacts WHERE state='committed' AND kind!='runtime_index'").all() as Array<{ owner_id: string; relative_path: string; content_hash: string }>;
  if (committed.some(item => !manifest.canonicalFiles.some(file => file.owner === item.owner_id && file.relativePath === item.relative_path && file.sha256 === item.content_hash))) throw new Error('定性修复缺少完整当前文件与人格材料。');
}
function parent(db: CompanionConnection, manifest: CompanionHostQualitativeRepairManifest, expectedActive: 0 | 1): void {
  const raw = get<{ value: string }>(db, 'SELECT value FROM metadata WHERE key=?', key(manifest.parentRepair.operationId))?.value;
  if (!raw || sha(raw) !== manifest.parentRepair.receiptSHA) throw new Error('定性修复的已完成正文修复凭据变化。');
  const receipt = JSON.parse(raw) as { phase: string; manifestSHA: string; afterHead: CompanionRecoveryHead; postStateSHA: string };
  if (receipt.phase !== 'completed' || receipt.manifestSHA !== manifest.parentRepair.manifestSHA || !sameHead(receipt.afterHead, manifest.parentRepair.afterHead)
    || !sameHead(manifest.initialHead, manifest.parentRepair.afterHead)) throw new Error('定性修复必须接在准确的已完成正文修复之后。');
  if (expectedActive === 0 && hostIncidentRepairStateSHA(db, manifest.parentRepair.operationId) !== receipt.postStateSHA) throw new Error('定性修复之前正文修复的完整已验证领域状态已变化。');
}

function validate(db: CompanionConnection, manifest: CompanionHostQualitativeRepairManifest, ownersRoot: string, expectedActive: 0 | 1): void {
  parent(db, manifest, expectedActive); files(db, manifest, ownersRoot);
  const memory = new CompanionMemoryStore(db, () => { throw new Error('定性修复不提供替代消息正文端口。'); });
  memory.sources.withValidation(() => {
    const rowFor = (flag: CompanionHostQualitativeRepairManifest['flags'][number]) => {
      const row = get<Row>(db, `SELECT * FROM ${tables[flag.kind]} WHERE id=? AND companion_id=?`, flag.id, flag.owner);
      if (!row || row.active !== expectedActive || sha(row.data) !== flag.dataSHA) throw new Error('定性修复准确数据或 active CAS 已变化。'); return row;
    };
    const evidence = (owner: string, room: string, ids: string[], versions: Source[], links: Link[]) => {
      const scope = { companionId: owner, conversationId: room }; memory.sources.requireScope(scope);
      if (!ids.length || new Set(ids).size !== ids.length || versions.length !== ids.length || !ids.every(id => versions.filter(version => version.messageId === id).length === 1) || !links.length) throw new Error('定性修复缺少完整来源或记忆版本。');
      const covered = new Set<string>();
      for (const link of links) {
        const current = get<{ data: string }>(db, 'SELECT data FROM vcp_memory_notes WHERE id=? AND companion_id=?', link.note_id, owner);
        const note = current ? companionMemorySchema.parse(JSON.parse(current.data)) : undefined;
        const alias = get<{ content_revision: number }>(db, 'SELECT content_revision FROM companion_memory_version_revisions WHERE note_id=? AND version=?', link.note_id, link.note_version);
        const history = alias && get<{ state: string; sources: string; document_hash: string; relative_path: string }>(db, 'SELECT state,sources,document_hash,relative_path FROM companion_memory_history_files WHERE companion_id=? AND note_id=? AND content_revision=?', owner, link.note_id, alias.content_revision);
        if (!note || !alias || !history || note.version !== link.note_version + 2 || ['invalid', 'forgotten'].includes(note.status) || alias.content_revision !== note.contentRevision || history.state !== 'published'
          || !manifest.canonicalFiles.some(file => file.owner === owner && file.relativePath === history.relative_path && file.sha256 === history.document_hash)) throw new Error('定性修复记忆不是本次误撤回后恢复的同一准确历史正文。');
        const revoked = db.prepare("SELECT data FROM companion_memory_changes WHERE note_id=? AND json_extract(data,'$.changeKind')='revocation' AND json_extract(data,'$.at')>=? AND json_extract(data,'$.at')<=?")
          .all(note.id, manifest.incidentFrom, manifest.incidentUntil) as Array<{ data: string }>;
        if (!revoked.length || !memory.sources.frozenMemoryValid(scope, { id: note.id, version: link.note_version, contentRevision: alias.content_revision,
          sources: note.sources.map(source => ({ id: source.messageId, conversationId: source.conversationId, checksum: source.checksum, revision: source.revision })) })) throw new Error('定性修复的事故因果或当前 SQL 来源授权不成立。');
        if (!memory.execute({ type: 'memory.records.filter', ...scope, ids: [note.id] })?.memories?.some(item => item.id === note.id)) throw new Error('定性修复的当前记忆权限不成立。');
        for (const source of JSON.parse(history.sources) as Array<{ id: string; checksum: string; revision: number }>) covered.add(JSON.stringify([source.id, source.revision, source.checksum]));
      }
      for (const version of versions) {
        const source = get<Record<string, string | number | null>>(db, 'SELECT * FROM messages WHERE id=?', version.messageId);
        if (!source || source.revision !== version.revision || sha(String(source.content)) !== version.checksum || !covered.has(JSON.stringify([version.messageId, version.revision, version.checksum]))
          || !memory.sources.visible(scope, source)) throw new Error('定性修复的原消息版本、ACL 或正式来源已变化。');
      }
    };
    for (const flag of manifest.flags) {
      const row = rowFor(flag);
      if (flag.kind === 'state_change') {
        const change = companionStateChangeSchema.parse(JSON.parse(row.data));
        const expectedKey = 'memory-state:' + sha(JSON.stringify([...(change.memoryVersions ?? [])].sort((a, b) => a.id.localeCompare(b.id))));
        const links = db.prepare('SELECT note_id,note_version FROM companion_state_change_memories WHERE change_id=? ORDER BY note_id,note_version').all(flag.id) as Link[];
        const expectedLinks = [...(change.memoryVersions ?? [])].map(item => ({ note_id: item.id, note_version: item.version })).sort((a, b) => a.note_id.localeCompare(b.note_id) || a.note_version - b.note_version);
        if (change.kind !== 'memory' || change.id !== expectedKey || JSON.stringify(links) !== JSON.stringify(expectedLinks)
          || !get(db, 'SELECT 1 FROM companion_state_events WHERE companion_id=? AND event_key=? AND conversation_id=?', flag.owner, flag.id, change.sourceConversationId)) throw new Error('定性修复状态事件缺少准确的原子提交凭据。');
        evidence(flag.owner, change.sourceConversationId!, change.sourceMessageIds, change.sourceVersions ?? [], links);
      } else {
        const record = flag.kind === 'experience' ? companionCurrentExperienceSchema.parse(JSON.parse(row.data)) : companionRelationshipRecordSchema.parse(JSON.parse(row.data));
        if (record.companionId !== flag.owner || record.id !== flag.id) throw new Error('定性修复记录归属不匹配。');
        if (flag.kind === 'experience') {
          const latest = get<{ id: string }>(db, 'SELECT id FROM companion_current_experiences WHERE companion_id=? ORDER BY source_sequence DESC,rowid DESC LIMIT 1', flag.owner);
          // This exact incident has no expiring record. Reject that different
          // contract instead of using wall time as a substitute for world time.
          if (latest?.id !== flag.id || 'validUntil' in record && record.validUntil !== undefined) throw new Error('定性修复不能恢复旧的或有到期条件的体验。');
        } else if ((db.prepare('SELECT data FROM companion_relationship_records WHERE companion_id=?').all(flag.owner) as Array<{ data: string }>).some(item => companionRelationshipRecordSchema.parse(JSON.parse(item.data)).replacesRecordIds.includes(flag.id))) throw new Error('定性修复不能恢复已被后续替代的关系记录。');
        const causes = manifest.flags.filter(item => item.kind === 'state_change' && item.owner === flag.owner).map(item => companionStateChangeSchema.parse(JSON.parse(rowFor(item).data)))
          .filter(change => flag.kind === 'experience' ? change.experienceId === flag.id : change.relationshipRecordIds?.includes(flag.id));
        if (!causes.length) throw new Error('定性修复缺少同批实际状态事件。');
        const links = db.prepare('SELECT note_id,note_version FROM companion_qualitative_state_memories WHERE companion_id=? AND kind=? AND record_id=? ORDER BY note_id,note_version')
          .all(flag.owner, flag.kind, flag.id) as Link[];
        evidence(flag.owner, record.sourceConversationId, record.sourceMessageIds, record.sourceVersions, links);
      }
    }
  });
}

export function planCompanionHostQualitativeRepair(selection: CompanionRecoverySelection, input: unknown, ownersRoot: string) {
  const manifest = companionHostQualitativeRepairManifestSchema.parse(input), manifestSHA = sha(JSON.stringify(manifest));
  if (selection.libraryId !== manifest.libraryId) throw new Error('定性修复资产库身份不匹配。');
  const inspection = inspectCompanionFencedMaintenance(selection);
  try {
    const raw = get<{ value: string }>(inspection.db, 'SELECT value FROM metadata WHERE key=?', key(manifest.operationId))?.value;
    if (raw) {
      const receipt = JSON.parse(raw) as Receipt;
      if (receipt.phase !== 'completed' || receipt.manifestSHA !== manifestSHA || receipt.parentManifestSHA !== manifest.parentRepair.manifestSHA || !sameHead(receipt.initialHead, manifest.initialHead)
        || !sameHead(receipt.afterHead, inspection.head) || hostIncidentRepairStateSHA(inspection.db, manifest.operationId) !== receipt.postStateSHA) throw new Error('定性修复完成后状态或重入凭据已变化。');
      validate(inspection.db, manifest, ownersRoot, 1); return { state: 'completed' as const, manifestSHA, head: inspection.head, flags: 10 };
    }
    if (!sameHead(manifest.initialHead, inspection.head) || hostIncidentRepairStateSHA(inspection.db, manifest.operationId) !== manifest.beforeStateSHA) throw new Error('定性修复完整领域摘要或宿主水位已变化。');
    validate(inspection.db, manifest, ownersRoot, 0); return { state: 'planned' as const, manifestSHA, head: inspection.head, flags: 10 };
  } finally { inspection.close(); }
}

export function applyCompanionHostQualitativeRepair(selection: CompanionRecoverySelection, input: unknown, ownersRoot: string, approvedManifestSHA: string) {
  const manifest = companionHostQualitativeRepairManifestSchema.parse(input), manifestSHA = sha(JSON.stringify(manifest));
  if (manifestSHA !== approvedManifestSHA || selection.libraryId !== manifest.libraryId) throw new Error('定性修复需要准确批准的计划 SHA。');
  // Read only this operation's durable receipt to select an exact crash head;
  // the real host fence still validates enrollment, inode and pending finish.
  const Database = BetterSqlite3 as { new(file: string, options: { readonly: true; fileMustExist: true }): CompanionConnection };
  const readonly = new Database(path.join(selection.libraryPath, '.worldlinebox', 'companions', 'messages.sqlite'), { readonly: true, fileMustExist: true }); let expected = manifest.initialHead;
  try {
    const raw = get<{ value: string }>(readonly, 'SELECT value FROM metadata WHERE key=?', key(manifest.operationId))?.value;
    if (raw) { const receipt = JSON.parse(raw) as Receipt;
      if (receipt.manifestSHA !== approvedManifestSHA || !sameHead(receipt.initialHead, manifest.initialHead) || receipt.phase !== 'completed') throw new Error('定性修复重入凭据不匹配。'); expected = head.parse(receipt.afterHead);
    }
  } finally { readonly.close(); }
  const session = openCompanionFencedMaintenance(selection, expected);
  try {
    if (get(session.db, 'SELECT 1 FROM metadata WHERE key=?', key(manifest.operationId))) return planCompanionHostQualitativeRepair(selection, manifest, ownersRoot);
    session.mutate(db => {
      if (hostIncidentRepairStateSHA(db, manifest.operationId) !== manifest.beforeStateSHA) throw new Error('定性修复提交前完整领域摘要已变化。');
      validate(db, manifest, ownersRoot, 0);
      for (const flag of manifest.flags) if (db.prepare(`UPDATE ${tables[flag.kind]} SET active=1 WHERE id=? AND companion_id=? AND active=0 AND data=?`)
        .run(flag.id, flag.owner, get<Row>(db, `SELECT data FROM ${tables[flag.kind]} WHERE id=? AND companion_id=?`, flag.id, flag.owner)!.data).changes !== 1) throw new Error('定性修复 active CAS 失败。');
      // Re-run the real SQL gates after every provisional update. A late
      // withdrawal/trigger aborts all ten flags and the receipt atomically.
      validate(db, manifest, ownersRoot, 1);
      const receipt: Receipt = { manifestSHA, parentManifestSHA: manifest.parentRepair.manifestSHA, phase: 'completed', initialHead: manifest.initialHead,
        afterHead: { ...expected, generation: expected.generation + 1 }, postStateSHA: hostIncidentRepairStateSHA(db, manifest.operationId) };
      db.prepare('INSERT INTO metadata(key,value) VALUES(?,?)').run(key(manifest.operationId), JSON.stringify(receipt));
    });
    return { state: 'completed' as const, manifestSHA, head: session.head, flags: 10 };
  } finally { session.close(); }
}
