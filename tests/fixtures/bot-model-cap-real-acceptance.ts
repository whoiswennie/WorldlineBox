import { app, safeStorage } from 'electron';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { resolveBotModelLimits } from '../../src/main/companion-bot/model-limits';
import { deepseekStructuredRequestDefaults, resolveStoredLlmConfig } from '../../src/shared/llm';
import { resolveOpenAiChatCompletionsUrl } from '../../src/shared/ai-endpoints';

const root = process.env.WORLDLINEBOX_BOT_REAL_ROOT!, source = process.env.WORLDLINEBOX_REAL_CHAT_CONFIG_ROOT!, output = process.env.WORLDLINEBOX_BOT_PEER_OUTPUT!;
if (!root || !source || !output || process.env.WORLDLINEBOX_BOT_PEER_REAL !== '1' || process.env.WORLDLINEBOX_BOT_PEER_MAX_POSTS !== '1') throw Error('Explicit one-request cap probe inputs required.');
app.setPath('userData', path.join(root, 'electron-profile')); app.disableHardwareAcceleration();
let secret = '';
const clean = (value: string) => value.replaceAll(secret || '\0', '<redacted>').replace(/Bearer\s+\S+/gi, 'Bearer <redacted>').replace(/(?<![A-Za-z0-9_-])sk-[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g, '<redacted>');
type Row = Record<string, unknown>;
const row = (value: unknown): Row => value && typeof value === 'object' && !Array.isArray(value) ? value as Row : {};

void app.whenReady().then(async () => {
  const report: Row = { kind: 'bot-peer-real-result', probe: 'one-real-provider-output-cap-request', passed: false,
    createdAt: new Date().toISOString(), maximumModelRequests: 1, modelRequests: 0, usesRealChatModel: true,
    boundary: 'Only the readonly configured model/key and actual model-limits resolver are used. No BotService, task, DSH, memory runtime, embedding model or configuration mutation.', errors: [] };
  const persist = () => writeFile(path.join(output, 'result.partial.json'), clean(JSON.stringify(report, null, 2)) + '\n');
  try {
    const profiles = JSON.parse(await readFile(path.join(source, 'ai-profiles.json'), 'utf8'));
    const profile = profiles.profiles.find((value: { id: string }) => value.id === profiles.activeProfileId);
    if (!profile || !/^ai_[a-f0-9]{24}$/.test(profile.id) || !safeStorage.isEncryptionAvailable()) throw Error('GLOBAL_MODEL_UNAVAILABLE');
    const model = resolveStoredLlmConfig(profile);
    if (model.apiFormat !== 'openai_chat' || model.model !== 'deepseek-flash' || new URL(model.baseUrl).origin !== 'https://api.deepseek.com') throw Error('EXPECTED_CONFIGURED_DEEPSEEK_FLASH_REQUIRED');
    secret = safeStorage.decryptString(await readFile(path.join(source, 'ai-profile-keys', profile.id + '.bin')));
    if (!secret || /[\r\n]/.test(secret)) throw Error('CONFIGURED_CREDENTIAL_UNAVAILABLE');
    const limits = resolveBotModelLimits(model);
    report.model = { model: model.model, endpointHost: new URL(model.baseUrl).host, apiFormat: model.apiFormat }; report.modelLimits = limits;
    if (limits.maxOutputTokens !== 393216 || limits.source !== 'official-default') throw Error('ACTUAL_RESOLVER_CAP_DIFFERS_FROM_REQUESTED_PROBE');
    const request = { model: model.model, stream: true, max_tokens: limits.maxOutputTokens,
      ...deepseekStructuredRequestDefaults(model.baseUrl, model.model), messages: [{ role: 'user', content: '只回复一个字：好' }] };
    report.request = request; report.endpoint = resolveOpenAiChatCompletionsUrl(model.baseUrl); await persist();
    report.modelRequests = 1;
    const started = performance.now();
    const response = await fetch(String(report.endpoint), { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(90000),
      headers: { 'content-type': 'application/json', accept: 'text/event-stream', authorization: `Bearer ${secret}` }, body: JSON.stringify(request) });
    report.httpStatus = response.status; report.headersMs = performance.now() - started; report.contentType = response.headers.get('content-type');
    const raw = await response.text(); report.rawResponse = clean(raw); report.elapsedMs = performance.now() - started;
    const packets = raw.split('\n').flatMap(line => { try { return line.startsWith('data: ') && line !== 'data: [DONE]' ? [row(JSON.parse(line.slice(6)))] : []; } catch { return []; } });
    const usages = packets.map(packet => packet.usage).filter(Boolean); report.actualProviderUsage = usages.at(-1);
    const choices = packets.flatMap(packet => Array.isArray(packet.choices) ? packet.choices.map(row) : []);
    report.responseText = choices.map(choice => row(choice.delta).content).filter(value => typeof value === 'string').join('');
    report.finishReasons = choices.map(choice => choice.finish_reason).filter(Boolean);
    report.checks = { oneProviderRequest: true, documentedCapUsedUnchanged: request.max_tokens === 393216,
      upstreamAcceptedCap: response.ok, completeResponse: choices.some(choice => choice.finish_reason === 'stop'), requestedShortReply: report.responseText === '好' };
    report.passed = Object.values(row(report.checks)).every(value => value === true);
  } catch (error) { (report.errors as Row[]).push({ name: error instanceof Error ? error.name : 'Error', message: clean(error instanceof Error ? error.message : String(error)) }); }
  finally {
    report.outcome = report.passed ? 'passed' : 'failed'; await persist();
    await new Promise<void>(resolve => { if (process.send) process.send(JSON.parse(clean(JSON.stringify(report))), () => resolve()); else resolve(); }); app.exit(report.passed ? 0 : 1);
  }
}).catch(() => { process.send?.({ kind: 'bot-peer-real-result', probe: 'one-real-provider-output-cap-request', passed: false, failedStage: 'electron-ready' }); app.exit(1); });
