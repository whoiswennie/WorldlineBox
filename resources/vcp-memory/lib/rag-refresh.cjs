'use strict';
// Reuse the production VCP helper; this module supplies only staged loading and
// preservation of array metadata that cannot survive the helper's JSON clone.
const path = require('node:path');
function createRagRefresher(runtimeDirectory) {
  if (!runtimeDirectory) throw new TypeError('RAG refresh requires an isolated runtime directory');
  const original = require(path.join(path.resolve(runtimeDirectory), 'modules', 'chatCompletionHandler.js')).refreshRagBlocksIfNeeded;
  if (typeof original !== 'function') throw new Error('Original RAG refresh helper is unavailable');
  return async function refreshRagBlocksIfNeeded(messages, context, pluginManager, debugMode = false) {
    if (!Array.isArray(messages)) throw new TypeError('RAG refresh messages must be an array');
    const refreshed = await original(messages, context, pluginManager, debugMode);
    if (refreshed !== messages) {
      for (const key of Reflect.ownKeys(messages)) {
        if (typeof key === 'string' && /^(?:length|\d+)$/.test(key)) continue;
        if (!Object.hasOwn(refreshed, key)) Object.defineProperty(refreshed, key, Object.getOwnPropertyDescriptor(messages, key));
      }
    }
    return refreshed;
  };
}
module.exports = { createRagRefresher };
