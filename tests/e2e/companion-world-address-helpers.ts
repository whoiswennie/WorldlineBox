import { expect, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
type Scope = { companionId: string; conversationId: string };
async function api(page: Page, input: Parameters<WorldlineBoxCompanionsApi['request']>[0]) {
  const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
/** Owner-authored entrance evidence; receiving it does not automatically create a memory. */
export async function shareWorldHomeAddress(page: Page, owner: string, recipients: string[]) {
  const room = (await api(page, { type: 'conversation.open', companionId: owner })).conversation!;
  const targets = await Promise.all(recipients.map(async companionId => ({ companionId, conversationId: (await api(page, { type: 'conversation.open', companionId })).conversation!.id })));
  await api(page, { type: 'world.tool', companionId: owner, conversationId: room.id, arguments: { action: 'share_entrance', recipientIds: recipients } });
  const expectedMembers = [owner, ...recipients].sort().join(',');
  const peerRoom = (await api(page, { type: 'social.conversations', companionId: owner, limit: 100 })).socialConversationPage!.items.find(item => [...item.memberIds].sort().join(',') === expectedMembers)!;
  expect(peerRoom).toBeDefined();
  for (const scope of targets) await expect.poll(async () => (await api(page, { type: 'memory.world_query', ...scope, category: 'social', roomId: peerRoom.id, query: '场景 home_' + owner, limit: 10 })).worldKnowledge?.items.some(item => !!item.sharedEntrance), { timeout: 15000 }).toBe(true);
}
export async function walkIntoWorldHome(page: Page, scope: Scope, owner: string) {
  await api(page, { type: 'world.tool', ...scope, arguments: { action: 'travel', targetSceneId: 'home_' + owner } });
  await expect.poll(async () => { const self = (await api(page, { type: 'world.observe', ...scope })).world!.actors[0]!; return self.sceneId === 'home_' + owner && !self.route.length && !self.travel; }, { timeout: 40000 }).toBe(true);
}
