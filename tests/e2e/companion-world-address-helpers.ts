import { expect, type Page } from '@playwright/test';
import type { WorldlineBoxCompanionsApi } from '../../src/shared/companions';
type Scope = { companionId: string; conversationId: string };
async function api(page: Page, input: Parameters<WorldlineBoxCompanionsApi['request']>[0]) {
  const result = await page.evaluate(value => (window as unknown as { worldlinebox: { companions: WorldlineBoxCompanionsApi } }).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
/** Owner-authored delivered address; the test never seeds spatial knowledge. */
export async function shareWorldHomeAddress(page: Page, owner: string, recipients: string[]) {
  const room = (await api(page, { type: 'conversation.open', companionId: owner })).conversation!;
  const targets = await Promise.all(recipients.map(async companionId => ({ companionId, conversationId: (await api(page, { type: 'conversation.open', companionId })).conversation!.id })));
  if ((await Promise.all(targets.map(async scope => (await api(page, { type: 'world.observe', ...scope })).world!.knownAddresses?.some(address => address.companionId === owner)))).every(Boolean)) return;
  await api(page, { type: 'world.tool', companionId: owner, conversationId: room.id, arguments: { action: 'share_address', recipientIds: recipients } });
  for (const scope of targets) await expect.poll(async () => (await api(page, { type: 'world.observe', ...scope })).world!.knownAddresses?.some(address => address.companionId === owner), { timeout: 15000 }).toBe(true);
}
export async function walkIntoWorldHome(page: Page, scope: Scope, owner: string) {
  await shareWorldHomeAddress(page, owner, [scope.companionId]);
  await api(page, { type: 'world.tool', ...scope, arguments: { action: 'navigate', targetCompanionId: owner } });
  await expect.poll(async () => { const self = (await api(page, { type: 'world.observe', ...scope })).world!.actors[0]!; return self.sceneId === 'commons' && !self.route.length; }, { timeout: 40000 }).toBe(true);
  await api(page, { type: 'world.tool', ...scope, arguments: { action: 'enter', targetCompanionId: owner } });
}
