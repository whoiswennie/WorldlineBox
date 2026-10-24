import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import { expect, it, vi } from 'vitest';
import { CompanionsStore, type CompanionConnection } from '../../src/companions/store';
import type { CompanionActivityTask } from '../../src/shared/companion-activity-task';
import type { CompanionMessage } from '../../src/shared/companions';
import type { CompanionSocialNotification } from '../../src/shared/companion-social';
import { reviewCompanionSocialProgress } from '../../src/main/companions/social-progress-review';
import { realGlobalChatConfig } from '../fixtures/companion-real-chat';

const sha = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const owner = 'deepseek-sister', originalSourceId = '397682cb-76b7-462a-acb5-c8c39556f1c4';
const originalTaskId = 'ce055210-6d84-46d3-9001-6d7aa2f748e3', falseMessageId = '17ccefd1-3d10-453e-974b-b478b12a8114';
const statement = '6人局、2狼2民、预言家女巫各1的配置我已经先告诉她们了';
type Progress = NonNullable<CompanionSocialNotification['progressEvidence']>;

/** Two real reviewer calls only. The positive is an explicitly separate actual
 * SQLite delivery control; it never repairs or rewrites the original history. */
it.skipIf(process.env.WORLDLINEBOX_SOCIAL_NOTIFICATION_PROGRESS_REAL !== '1' && process.env.WORLDLINEBOX_SOCIAL_NOTIFICATION_PROGRESS_PREPARE !== '1')('rejects the preserved false configuration delivery and allows a genuinely delivered linked configuration', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-notification-progress-controls-'));
  const sourceFile = path.resolve('artifacts/vcp-validation/unified-real-natural-werewolf-2026-10-24-f551-original-u4-resumed.json');
  const sourceBytes = await readFile(sourceFile), original = JSON.parse(sourceBytes.toString()) as { root: string; persistentTasks: CompanionActivityTask[] };
  expect(sha(sourceBytes)).toBe('dbfad93088c8284fb4dfa9f14dde1291967e92acf4b6652236903b24828a166e');
  const Database = BetterSqlite3 as { new (filename: string, options: { readonly: true }): CompanionConnection };
  const databaseFile = path.join(original.root, 'companions', 'messages.sqlite'), sourceDatabase = new Database(databaseFile, { readonly: true });
  let preserved: { task: CompanionActivityTask; progress: Progress; sourceText: string; falseBody: string };
  try {
    const source = sourceDatabase.prepare('SELECT content FROM messages WHERE id=? AND author_id=?').get(originalSourceId, 'user') as { content: string };
    expect(sha(source.content)).toBe('8a309830e490e11f3eefbf526ef3698199476bf96a64e36a58a93be522e637d1');
    const falseBody = (sourceDatabase.prepare('SELECT content FROM messages WHERE id=? AND author_id=?').get(falseMessageId, owner) as { content: string }).content;
    expect(falseBody).toContain(statement);
    const task = original.persistentTasks.find(task => task.id === originalTaskId)!;
    expect(task.history.find(item => item.step === 3)).toMatchObject({ ok: false });
    const outbound: Progress['outbound'] = [];
    for (const row of sourceDatabase.prepare("SELECT m.*,s.recipient_ids FROM companion_social_outbox o JOIN messages m ON m.id=o.message_id JOIN companion_social_messages s ON s.message_id=m.id WHERE o.companion_id=? AND o.status='sent' AND json_extract(o.data,'$.authorizationMessageId')=? ORDER BY m.sequence").all(owner, originalSourceId) as Array<Record<string, string | number | null>>) {
      const message: CompanionMessage = { id: String(row.id), conversationId: String(row.conversation_id), authorId: String(row.author_id), content: String(row.content),
        kind: 'text', status: 'sent', sequence: Number(row.sequence), createdAt: String(row.created_at), attachments: [] };
      outbound.push({ message, recipientIds: JSON.parse(String(row.recipient_ids)) });
    }
    expect(outbound.map(item => item.message.id).sort()).toEqual(['e6e4cdaf-8aea-4eef-bce5-d6cc6613202c', 'ea56fb0a-8882-4b93-8c51-ddd339813529'].sort());
    expect(outbound.every(item => !item.message.content.includes('6人'))).toBe(true);
    preserved = { task, sourceText: source.content, falseBody, progress: { observationChecksum: sha(JSON.stringify(outbound)), outbound, complete: true } };
  } finally { sourceDatabase.close(); }
  const sourcePaths = ['src/main/companions/social-progress-review.ts', 'src/main/companions/social-progress-evidence.ts',
    'src/main/companions/social-notification-model.ts', 'src/companions/social-continuity-store.ts', 'src/companions/activity-task-store.ts',
    'src/shared/companion-social.ts', 'src/shared/companion-storage.ts', 'tests/worker/companion-social-notification-progress-real.test.ts'];
  const fingerprints = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async filename => [filename, sha(await readFile(path.resolve(filename)))])));
  const sourceFingerprints = await fingerprints(), evidence: unknown[] = [];
  let store: CompanionsStore | undefined, status = 'failed';
  try {
    const config = process.env.WORLDLINEBOX_SOCIAL_NOTIFICATION_PROGRESS_REAL === '1' ? await realGlobalChatConfig(root) : undefined;
    const peers = ['deepseek-flash', 'gugugaga'];
    store = new CompanionsStore(path.join(root, 'positive-control.sqlite'), [owner, ...peers].map(id => ({ id, name: id, description: '', persona: '独立角色',
      model: '', avatar: 'sister', active: true, proactive: false })));
    vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime('2026-10-24T10:00:00Z');
    const world = store.request({ type: 'world.snapshot' }).world!;
    store.request({ type: 'world.configure', expectedRevision: world.settings.revision, patch: { mode: 'realtime', timeZone: 'UTC' } });
    for (const companionId of [owner, ...peers]) {
      const scope = { companionId, conversationId: store.openPrivate(companionId).id }, routine = store.request({ type: 'routine.get', ...scope }).routine!;
      store.request({ type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: 'UTC', wakeAt: '07:00', sleepAt: '23:00', meals: [], habits: [] } });
    }
    const advance = () => { vi.setSystemTime(Date.now() + 2000); store!.request({ type: 'world.tick' }); };
    advance();
    const room = store.openPrivate(owner), source = store.appendMessage({ conversationId: room.id, authorId: 'user', content: preserved.sourceText, replyDirective: 'none' });
    const task = store.request({ type: 'activity.start', companionId: owner, conversationId: room.id, sourceMessageId: source.id,
      clientId: 'positive_actual_goal', title: '配置送达正控', goal: source.content }).activityTask!;
    for (const peer of peers) {
      const target = store.request({ type: 'social.conversation.ensure', companionId: owner, memberIds: [owner, peer] }).socialConversation!;
      store.request({ type: 'social.send', companionId: owner, conversationId: target.id, authorizationMessageId: source.id,
        content: '本次讨论的配置是6人局、2狼2民、预言家女巫各1；请本人决定是否参加。', channel: 'phone', clientId: 'actual_configuration_' + peer });
      advance(); const delivered = store.request({ type: 'social.job.claim' });
      if (delivered.socialJob) { advance(); store.request({ type: 'social.job.complete', id: delivered.socialJob.id, leaseToken: delivered.socialJob.leaseToken!, text: null }); }
    }
    const leased = store.request({ type: 'activity.claim' }).activityTask!;
    expect(leased.id).toBe(task.id);
    const positive = store.request({ type: 'activity.observe', id: leased.id, leaseToken: leased.leaseToken! }).activityProgressEvidence!;
    expect(positive.outbound).toHaveLength(2); expect(positive.outbound.every(item => item.message.content.includes('6人局'))).toBe(true);
    vi.useRealTimers();
    const cases = [{ id: 'preserved_failed_proposal_not_delivery', task: preserved.task, progress: preserved.progress, expectedRejected: true },
      { id: 'separate_actual_deliveries_control', task: leased, progress: positive, expectedRejected: false }];
    if (!config) { evidence.push({ status: 'prepared_actual_sqlite_controls_no_model_or_key_read', cases }); status = 'prepared_0paid'; return; }
    for (const item of cases) {
      const correction = await reviewCompanionSocialProgress(statement, [item.task], config, undefined, { requireReview: true, includeTerminal: true,
        names: [{ id: owner, name: '大肥鱼' }, { id: 'deepseek-flash', name: '小肥鱼' }, { id: 'gugugaga', name: '咕咕嘎嘎' }], outbound: item.progress,
        fetchFn: async (url, init) => {
          const wire = JSON.parse(String(init?.body)), response = await fetch(url, init), actual = await response.clone().json();
          evidence.push({ case: item.id, frame: JSON.parse(wire.messages[1].content), visibleContent: actual.choices?.[0]?.message?.content,
            usage: actual.usage, finishReason: actual.choices?.[0]?.finish_reason }); return response;
        } });
      evidence.push({ case: item.id, expectedRejected: item.expectedRejected, correction: correction ?? null });
      expect(!!correction, item.id).toBe(item.expectedRejected);
    }
    expect(sha(await readFile(sourceFile))).toBe(sha(sourceBytes)); status = 'passed';
  } finally {
    vi.useRealTimers(); store?.close(); const finishedSourceFingerprints = await fingerprints();
    await writeFile(path.resolve(process.env.WORLDLINEBOX_SOCIAL_NOTIFICATION_PROGRESS_RESULT ?? 'artifacts/vcp-validation/social-notification-progress-paired-real-2026-10-24.json'),
      JSON.stringify({ status, root, sourceFile, sourceChecksum: sha(sourceBytes), originalSourceId, originalTaskId, falseMessageId,
        preservedFalseBodyChecksum: sha(preserved!.falseBody), statement, sourceFingerprints, finishedSourceFingerprints,
        sourceFilesUnchanged: JSON.stringify(sourceFingerprints) === JSON.stringify(finishedSourceFingerprints), evidence,
        scope: 'Two real semantic reviewer calls on exact focal claim. Positive deliveries belong to a separate isolated actual SQLite goal; original false history is not repaired. No natural game or complete notification author acceptance is claimed.' }, null, 2));
  }
}, 180000);
