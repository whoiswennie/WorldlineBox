import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { BotStore } from '../../src/main/companion-bot/store';
import { BUILTIN_BOT_COMPANIONS } from '../../src/shared/builtin-bot-companions';
import { seedPeerWorkspace } from '../fixtures/bot-peer-workspace-fixture';

it('seeds independent user-direct, ordinary group and observed pair without leaving model work or copying private history', () => {
  const profile = mkdtempSync(path.join(os.tmpdir(), 'wlb-peer-workspace-fixture-'));
  let store: BotStore | undefined;
  try {
    const filename = path.join(profile, 'companion-bot-v2', 'bot.sqlite'); store = new BotStore(filename);
    for (const person of BUILTIN_BOT_COMPANIONS) store.createCompanion(person);
    store.close(); store = undefined;
    const fixture = seedPeerWorkspace(profile); store = new BotStore(filename);
    expect(fixture.pendingEvents).toBe(0); expect(fixture.actualModelInference).toBe(false);
    const group = store.getConversation(fixture.peerId)!, pair = store.getConversation(fixture.observedId)!, direct = store.getConversation(fixture.targetPrivateId)!;
    expect(group.kind).toBe('group'); expect(group.memberIds).toContain('user'); expect(pair.kind).toBe('peer'); expect(pair.memberIds).not.toContain('user'); expect(pair.userRole).toBe('observer');
    expect(direct.kind).toBe('direct'); expect(new Set(direct.memberIds)).toEqual(new Set(['user', fixture.targetCompanionId]));
    expect(group.id).not.toBe(pair.id); expect(group.id).not.toBe(direct.id); expect(pair.id).not.toBe(direct.id);
    expect(store.getMessage(fixture.userDirectIntroductionId)?.senderId).toBe(fixture.sourceCompanionId);
    expect(store.getMessage(fixture.userDirectReplyId)?.conversationId).toBe(direct.id);
    for (const id of fixture.observedMessageIds) { const message = store.getMessage(id)!; expect(message.conversationId).toBe(pair.id); expect(message.senderId).not.toBe('user'); expect(message.content).not.toContain(fixture.secrets.origin); expect(message.content).not.toContain(fixture.secrets.target); }
    expect(store.openPeer(fixture.sourceCompanionId, fixture.targetCompanionId).id).toBe(pair.id);
  } finally { store?.close(); rmSync(profile, { recursive: true, force: true }); }
});
