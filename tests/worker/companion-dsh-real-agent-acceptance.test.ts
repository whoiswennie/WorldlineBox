import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { createNativeAcceptanceBroker } from '../helpers/companion-dsh-native-broker';
import { installedDshAcceptanceProgram, realDshAcceptanceRoute } from '../helpers/companion-dsh-real-route';
import type { DshTaskSpec } from '../../src/shared/dsh-task-spec';

const enabled = process.platform === 'win32' && process.env.WORLDLINEBOX_DSH_REAL_ACCEPTANCE === '1';
it.skipIf(!enabled)('runs simple, file-analysis, continuation and independent-review tasks on the installed real native Agent', async () => {
  const configRoot = await mkdtemp(path.join(os.tmpdir(), 'worldlinebox-dsh-account-'));
  const output = path.resolve(process.env.WORLDLINEBOX_DSH_REAL_RESULT ?? '.tools/test-output/companion-dsh-real-agent-acceptance.json');
  let apiKey = '', phase = 'route', test: Awaited<ReturnType<typeof createNativeAcceptanceBroker>> | undefined;
  const report: Record<string, unknown> = { createdAt: new Date().toISOString(), status: 'running', scope: 'real-model-native-agent-and-broker; scripted-role-division',
    autonomousCompanionCoordinationVerified: false, phases: [] };
  const phases = report.phases as Array<Record<string, unknown>>;
  const save = async () => { const text = JSON.stringify(report, null, 2); if (apiKey && text.includes(apiKey)) throw new Error('ACCEPTANCE_REPORT_CONTAINS_CREDENTIAL'); await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, text); };
  try {
    const route = await realDshAcceptanceRoute(configRoot); apiKey = route.apiKey;
    report.route = route.description;
    const program = await installedDshAcceptanceProgram();
    report.runtime = JSON.parse(await readFile(path.join(program, 'dsh/node_modules/@deepseek-ai/dsh/package.json'), 'utf8')).version;
    await save();
    console.log('Native acceptance non-sensitive route:', JSON.stringify({ ...route.description, runtime: report.runtime }));
    if (process.env.WORLDLINEBOX_DSH_ROUTE_ONLY === '1') { report.status = 'route-confirmed'; await save(); return; }
    test = await createNativeAcceptanceBroker({ program, apiKey, model: route.model, baseURL: route.baseURL });
    const active = test;
    const capture = async (label: string, workspace: string, names: string[]) => {
      const directory = path.join(path.dirname(output), path.basename(output, '.json') + '-files', label); await mkdir(directory, { recursive: true });
      for (const name of names) {
        const content = await readFile(path.join(workspace, name));
        if (content.includes(Buffer.from(apiKey))) throw new Error('ACCEPTANCE_DELIVERABLE_CONTAINS_CREDENTIAL');
        await writeFile(path.join(directory, name), content);
      }
      return directory;
    };
    const run = async (label: string, prompt: string, task: DshTaskSpec, companionId = 'native-acceptance') => {
      phase = label; const started = Date.now(), operation = active.operation(), generationBefore = await active.generation(), configBefore = await active.configurationSnapshot();
      const result = await active.broker.execute({ prompt, title: label, timeoutMs: 180000 }, operation,
        { ...active.execution, recordScope: { ...active.execution.recordScope!, companionId }, task });
      const session = active.broker.events(result.taskId).find(event => event.type === 'session');
      const overview = (await active.broker.readRecord({ recordId: result.taskId })).overview;
      const configAfter = await active.configurationSnapshot();
      phases.push({ phase: label, companionId, elapsedMs: Date.now() - started, sessionReadyMs: session ? Date.parse(session.receivedAt) - started : -1,
        pid: active.broker.state().find(record => record.id === result.taskId)?.pid, workerStarting: active.broker.events(result.taskId).find(event => event.stage === 'starting')?.summary,
        generationBefore, generationAfter: await active.generation(), configChanges: [...new Set([...Object.keys(configBefore), ...Object.keys(configAfter)])].filter(file => configBefore[file] !== configAfter[file]),
        taskId: result.taskId, sessionId: result.sessionId, workspacePath: result.workspacePath, status: overview.status,
        toolCalls: overview.toolCalls, turns: overview.turns, structured: result.structured, artifacts: result.artifacts?.map(artifact => path.basename(artifact.path)) });
      await save(); expect(overview.status).toBe('succeeded'); return result;
    };
    const simple = await run('simple', 'Compute 17 * 23 + 19. Return only JSON {"answer":NUMBER}.',
      { mode: 'native', tools: [], skills: [], delivery: { format: 'json' } });
    expect(simple.structured).toEqual({ answer: 410 });
    if (process.env.WORLDLINEBOX_DSH_SIMPLE_ONLY === '1') { report.status = 'simple-passed'; await save(); return; }
    const marker = randomUUID(); report.marker = marker;
    const first = await run('file-analysis', `Create ledger.csv with exactly this CSV:\nteam,month,cost,revenue\nA,2026-10,120,200\nB,2026-10,80,190\nA,2026-11,140,230\nB,2026-11,90,210\nRead the actual file and calculate total cost, revenue and profit plus profit per team. Write summary.json with {"marker":"${marker}","cost":NUMBER,"revenue":NUMBER,"profit":NUMBER,"teamProfit":{"A":NUMBER,"B":NUMBER}}. Write report.md explaining the calculation. Read the outputs to check them. Present summary.json and report.md. Return only JSON {"verified":true,"profit":NUMBER}.`,
      { mode: 'native', tools: ['write', 'read', 'present'], skills: [], delivery: { format: 'json' } });
    const summaryFile = path.join(first.workspacePath!, 'summary.json');
    expect(JSON.parse(await readFile(summaryFile, 'utf8'))).toEqual({ marker, cost: 430, revenue: 830, profit: 400, teamProfit: { A: 170, B: 230 } });
    expect(first.artifacts?.some(artifact => artifact.path === summaryFile)).toBe(true); expect(first.structured).toEqual({ verified: true, profit: 400 });
    report.analysisProofDirectory = await capture('analysis', first.workspacePath!, ['ledger.csv', 'summary.json', 'report.md']);
    const continued = await run('continued', 'Read ledger.csv. Append C,2026-11,50,125 exactly once. Recalculate summary.json (keep its marker, add C to teamProfit), update report.md, read the actual files to verify them, and present summary.json and report.md. Return only JSON {"revised":true,"profit":NUMBER}.',
      { session: { mode: 'resume', taskId: first.taskId }, delivery: { format: 'json' } });
    expect(continued.sessionId).toBe(first.sessionId); expect(continued.workspacePath).toBe(first.workspacePath);
    const updated = JSON.parse(await readFile(summaryFile, 'utf8'));
    expect(updated).toEqual({ marker, cost: 480, revenue: 955, profit: 475, teamProfit: { A: 170, B: 230, C: 75 } });
    expect((await readFile(path.join(first.workspacePath!, 'ledger.csv'), 'utf8')).match(/C,2026-11,50,125/g)).toHaveLength(1);
    expect(await readFile(path.join(first.workspacePath!, 'report.md'), 'utf8')).toContain('475');
    report.continuationProofDirectory = await capture('continued', first.workspacePath!, ['ledger.csv', 'summary.json', 'report.md']);
    const reviewer = await run('independent-review', `You are an independent auditor assigned by this acceptance script, not an autonomous companion team. Read ${JSON.stringify(path.join(first.workspacePath!, 'ledger.csv'))} and ${JSON.stringify(summaryFile)}. Independently recompute totals from CSV and compare the JSON. In your own workspace write review.json with {"sourceMarker":"${marker}","calculatedProfit":NUMBER,"matches":BOOLEAN,"errors":[]}, and review.md explaining the independent calculation and source paths. Read your files back and present them. Return JSON {"audited":true,"profit":NUMBER}.`,
      { mode: 'native', tools: ['write', 'read', 'present'], skills: [], delivery: { format: 'json' } }, 'native-reviewer');
    expect(reviewer.sessionId).not.toBe(first.sessionId); expect(reviewer.workspacePath).not.toBe(first.workspacePath);
    expect(JSON.parse(await readFile(path.join(reviewer.workspacePath!, 'review.json'), 'utf8'))).toEqual({ sourceMarker: marker, calculatedProfit: 475, matches: true, errors: [] });
    expect(await readFile(path.join(reviewer.workspacePath!, 'review.md'), 'utf8')).toContain('475');
    report.reviewProofDirectory = await capture('review', reviewer.workspacePath!, ['review.json', 'review.md']);
    expect((await active.broker.readRecord({ recordId: continued.taskId })).overview).toMatchObject({ sessionId: first.sessionId, artifacts: continued.artifacts, structured: { revised: true, profit: 475 } });
    report.status = 'passed'; report.functionalChecksPassed = true; report.hostVerifiedChecks = ['simple arithmetic', 'CSV-derived totals', 'same-session continuation', 'no duplicated appended row', 'independent companion directory', 'independent recomputation', 'existing presented files', 'valid JSON receipts'];
    const warmLimit = Number(process.env.WORLDLINEBOX_DSH_WARM_START_MAX_MS);
    phase = 'warm-start-performance';
    if (warmLimit > 0) expect(phases[2]!.sessionReadyMs).toBeLessThanOrEqual(warmLimit);
    await save(); console.log('Native acceptance result (no credentials):', JSON.stringify({ output, phases, status: report.status }));
  } catch (error) {
    report.status = 'failed'; report.failedPhase = phase;
    report.error = error instanceof Error ? error.message.replaceAll(apiKey || '___NO_KEY___', '[redacted]').slice(0, 1000) : 'Unknown acceptance error';
    await save(); throw error;
  } finally { await test?.dispose(); apiKey = ''; await rm(configRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
}, 900000);
