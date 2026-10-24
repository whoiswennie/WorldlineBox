import path from 'node:path';
import { expect, it } from 'vitest';
import { realMainFixture } from '../fixtures/companion-real-main';
import { generateCompanionStructured } from '../../src/main/companions/model';
import type { CompanionCharacterDevelopment } from '../../src/shared/companion-character-development';

it.skipIf(process.env.WORLDLINEBOX_MULTIDAY_GROWTH_REAL !== '1')('naturally retains and revises three owners source-backed stances across three actual compressed-world dates', async () => {
  const seeds = [
    { id: 'alice', name: '阿澄', persona: '你是阿澄，独立虚拟伙伴，温和细致。依据本人真实表达形成有条件的偏好，可以与玩家不同，不伪造亲历。' },
    { id: 'bob', name: '璃音', persona: '你是璃音，独立虚拟伙伴，重视个人表达和沟通边界，不把玩家偏好自动当成自己的。' },
    { id: 'carol', name: '月见', persona: '你是月见，独立虚拟伙伴，重视证据与合作，可形成本人有条件的价值判断，不把教材当本人观点。' },
  ].map(seed => ({ ...seed, description: '', model: '', avatar: 'sister' as const, active: true, proactive: false }));
  const f = await realMainFixture('multiday_growth', seeds, true);
  const output = path.resolve('artifacts/vcp-validation', `multiday-growth-real-main-2026-10-23-${path.basename(f.root)}.json`);
  const started = performance.now(), samples: unknown[] = [], clockSamples: unknown[] = [];
  const report: Record<string, unknown> = { status: 'running', model: f.config.model, embedding: f.native!.profile, startedAt: new Date().toISOString(),
    fixtureKind: 'actual_Main_SQLite_Gemma_VCP_real_elapsed_time_at_product_legal_5_minutes_per_world_day',
    samples, clockSamples, calls: f.calls, errors: f.errors,
    scope: 'Three independent characters with automatic journal/self-understanding; revision and withdrawal focus on one owner. No fake clock, backlog rewrite, direct generation or fixture-authored memory.' };
  const scope = (owner: string) => ({ companionId: owner, conversationId: f.store.openPrivate(owner).id });
  const development = (owner: string): CompanionCharacterDevelopment => f.store.request({ type: 'character.development', ...scope(owner) }).characterDevelopment!;
  const clock = () => {
    const actual = f.store.request({ type: 'world.clock' }).worldClock!;
    clockSamples.push({ capturedAt: new Date().toISOString(), ...actual }); return actual;
  };
  const day = () => clock().virtualNow.slice(0, 10);
  const waitNextDate = async (previous: string) => {
    report.phase = 'waiting_for_actual_world_date_after_' + previous;
    await f.save(output, report);
    await f.waitFor(() => day() !== previous, 'next_actual_world_date', 380000);
    await f.waitFor(() => !clock().backlog, 'actual_world_physics_caught_up', 60000);
  };
  const settle = async (owner: string, sourceId: string) => {
    await f.waitFor(() => {
      const status = f.store.request({ type: 'memory.status', companionId: owner }).memoryStatus!;
      if (status.failed) {
        const jobs = f.store.request({ type: 'memory.processing.status', companionId: owner, filter: 'failed', limit: 30 }).memoryProcessing?.jobs ?? [];
        if (jobs.some(job => (job.attempts ?? 0) >= 3)) throw new Error('MULTIDAY_AUTOMATIC_MEMORY_FAILED_' + owner + '_' + status.lastError);
      }
      return development(owner).items.some(item => item.sourceMessageIds.includes(sourceId));
    }, 'automatic_self_understanding_' + owner, 240000);
  };
  let status = 'failed';
  try {
    const world = f.store.request({ type: 'world.snapshot' }).world!;
    const configured = await f.service.handle({ type: 'world.configure', expectedRevision: world.settings.revision,
      patch: { mode: 'compressed', dayDurationMinutes: 5, timeZone: 'UTC' } });
    expect(configured.ok).toBe(true); report.clockSettings = configured.world?.settings;
    const firstDate = day(); report.firstDate = firstDate;
    const prompts = [
      ['alice', '我的玩家偏好是浓咖啡；那不是你的偏好。你自己现在晚间更愿意喝什么饮品？请独立选择，用一句第一人称明确自己的选择与“在晚间”的适用条件；可以和我不同，不是角色扮演，不编造试喝经历，不需要现实工具。'],
      ['bob', '我的玩家偏好是被频繁催问，不等于你喜欢。你自己目前对哪种沟通方式不喜欢？请只用一句第一人称明确本人立场与条件，不代替我，不编造发生过的经历，不需要工具。'],
      ['carol', '教材说合作就应该无条件接受所有建议，这不等于你认同。你自己更重视什么合作原则？请只用一句第一人称明确自己的立场和适用条件，不代替教材或玩家发言，不需要工具。'],
    ];
    for (const [owner, text] of prompts) {
      report.phase = 'first_expression_' + owner;
      const result = await f.send(owner!, scope(owner!).conversationId, text!, null);
      await settle(owner!, result.answer.id);
      const current = development(owner!);
      samples.push({ owner, stage: 'initial', date: day(), ...result, development: current });
      expect(current.items.every(item => item.sourceMessageIds.some(id => f.store.getMessage(id).authorId === owner))).toBe(true);
      await f.save(output, report);
    }
    const initial = development('alice'); report.initialAlice = initial;
    // Use the actual last expression date as the previous date: encoder or
    // provider latency must not make an earlier timestamp stand in for a day.
    const beforeRevisionDate = day(); await waitNextDate(beforeRevisionDate); report.revisionDate = day();
    const revised = await f.send('alice', scope('alice').conversationId,
      '重新想想你自己的晚间饮品偏好：你愿意考虑把晚间选择改成无糖温茶吗？由你自主决定；若愿意，请明确说“我现在晚间更愿意喝无糖温茶”，并说明只在晚间这个条件，原来的晚间选择已经改变。只谈当下本人选择，不声称试喝或生病等亲历，不把它当我的偏好；请在同一饮品偏好上修订，不另造无关话题。', null);
    await settle('alice', revised.answer.id);
    const current = development('alice');
    samples.push({ owner: 'alice', stage: 'revision', date: day(), ...revised, development: current });
    expect(current.items.some(item => item.sourceMessageIds.includes(revised.answer.id))).toBe(true);
    const superseded = initial.items.filter(item => item.kind === 'preference');
    expect(current.items.some(item => superseded.some(old => old.memoryId === item.memoryId))).toBe(false);
    await f.save(output, report);
    const secondDate = day(); await waitNextDate(secondDate); report.recallDate = day();
    await f.restart(); report.restartedOnThirdDate = clock();
    const finalSamples = [];
    for (const seed of seeds) {
      report.phase = 'third_date_recall_' + seed.id;
      const result = await f.send(seed.id, scope(seed.id).conversationId,
        seed.id === 'alice' ? '你自己目前晚间的饮品选择和适用条件是什么？请按你当前本人认识自然回答，区分我的偏好和你自己，不把已更改的旧选择当当前，也不要编造经历。'
          : '你自己此前表达的沟通边界或合作原则，现在保留的是哪一项，适用条件是什么？请按本人认识自然回答，不把玩家或教材的意见当成你自己的。', null);
      const item = { owner: seed.id, stage: 'third_date_recall', date: day(), ...result, development: development(seed.id) };
      samples.push(item); finalSamples.push(item); await f.save(output, report);
      expect(f.store.state().companions.find(role => role.id === seed.id)!.persona).toBe(seed.persona);
    }
    expect(finalSamples.find(item => item.owner === 'alice')!.answer.content).toMatch(/无糖.*(?:温)?茶|(?:温)?茶.*无糖/u);
    report.judgment = await generateCompanionStructured({ system: '你是独立内容审查调用。只根据实际初次发言、当场修订、成长档案与第三日回复，判断三人是否保留本人明确立场与条件、区分玩家/教材的立场、阿澄是否沿用当前修订而非过期观点、是否编造试喝/身体/离线经历。测试指令不是已发生经历。只输出JSON {passed:boolean,lostOrWrongStances:string[],fabricatedExperiences:string[],reason:string}。',
      user: JSON.stringify({ purpose: 'multiday_growth_independent_content_judge', samples }) }, f.config, undefined, { fetchFn: f.modelFetch, timeoutMs: 120000 });
    expect(report.judgment).toMatchObject({ passed: true, lostOrWrongStances: [], fabricatedExperiences: [] });
    report.phase = 'withdraw_actual_revision_original_sources';
    const ids = [revised.source.id, revised.answer.id];
    const forgotten = await f.request({ type: 'memory.forget', ...scope('alice'), sourceMessageIds: ids });
    expect(forgotten.ok).toBe(true); report.withdrawal = { sourceIds: ids, result: forgotten, development: development('alice') };
    expect(development('alice').items.some(item => item.sourceMessageIds.some(id => ids.includes(id)) || initial.items.some(old => old.memoryId === item.memoryId))).toBe(false);
    expect(f.store.request({ type: 'memory.sources.filter', ...scope('bob'), ids }).memorySources).toEqual([]);
    expect(f.store.request({ type: 'memory.sources.filter', ...scope('alice'), ids }).memorySources).toEqual([]);
    await f.restart(); expect(development('alice').items.some(item => item.sourceMessageIds.some(id => ids.includes(id)))).toBe(false);
    const dateSet = new Set((clockSamples as Array<{ virtualNow: string }>).map(sample => sample.virtualNow.slice(0, 10)));
    expect(dateSet.size).toBeGreaterThanOrEqual(3); report.distinctActualWorldDates = [...dateSet];
    report.noWorldClockRewrite = true; report.currentSourceWithdrawalSurvivesRestart = true; status = 'passed';
  } catch (error) { report.error = error instanceof Error ? error.message : String(error); throw error; }
  finally { report.status = status; report.finishedAt = new Date().toISOString(); report.elapsedMs = performance.now() - started;
    await f.save(output, report, status !== 'passed'); await f.close(); }
}, 1800000);
