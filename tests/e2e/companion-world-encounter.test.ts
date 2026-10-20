import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import type { CompanionsRequest, WorldlineBoxCompanionsApi } from '../../src/shared/companions';
import type { CompanionWorldSnapshot } from '../../src/shared/companion-world';
import type { CompanionWorldWindowApi } from '../../src/shared/companion-world-window';
import type { WorldlineBoxLlmApi } from '../../src/shared/llm';
import { companionWorldCellWalkable } from '../../src/shared/companion-world-engine';
import { electronLaunchEnv, resolveElectronAppPath, resolveElectronExecutablePath, resolveSessionLogPath } from './electron-test-helpers';

type Bridge = Window & { worldlinebox: { companions: WorldlineBoxCompanionsApi; companionWorld: CompanionWorldWindowApi; llm: WorldlineBoxLlmApi } };
const members = ['deepseek-flash', 'deepseek-sister', 'gemini'];
const output = path.resolve('.tools/test-output/companions');
async function request(page: Page, input: CompanionsRequest) {
  const result = await page.evaluate(value => (window as unknown as Bridge).worldlinebox.companions.request(value), input);
  expect(result.ok, result.error).toBe(true); return result;
}
function cleanup(directory: string) {
  const absolute = path.resolve(directory); if (path.dirname(absolute) !== path.resolve(tmpdir()) || !path.basename(absolute).startsWith('worldlinebox-encounter-')) throw new Error('Unexpected encounter fixture cleanup target.');
  rmSync(absolute, { recursive: true, force: true });
}
async function launch(profile: string) {
  const application = await electron.launch({ executablePath: resolveElectronExecutablePath(), args: [resolveElectronAppPath()], cwd: resolveElectronAppPath(), env: electronLaunchEnv({ WORLDLINEBOX_E2E: '1', WORLDLINEBOX_E2E_USER_DATA_PATH: profile }, { gpu: 'hardware' }) });
  const page = await application.firstWindow(), native = await application.browserWindow(page);
  await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 940); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
  await expect(page.locator('[data-application-module="dsh"]')).toHaveAttribute('aria-current', 'page'); return { application, page };
}
function seedEncounter(profile: string) {
  // Initial physical positions and a fixed exponential-clock threshold are the
  // fixture inputs. No messages, social jobs, claims or decisions are inserted.
  // Real elapsed time must accumulate hazard and generate the production event.
  const script = `const Database=require('better-sqlite3');const db=new Database(process.argv[1]);const ids=JSON.parse(process.argv[2]);const row=db.prepare('SELECT data FROM companion_world WHERE id=1').get();const world=JSON.parse(row.data),now=Date.now();world.settings={...world.settings,revision:world.settings.revision+1,mode:'realtime'};world.anchors=[{realAt:now,virtualAt:now,settings:world.settings}];world.cursor=now;for(let i=0;i<ids.length;i++){const actor=world.actors.find(a=>a.companionId===ids[i]);Object.assign(actor,{sceneId:'park',position:{x:119+i,y:56},route:[],activity:'idle',activityStartedAtReal:new Date(now).toISOString(),routinePhase:'awake',artAction:'idle',lastDecisionAt:now});for(const key of ['destinationId','furnitureId','transition','seatUntil','phoneResume','parkWalk','meetingHold'])delete actor[key];}db.prepare('UPDATE companion_world SET data=? WHERE id=1').run(JSON.stringify(world));const clock=db.prepare('INSERT OR REPLACE INTO companion_world_encounters(pair_key,left_id,right_id,data) VALUES(?,?,?,?)');for(let a=0;a<ids.length;a++)for(let b=a+1;b<ids.length;b++)clock.run(ids[a]+'|'+ids[b],ids[a],ids[b],JSON.stringify({present:true,hazard:0,threshold:.02,lastRealAt:now}));db.close();`;
  const result = spawnSync(resolveElectronExecutablePath(), ['-e', script, path.join(profile, 'companions/messages.sqlite'), JSON.stringify(members)], { cwd: resolveElectronAppPath(), env: { ...electronLaunchEnv(), ELECTRON_RUN_AS_NODE: '1' }, encoding: 'utf8', windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
}

// eslint-disable-next-line no-empty-pattern
test('a real integrated encounter starts a three-companion face conversation with visible speaking and listening and reusable observer records', async ({}, testInfo) => {
  test.setTimeout(180_000);
  const directory = mkdtempSync(path.join(tmpdir(), 'worldlinebox-encounter-')), profile = path.join(directory, 'profile');
  let application: ElectronApplication | undefined, main: Page | undefined, releaseDecision: (() => void) | undefined;
  const ready = new Promise<void>(resolve => { releaseDecision = resolve; });
  const requests: Array<Record<string, unknown>> = [], fixtureErrors: string[] = [], rendererErrors: string[] = [], samples: CompanionWorldSnapshot[] = [];
  const server = createServer((incoming, response) => {
    let raw = ''; incoming.setEncoding('utf8'); incoming.on('data', value => { raw += value; }); incoming.on('end', () => { void (async () => {
      try {
        const body = JSON.parse(raw), data = JSON.parse(body.messages[1].content); let result: unknown;
        if (data.purpose === 'world_decision') {
          if (data.trigger.encounterMemberIds) {
            requests.push(data); await ready;
            const recipients = data.trigger.encounterMemberIds.filter((id: string) => id !== data.companion.id);
            if (JSON.stringify([...data.trigger.encounterMemberIds].sort()) !== JSON.stringify(members)) fixtureErrors.push('Encounter member identity mismatch.');
            result = { action: { action: 'social', recipientIds: recipients, kind: 'talk', text: '在喷泉旁遇到你们真巧，我们就在这里聊一会儿吧。' }, reason: '三位伙伴在同一现场真实相遇，主动开口交谈。', appraisals: [] };
          } else result = { action: null, reason: '保持真实生活状态。', appraisals: [] };
        } else if (data.purpose === 'world_social') {
          requests.push(data); if (data.channel !== 'face_to_face') fixtureErrors.push('Face encounter unexpectedly used phone.');
          const speaker = data.identity.self.id, next = data.members.find((member: { id: string }) => member.id !== speaker && member.id !== data.source.authorId)?.id;
          await new Promise(resolve => setTimeout(resolve, 1800));
          result = { text: speaker + '：我听到你的话了，就在这里一起聊聊喷泉和今天的公园吧。', ...(next ? { nextRecipientId: next } : {}), reason: '回应真实在场成员。' };
        } else if (data.purpose === 'memory_query') result = {};
        else if (data.purpose === 'memory_dream') result = { candidates: [], dream: null };
        else if (data.purpose?.startsWith('memory_')) result = { candidates: [] };
        else { fixtureErrors.push('Unexpected model purpose: ' + data.purpose); result = { text: null, reason: '无需发言。' }; }
        response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] }));
      } catch (error) { fixtureErrors.push(String(error)); response.writeHead(400); response.end(); }
    })(); });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    mkdirSync(output, { recursive: true }); const bootstrap = await launch(profile); application = bootstrap.application; const page = bootstrap.page;
    const initial = (await request(page, { type: 'world.snapshot' })).world!;
    for (const resident of initial.residents) {
      const rules = (await request(page, { type: 'life-rule.list', companionId: resident.companionId })).lifeRules!;
      for (const rule of rules) await request(page, { type: 'life-rule.remove', companionId: resident.companionId, id: rule.id, expectedRevision: rule.revision });
    }
    for (const companionId of members) {
      const conversation = (await request(page, { type: 'conversation.open', companionId })).conversation!, scope = { companionId, conversationId: conversation.id };
      const routine = (await request(page, { type: 'routine.get', ...scope })).routine!;
      await request(page, { type: 'routine.configure', ...scope, expectedRevision: routine.revision, patch: { timeZone: initial.settings.timeZone, wakeAt: '00:00', sleepAt: '23:59', meals: [], habits: [] } });
    }
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('No encounter fixture port.');
    await page.evaluate(async baseUrl => { await (window as unknown as Bridge).worldlinebox.llm.setConfig({ apiFormat: 'openai_chat', model: 'encounter-fixture', baseUrl, apiKey: 'fixture-encounter-key' }); }, 'http://127.0.0.1:' + address.port);
    await application.close(); application = undefined; seedEncounter(profile);
    const started = await launch(profile); application = started.application; main = started.page; main.on('pageerror', error => rendererErrors.push(error.message));
    const world = (await request(main, { type: 'world.snapshot' })).world!, commons = world.scenes.find(scene => scene.id === 'park')!;
    for (const id of members) { const actor = world.actors.find(actor => actor.companionId === id)!; expect(actor.sceneId).toBe('park'); expect(companionWorldCellWalkable(commons, actor.position)).toBe(true); }
    const opened = application.waitForEvent('window'), opening = main.evaluate(() => (window as unknown as Bridge).worldlinebox.companionWorld.open({ sceneId: 'park' }));
    const park = await opened, native = await application.browserWindow(park); expect((await opening).ok).toBe(true);
    await native.evaluate(window => { window.unmaximize(); window.setSize(1440, 940); window.setOpacity(0); window.setFocusable(false); window.webContents.setBackgroundThrottling(false); window.showInactive(); });
    await expect(park.locator('canvas')).toHaveAttribute('data-world-view', 'park'); await expect(park.locator('canvas')).toHaveAttribute('data-world-ready', 'true');
    releaseDecision!();
    await expect.poll(async () => { const snapshot = (await request(main!, { type: 'world.snapshot' })).world!; samples.push(snapshot); return members.every(id => snapshot.actors.find(actor => actor.companionId === id)?.communication?.channel === 'face_to_face'); }, { timeout: 40_000, intervals: [100] }).toBe(true);
    await expect.poll(async () => { const snapshot = (await request(main!, { type: 'world.snapshot' })).world!; samples.push(snapshot); return snapshot.actors.some(actor => members.includes(actor.companionId) && actor.communication?.phase === 'speaking'); }, { timeout: 20_000, intervals: [100] }).toBe(true);
    const active = samples.at(-1)!, talking = active.actors.filter(actor => members.includes(actor.companionId));
    for (const actor of talking) {
      expect(actor.communication?.channel).toBe('face_to_face'); expect(actor.artAction.startsWith('phone')).toBe(false);
      expect(actor.artAction).toBe(actor.communication?.phase === 'speaking' ? 'communicate' : 'think');
      await expect(park.locator('[data-world-actor-id="' + actor.companionId + '"]')).toHaveAttribute('data-world-behavior', /当面|正在听/);
    }
    expect(talking.some(actor => actor.communication?.phase === 'listening')).toBe(true);
    expect(active.events.some(event => event.kind === 'encounter_opportunity')).toBe(true);
    await park.getByRole('button', { name: '在场景中找到大肥鱼', exact: true }).click();
    await expect(park.locator('canvas')).toHaveAttribute('data-world-loaded-actors', '3');
    const labelRectangles = () => park.locator('.companion-world-view').evaluate(element => {
      const viewport = element.getBoundingClientRect();
      const labels = [...element.querySelectorAll<HTMLElement>('[data-world-actor-id]')].filter(label => !label.hidden).map(label => {
        const box = label.getBoundingClientRect(); return { id: label.dataset.worldActorId!, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
      });
      let overlap = 0;
      for (let a = 0; a < labels.length; a++) for (let b = a + 1; b < labels.length; b++) overlap += Math.max(0, Math.min(labels[a]!.right, labels[b]!.right) - Math.max(labels[a]!.left, labels[b]!.left)) * Math.max(0, Math.min(labels[a]!.bottom, labels[b]!.bottom) - Math.max(labels[a]!.top, labels[b]!.top));
      return { viewport: { left: viewport.left, top: viewport.top, right: viewport.right, bottom: viewport.bottom }, labels, overlap };
    });
    await expect.poll(async () => { const layout = await labelRectangles(); return layout.labels.length === 3 && layout.overlap <= 1; }).toBe(true);
    const labelLayout = await labelRectangles();
    for (const label of labelLayout.labels) { expect(label.width).toBeGreaterThan(0); expect(label.height).toBeGreaterThan(0); expect(label.left).toBeGreaterThanOrEqual(labelLayout.viewport.left - 1); expect(label.right).toBeLessThanOrEqual(labelLayout.viewport.right + 1); expect(label.top).toBeGreaterThanOrEqual(labelLayout.viewport.top - 1); expect(label.bottom).toBeLessThanOrEqual(labelLayout.viewport.bottom + 1); }
    await park.screenshot({ path: path.join(output, 'verified-public-park-face-conversation.png') });
    await expect.poll(async () => (await request(main!, { type: 'social.conversations', companionId: members[0], limit: 100 })).socialConversationPage!.items.find(room => JSON.stringify([...room.memberIds].sort()) === JSON.stringify(members))?.messageCount, { timeout: 35_000 }).toBe(4);
    const rooms = (await request(main, { type: 'social.conversations', companionId: members[0], limit: 100 })).socialConversationPage!.items.filter(room => JSON.stringify([...room.memberIds].sort()) === JSON.stringify(members));
    expect(rooms).toHaveLength(1); const room = rooms[0]!; expect(room.kind).toBe('group'); expect(room.memberIds).not.toContain('user');
    const messages = (await request(main, { type: 'social.messages', conversationId: room.id, limit: 100 })).socialMessagePage!.items;
    expect(messages).toHaveLength(4); expect([...new Set(messages.map(item => item.message.authorId))].sort()).toEqual(members);
    for (const item of messages) { expect(item.channel).toBe('face_to_face'); expect(item.message.authorId).not.toBe('user'); expect(item.recipientIds).toEqual(expect.arrayContaining(members.filter(id => id !== item.message.authorId))); }
    for (const context of requests) {
      const identity = context.identity as { audience: string; self: { id: string }; participants: Array<{ id: string }>; authorization: { peerSpeechGrantsExternalExecution: boolean } };
      expect(identity.audience).toBe('peers'); expect(identity.authorization.peerSpeechGrantsExternalExecution).toBe(false); expect(identity.participants.some(person => person.id === 'user')).toBe(false);
      const modelWorld = context.world as { actors: Array<{ companionId: string; state?: unknown; route?: unknown }>; perception: NonNullable<CompanionWorldSnapshot['perception']> };
      expect(modelWorld.perception.companionId).toBe(identity.self.id); expect(modelWorld.perception.awake).toBe(true);
      const observedMembers = [identity.self.id, ...modelWorld.perception.people.filter(person => person.visible && modelWorld.perception.visibleCompanionIds.includes(person.companionId)).map(person => person.companionId)];
      expect(observedMembers.sort()).toEqual(members);
      for (const actor of modelWorld.actors.filter(actor => actor.companionId !== identity.self.id)) {
        expect(actor).not.toHaveProperty('state'); expect(actor).not.toHaveProperty('route');
      }
      expect(modelWorld.perception.people.every(person => !person.visible || person.lastObservedAt === modelWorld.perception.observedAtVirtual)).toBe(true);
    }
    await main.locator('[data-application-module="companions"]').click(); await main.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click();
    const monitor = main.getByRole('dialog', { name: '伙伴社交观察', exact: true }); await expect(monitor).toBeVisible();
    await monitor.locator('[data-social-conversation="' + room.id + '"]').click();
    await expect(monitor.locator('[data-social-message-channel="face_to_face"]')).toHaveCount(4); await expect(monitor.locator('[data-social-channel="face_to_face"]')).toHaveCount(4);
    await expect(monitor.locator('[data-social-channel="face_to_face"]').first()).toHaveText('当面交流'); expect(await monitor.locator('.companions-composer').count()).toBe(0);
    await monitor.getByRole('combobox', { name: '社交聊天观察视角', exact: true }).selectOption('deepseek-flash');
    await expect(monitor.locator('[data-social-author="deepseek-flash"]').first()).toHaveClass(/is-own/);
    await main.screenshot({ path: path.join(output, 'verified-companion-face-monitor-light.png') });
    await main.evaluate(() => localStorage.setItem('worldlinebox.theme-prefs.v1', JSON.stringify({ version: 1, theme: 'dark' }))); await main.reload();
    await main.locator('[data-application-module="companions"]').click(); await main.getByRole('button', { name: '打开伙伴社交观察', exact: true }).click(); await monitor.locator('[data-social-conversation="' + room.id + '"]').click();
    await expect(main.locator('html')).toHaveAttribute('data-theme', 'dark'); await expect(monitor.locator('[data-social-message-channel="face_to_face"]')).toHaveCount(4);
    await main.screenshot({ path: path.join(output, 'verified-companion-face-monitor-dark.png') });
    const result = { fixture: 'stopped-profile initial positions and exponential threshold; all encounter events, dialogue, model identities and records generated by running services', members, fixedThreshold: .02, initial: world, active, labelLayout, room, messages, requests, samples, fixtureErrors, rendererErrors };
    writeFileSync(path.join(output, 'verified-companion-face-encounter.json'), JSON.stringify(result, null, 2)); await testInfo.attach('face-encounter', { body: JSON.stringify(result, null, 2), contentType: 'application/json' });
    expect(fixtureErrors).toEqual([]); expect(rendererErrors).toEqual([]);
  } catch (error) {
    const logs = application ? await application.evaluate(({ app }) => app.getPath('logs')).then(directory => { try { return readFileSync(resolveSessionLogPath(directory), 'utf8').slice(-40000); } catch { return undefined; } }).catch(() => undefined) : undefined;
    const result = { requests, fixtureErrors, samples, logs, world: main ? await request(main, { type: 'world.snapshot' }).catch(() => undefined) : undefined };
    writeFileSync(path.join(output, 'failed-companion-face-encounter.json'), JSON.stringify(result, null, 2)); await testInfo.attach('face-encounter-failure', { body: JSON.stringify(result, null, 2), contentType: 'application/json' }); throw error;
  } finally { releaseDecision?.(); await application?.close().catch(() => undefined); await new Promise<void>(resolve => { server.close(() => resolve()); server.closeAllConnections(); }); cleanup(directory); }
});
