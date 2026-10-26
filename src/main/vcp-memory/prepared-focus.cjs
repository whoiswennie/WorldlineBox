/* global require, module, fetch */
'use strict';

const path = require('node:path');
const { createHash } = require('node:crypto');
const { createRagQueryClock, recallModelIdentity: modelIdentity } = require('./peripherals.cjs');

/** Runs the byte-identical upstream sourceFiles handler without a KB/runtime.
 * Only axios transport is adapted for host cancellation, quota and revocation.
 * Prompts, candidate sorting, batching, extraction and merging stay upstream. */
async function focusPreparedRecall(payload, configuration, options = {}) {
  if (payload?.schema !== 'worldlinebox.prepared-recall-payload' || !Array.isArray(payload.groups) || !payload.receipt)
    throw new Error('Invalid prepared recall payload.');
  const chat = configuration.chat;
  if (payload.modelIdentity !== modelIdentity(chat)) throw new Error('Prepared recall model route has changed.');
  const assertCurrent = async (reason = 'fence') => { options.signal?.throwIfAborted(); await options.validate?.(reason); options.signal?.throwIfAborted(); };
  await assertCurrent();
  if (!payload.groups.length) return structuredClone(payload.receipt);
  if (!chat?.baseUrl || !chat.model || !chat.apiKey) throw new Error('Prepared focusing model is unavailable.');
  let guardedFailure;
  const axios = { post: async (url, body, requestOptions) => {
    try { await assertCurrent(); } catch (error) { guardedFailure = error; throw error; }
    const timeout = AbortSignal.timeout(requestOptions?.timeout || 120000);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const operation = async () => {
      await assertCurrent('model_admission');
      let response, raw;
      try { response = await (options.fetchFn || fetch)(url, { method: 'POST', headers: requestOptions.headers,
        body: JSON.stringify(body), signal });
        raw = await response.text();
      }
      catch (error) {
        if (timeout.aborted && !options.signal?.aborted) throw Object.assign(new Error('Focusing request timed out.'), { code: 'ECONNABORTED' });
        throw error;
      }
      // Match axios' default response transform: non-JSON error bodies still
      // carry HTTP status, so upstream 500/503 retry policy remains intact.
      let data; try { data = JSON.parse(raw); } catch { data = raw; }
      if (!response.ok) throw Object.assign(new Error('Focusing provider rejected the request.'), { response: { status: response.status, data } });
      return { data };
    };
    try { return await (options.runModel ? options.runModel(operation) : operation()); }
    catch (error) { if (options.signal?.aborted) guardedFailure = options.signal.reason || error; throw error; }
  } };
  const clock = createRagQueryClock({ axios });
  const Handler = clock.load(path.join(configuration.vendorRoot, 'Plugin/RAGDiaryPlugin/AIMemoHandler.js'));
  const events = [], values = new Map();
  const cacheValues = new Map();
  const cache = { generateKey: value => createHash('sha256').update(JSON.stringify(value)).digest('hex'),
    get: (_name, key) => cacheValues.get(key), set: (_name, key, value) => cacheValues.set(key, value) };
  await clock.run(payload.receipt.queryClock, async () => {
    for (const group of payload.groups) {
      await assertCurrent();
      if (!Array.isArray(group.options?.sourceFiles) || group.config?.model !== chat.model || typeof group.promptTemplate !== 'string')
        throw new Error('Prepared focusing inputs have changed.');
      const handler = new Handler({ pushVcpInfo: event => events.push(event) }, cache);
      handler.config = { ...group.config, url: chat.baseUrl.replace(/\/+$/u, '').replace(/\/v1$/u, '') + '/', apiKey: chat.apiKey };
      handler.promptTemplate = group.promptTemplate;
      const value = await handler.processAIMemoPlusAggregated(group.dbNames, group.userContent, group.aiContent,
        group.combinedQueryForDisplay, null, group.options);
      if (guardedFailure) throw guardedFailure;
      await assertCurrent();
      if (typeof value !== 'string' || /\[AIMemo[^\]\n]*(?:失败|未配置)|\[AI模型调用失败\]/u.test(value))
        throw new Error('Prepared memory focusing did not complete.');
      values.set(group.token, value);
    }
  });
  const receipt = structuredClone(payload.receipt);
  // One replacement pass: generated text is data, never a subsequent template.
  const pattern = /WORLDLINE_PREPARED_FOCUS_[a-f0-9]{32}/gu;
  receipt.messages = receipt.messages.map(message => ({ ...message,
    content: typeof message.content === 'string' ? message.content.replace(pattern, token => {
      if (!values.has(token)) throw new Error('Prepared recall contains an unknown focus placeholder.');
      return values.get(token);
    }) : message.content }));
  receipt.events.push(...events);
  await assertCurrent('publication');
  return receipt;
}

module.exports = { focusPreparedRecall, modelIdentity };
