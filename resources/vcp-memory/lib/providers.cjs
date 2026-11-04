'use strict';

const http = require('node:http');
const crypto = require('node:crypto');
const { performance } = require('node:perf_hooks');

const DEFAULT_CHAT_URL = 'https://api.deepseek.com';
const DEFAULT_CHAT_MODEL = 'deepseek-flash';
const APIS = ['openai-completions', 'anthropic-messages', 'google-generative-ai'];

class ProviderError extends Error {
    constructor(message, code, status = 400) { super(message); this.code = code; this.status = status; }
}

function value(...values) { return values.find(item => item !== undefined && item !== null && item !== ''); }
function object(value, label) {
    if (value === undefined || value === null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new ProviderError(`${label} must be an object`, 'INVALID_CONFIG');
    return value;
}
function apiName(api) {
    const aliases = { 'openai-compatible': 'openai-completions', openai: 'openai-completions', anthropic: 'anthropic-messages', gemini: 'google-generative-ai' };
    return aliases[api] || api;
}
function validUrl(input, label) {
    let url;
    try { url = new URL(input); }
    catch { throw new ProviderError(`${label} must be an absolute HTTP(S) URL`, 'INVALID_CONFIG'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new ProviderError(`${label} must be HTTP(S), without URL credentials, query or fragment`, 'INVALID_CONFIG');
    }
    return url.href.replace(/\/+$/, '');
}
function integer(input, fallback, label, min = 1, max = 2147483647) {
    const number = input === undefined ? fallback : Number(input);
    if (!Number.isSafeInteger(number) || number < min || number > max) throw new ProviderError(`${label} must be an integer from ${min} to ${max}`, 'INVALID_CONFIG');
    return number;
}

/** Resolve independent routes once at startup; no credentials are read from disk. */
function resolveProviders(config = {}) {
    const chatConfig = object(config.chat, 'chat');
    const embeddingConfig = object(config.embedding, 'embedding');
    const legacyUrl = value(config.API_URL);
    const legacyKey = value(config.API_Key, config.API_KEY);
    const chatURL = validUrl(value(chatConfig.baseURL, config.CHAT_API_URL, legacyUrl, DEFAULT_CHAT_URL), 'CHAT_API_URL');
    const chatApi = apiName(value(chatConfig.api, config.CHAT_API_TYPE, 'openai-completions'));
    if (!APIS.includes(chatApi)) throw new ProviderError(`Unsupported chat API "${chatApi}"; supported: ${APIS.join(', ')}`, 'UNSUPPORTED_API');
    const explicitChat = Boolean(config.chat || config.CHAT_API_URL || config.CHAT_API_KEY || config.CHAT_MODEL || config.CHAT_API_TYPE);
    const legacyEmbedding = !explicitChat && legacyUrl && new URL(legacyUrl).hostname !== 'api.deepseek.com';
    const embeddingURL = value(embeddingConfig.baseURL, config.EMBEDDING_API_URL, legacyEmbedding ? legacyUrl : undefined);
    const embeddingQueryURL = value(embeddingConfig.queryBaseURL, config.EMBEDDING_QUERY_API_URL, embeddingURL);
    const embeddingApi = apiName(value(embeddingConfig.api, config.EMBEDDING_API_TYPE, 'openai-completions'));
    if (embeddingURL && !['openai-completions', 'openai-embeddings'].includes(embeddingApi)) {
        throw new ProviderError('Embedding requires an OpenAI-compatible /v1/embeddings endpoint', 'UNSUPPORTED_API');
    }
    const route = (source, prefix, baseURL, api, key, model) => {
        const headers = object(value(source.headers, config[`${prefix}_HEADERS`]), `${prefix}_HEADERS`);
        try { new Headers(headers); } catch { throw new ProviderError(`${prefix}_HEADERS contains an invalid HTTP header`, 'INVALID_CONFIG'); }
        const compat = object(value(source.compat, config[`${prefix}_COMPAT`]), `${prefix}_COMPAT`);
        const supportedCompat = ['supportsDeveloperRole', 'maxTokensField', 'thinkingFormat'];
        for (const field of Object.keys(compat)) {
            if (!supportedCompat.includes(field) || api !== 'openai-completions') throw new ProviderError(`Unsupported ${api} compat field: ${field}`, 'UNSUPPORTED_OPTION');
        }
        if (compat.supportsDeveloperRole !== undefined && typeof compat.supportsDeveloperRole !== 'boolean') throw new ProviderError('supportsDeveloperRole must be boolean', 'INVALID_CONFIG');
        if (compat.maxTokensField !== undefined && !['max_tokens', 'max_completion_tokens'].includes(compat.maxTokensField)) throw new ProviderError('maxTokensField must be max_tokens or max_completion_tokens', 'INVALID_CONFIG');
        if (compat.thinkingFormat !== undefined && compat.thinkingFormat !== 'deepseek') throw new ProviderError('Only thinkingFormat: deepseek is supported', 'INVALID_CONFIG');
        return {
            api, baseURL: baseURL ? validUrl(baseURL, `${prefix}_API_URL`) : null,
            key: key || '', model: model || null, headers: { ...headers }, compat: { ...compat },
            timeoutMs: integer(value(source.timeoutMs, config[`${prefix}_TIMEOUT_MS`], config.PROVIDER_TIMEOUT_MS), 180000, `${prefix}_TIMEOUT_MS`),
            maxTokens: integer(value(source.maxTokens, config[`${prefix}_MAX_TOKENS`]), 8192, `${prefix}_MAX_TOKENS`),
        };
    };
    const embedding = route(embeddingConfig, 'EMBEDDING', embeddingURL, embeddingApi,
        value(embeddingConfig.apiKey, config.EMBEDDING_API_KEY, legacyEmbedding ? legacyKey : undefined),
        value(embeddingConfig.model, config.EMBEDDING_MODEL, config.EmbeddingModel));
    return {
        chat: route(chatConfig, 'CHAT', chatURL, chatApi,
            value(chatConfig.apiKey, config.CHAT_API_KEY, legacyKey),
            value(chatConfig.model, config.CHAT_MODEL, DEFAULT_CHAT_MODEL)),
        embedding,
        embeddingQuery: { ...embedding, baseURL: embeddingQueryURL ? validUrl(embeddingQueryURL, 'EMBEDDING_QUERY_API_URL') : null },
        maxBodyBytes: integer(config.PROVIDER_MAX_BODY_BYTES, 33554432, 'PROVIDER_MAX_BODY_BYTES'),
    };
}

function endpoint(baseURL, resource) {
    const url = new URL(baseURL);
    let pathname = url.pathname.replace(/\/+$/, '');
    pathname = pathname.replace(/\/(?:chat\/completions|embeddings|messages)$/, '');
    if (!/\/v\d+(?:beta\d*)?$/.test(pathname)) pathname += '/v1';
    url.pathname = pathname + '/' + resource;
    return url.href;
}

function textContent(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content) && content.every(part => ['text', 'input_text', 'output_text'].includes(part?.type) && typeof part.text === 'string')) {
        return content.map(part => part.text).join('\n');
    }
    throw new ProviderError('This protocol adapter supports text/system memory summarization only; non-text content requires an OpenAI-compatible route', 'UNSUPPORTED_CONTENT');
}

function summaryInput(body) {
    const allowed = new Set(['model', 'messages', 'stream', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'requestId']);
    for (const key of Object.keys(body)) if (!allowed.has(key)) throw new ProviderError(`Unsupported summary adapter field: ${key}`, 'UNSUPPORTED_OPTION');
    const system = [], messages = [];
    for (const message of body.messages) {
        for (const key of Object.keys(message)) if (!['role', 'content'].includes(key)) throw new ProviderError(`Unsupported summary message field: ${key}`, 'UNSUPPORTED_OPTION');
        if (!['system', 'developer', 'user', 'assistant'].includes(message.role)) throw new ProviderError(`Unsupported summary role: ${message.role}`, 'UNSUPPORTED_CONTENT');
        const content = textContent(message.content);
        if (['system', 'developer'].includes(message.role)) system.push(content);
        else messages.push({ role: message.role, content });
    }
    if (!messages.length) throw new ProviderError('At least one user/assistant message is required', 'INVALID_REQUEST');
    return { system: system.join('\n\n'), messages };
}

function serializeChat(body, route) {
    if (!Array.isArray(body.messages) || !body.messages.length) throw new ProviderError('messages must be a nonempty array', 'INVALID_REQUEST');
    const model = route.model || body.model;
    if (!model) throw new ProviderError('A chat model is required', 'MISSING_MODEL');
    const headers = new Headers(route.headers);
    headers.set('Content-Type', 'application/json');
    if (route.api === 'openai-completions') {
        const request = { ...body, model, stream: false };
        delete request.requestId;
        if (route.key) headers.set('Authorization', `Bearer ${route.key}`);
        if (route.compat.supportsDeveloperRole === false) request.messages = request.messages.map(message => message.role === 'developer' ? { ...message, role: 'system' } : message);
        if (route.compat.maxTokensField) {
            const limit = value(request.max_completion_tokens, request.max_tokens);
            delete request.max_completion_tokens; delete request.max_tokens;
            if (limit !== undefined) request[route.compat.maxTokensField] = limit;
        }
        if (route.compat.thinkingFormat === 'deepseek' && request.reasoning_effort !== undefined) {
            const off = request.reasoning_effort === 'off';
            request.thinking = { type: off ? 'disabled' : 'enabled' };
            if (off) delete request.reasoning_effort;
        }
        return { url: endpoint(route.baseURL, 'chat/completions'), headers, body: request };
    }
    const { system, messages } = summaryInput(body);
    const maxTokens = value(body.max_completion_tokens, body.max_tokens, route.maxTokens);
    if (route.api === 'anthropic-messages') {
        if (route.key) headers.set('x-api-key', route.key);
        if (!headers.has('anthropic-version')) headers.set('anthropic-version', '2023-06-01');
        return {
            url: endpoint(route.baseURL, 'messages'), headers,
            body: {
                model, messages, ...(system ? { system } : {}), max_tokens: maxTokens, stream: false,
                ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
                ...(body.top_p !== undefined ? { top_p: body.top_p } : {}),
                ...(body.stop !== undefined ? { stop_sequences: typeof body.stop === 'string' ? [body.stop] : body.stop } : {}),
            },
        };
    }
    if (route.key) headers.set('x-goog-api-key', route.key);
    const url = new URL(route.baseURL);
    let basePath = url.pathname.replace(/\/+$/, '');
    basePath = basePath.replace(/\/models\/[^/]+:generateContent$/, '');
    if (!/\/v\d+(?:beta\d*)?$/.test(basePath)) basePath += '/v1beta';
    const modelId = model.replace(/^models\//, '');
    url.pathname = `${basePath}/models/${encodeURIComponent(modelId)}:generateContent`;
    return {
        url: url.href, headers,
        body: {
            contents: messages.map(message => ({ role: message.role === 'assistant' ? 'model' : 'user', parts: [{ text: message.content }] })),
            ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
            generationConfig: {
                maxOutputTokens: maxTokens,
                ...(body.temperature !== undefined ? { temperature: body.temperature } : {}),
                ...(body.top_p !== undefined ? { topP: body.top_p } : {}),
                ...(body.stop !== undefined ? { stopSequences: typeof body.stop === 'string' ? [body.stop] : body.stop } : {}),
            },
        },
    };
}

function normalizedChat(data, route) {
    if (route.api === 'openai-completions') {
        if (!Array.isArray(data.choices) || !data.choices[0]?.message) throw new ProviderError('Upstream returned no chat choices', 'INVALID_UPSTREAM_RESPONSE', 502);
        return data;
    }
    let content, finishReason, usage;
    if (route.api === 'anthropic-messages') {
        if (!Array.isArray(data.content)) throw new ProviderError('Upstream returned no Messages content', 'INVALID_UPSTREAM_RESPONSE', 502);
        content = data.content.filter(part => part.type === 'text').map(part => part.text).join('');
        finishReason = data.stop_reason === 'max_tokens' ? 'length' : 'stop';
        usage = { prompt_tokens: data.usage?.input_tokens || 0, completion_tokens: data.usage?.output_tokens || 0 };
    } else {
        const candidate = data.candidates?.[0];
        if (!candidate?.content?.parts) throw new ProviderError('Gemini returned no candidate text (possibly blocked)', 'INVALID_UPSTREAM_RESPONSE', 502);
        content = candidate.content.parts.filter(part => typeof part.text === 'string' && !part.thought).map(part => part.text).join('');
        finishReason = candidate.finishReason === 'MAX_TOKENS' ? 'length' : 'stop';
        usage = { prompt_tokens: data.usageMetadata?.promptTokenCount || 0, completion_tokens: data.usageMetadata?.candidatesTokenCount || 0 };
    }
    usage.total_tokens = usage.prompt_tokens + usage.completion_tokens;
    return {
        id: data.id || data.responseId || `memory-${crypto.randomUUID()}`, object: 'chat.completion',
        created: Math.floor(Date.now() / 1000), model: data.model || data.modelVersion || route.model,
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: finishReason }], usage,
    };
}

async function readJSON(stream, maxBytes, textError = false) {
    const chunks = []; let bytes = 0;
    // Do not destroy IncomingMessage when rejecting an oversized request;
    // the authenticated caller must still receive a structured HTTP 413.
    const iterator = typeof stream.iterator === 'function' ? stream.iterator({ destroyOnReturn: false }) : stream;
    for await (const chunk of iterator) {
        bytes += chunk.length;
        if (bytes > maxBytes) throw new ProviderError('Provider JSON body exceeds configured byte limit', 'BODY_TOO_LARGE', 413);
        chunks.push(Buffer.from(chunk));
    }
    const text = Buffer.concat(chunks).toString('utf8');
    try { return JSON.parse(text); }
    catch {
        if (textError) return { error: { message: text } };
        throw new ProviderError('Provider body is not valid JSON', 'INVALID_JSON', 400);
    }
}

function redact(message, secrets) {
    let result = String(message);
    for (const secret of secrets) if (secret) result = result.split(secret).join('[REDACTED]');
    return result.slice(0, 1500);
}

/**
 * Loopback OpenAI transport facade for unchanged VCP algorithms. Only the two
 * memory-system endpoints exist; each upstream operation is attempted once.
 */
async function startProviderRouter(config = {}) {
    const resolved = resolveProviders(config);
    const key = crypto.randomBytes(32).toString('hex');
    const controllers = new Set();
    const diagnostics = [];
    let diagnosticEpoch = 0;
    const secrets = [key, resolved.chat.key, resolved.embedding.key, ...Object.values(resolved.chat.headers), ...Object.values(resolved.embedding.headers)];
    const send = (res, status, data) => {
        if (!res.destroyed) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
    };
    const server = http.createServer(async (req, res) => {
        let controller;
        let attempt;
        try {
            const presented = String(req.headers.authorization || '');
            const expected = `Bearer ${key}`;
            const presentedBytes = Buffer.from(presented), expectedBytes = Buffer.from(expected);
            if (presentedBytes.length !== expectedBytes.length || !crypto.timingSafeEqual(presentedBytes, expectedBytes)) {
                throw new ProviderError('Invalid local provider authorization', 'UNAUTHORIZED', 401);
            }
            if (req.method !== 'POST' || !['/v1/chat/completions', '/query/v1/chat/completions', '/v1/embeddings', '/query/v1/embeddings'].includes(req.url)) throw new ProviderError('Unknown provider route', 'NOT_FOUND', 404);
            const body = await readJSON(req, resolved.maxBodyBytes);
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ProviderError('Request must be a JSON object', 'INVALID_REQUEST');
            if (body.stream === true) throw new ProviderError('Memory provider router supports non-stream requests only', 'UNSUPPORTED_OPTION');
            const embedding = req.url.endsWith('/embeddings');
            const route = req.url === '/query/v1/embeddings' ? resolved.embeddingQuery : embedding ? resolved.embedding : resolved.chat;
            if (!route.baseURL) throw new ProviderError('Embedding provider is not configured. DeepSeek does not supply this route; set EMBEDDING_API_URL and EMBEDDING_MODEL for a local or remote embedding provider.', 'MISSING_EMBEDDING_PROVIDER', 503);
            let upstream;
            if (embedding) {
                if (body.input === undefined) throw new ProviderError('Embedding input is required', 'INVALID_REQUEST');
                const headers = new Headers(route.headers);
                headers.set('Content-Type', 'application/json');
                if (route.key) headers.set('Authorization', `Bearer ${route.key}`);
                const model = route.model || body.model;
                if (!model) throw new ProviderError('EMBEDDING_MODEL or an input model is required', 'MISSING_MODEL');
                upstream = { url: endpoint(route.baseURL, 'embeddings'), headers, body: { ...body, model } };
            } else upstream = serializeChat(body, route);
            attempt = {
                epoch: diagnosticEpoch,
                record: {
                    source: 'provider-http',
                    endpointType: embedding ? (req.url.startsWith('/query/') ? 'embedding-query' : 'embedding-document') : 'chat-completions',
                    api: embedding ? 'openai-embeddings' : route.api,
                    model: upstream.body.model || route.model,
                    status: null, outcome: 'pending',
                    hostTiming: { startedAtMs: performance.now() },
                },
            };
            controller = new AbortController(); controllers.add(controller);
            const timer = setTimeout(() => controller.abort(new Error('timeout')), route.timeoutMs);
            timer.unref();
            res.once('close', () => { if (!res.writableEnded) controller.abort(new Error('client closed')); });
            let response, data;
            try {
                response = await fetch(upstream.url, { method: 'POST', headers: upstream.headers, body: JSON.stringify(upstream.body), signal: controller.signal, redirect: 'error' });
                attempt.record.status = response.status;
                data = await readJSON(response.body, resolved.maxBodyBytes, !response.ok);
            } catch (error) {
                if (controller.signal.aborted) throw new ProviderError('Provider request timed out or was cancelled', 'TIMEOUT', 504);
                if (error instanceof ProviderError) throw new ProviderError(error.message, error.code, 502);
                throw new ProviderError('Could not reach configured provider', 'TRANSPORT_ERROR', 502);
            } finally { clearTimeout(timer); }
            if (!data || typeof data !== 'object' || Array.isArray(data)) throw new ProviderError('Upstream response must be a JSON object', 'INVALID_UPSTREAM_RESPONSE', 502);
            if (data.model) attempt.record.model = data.model;
            else if (data.modelVersion) attempt.record.model = data.modelVersion;
            if (data.usage !== undefined) attempt.record.usage = structuredClone(data.usage);
            if (data.usageMetadata !== undefined) attempt.record.usageMetadata = structuredClone(data.usageMetadata);
            if (!response.ok || data.error) {
                const detail = typeof data.error === 'string' ? data.error : data.error?.message || data.message || response.statusText;
                throw new ProviderError(`Upstream provider returned HTTP ${response.status}: ${redact(detail, secrets)}`, 'UPSTREAM_ERROR', response.ok ? 502 : response.status);
            }
            if (embedding) {
                if (!Array.isArray(data.data) || !data.data.length || data.data.some(row => !Array.isArray(row.embedding) || !row.embedding.length || row.embedding.some(number => !Number.isFinite(number)))) {
                    throw new ProviderError('Embedding provider returned no finite embedding vectors', 'INVALID_UPSTREAM_RESPONSE', 502);
                }
                attempt.record.embeddingCount = data.data.length;
                attempt.record.embeddingDimensions = data.data.map(row => row.embedding.length);
                send(res, 200, data);
            } else send(res, 200, normalizedChat(data, route));
            attempt.record.outcome = 'success';
        } catch (error) {
            if (attempt) { attempt.record.outcome = 'error'; attempt.record.errorCode = error.code || 'PROVIDER_ERROR'; }
            if (!req.complete) req.resume();
            send(res, error.status || 500, { error: { message: redact(error.message || 'Provider operation failed', secrets), code: error.code || 'PROVIDER_ERROR', type: 'provider_error' } });
        } finally {
            if (controller) controllers.delete(controller);
            if (attempt) {
                attempt.record.hostTiming.durationMs = performance.now() - attempt.record.hostTiming.startedAtMs;
                if (attempt.epoch === diagnosticEpoch) diagnostics.push(attempt.record);
            }
        }
    });
    server.requestTimeout = 30000;
    server.headersTimeout = 10000;
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    return {
        url: `http://127.0.0.1:${server.address().port}`,
        queryUrl: `http://127.0.0.1:${server.address().port}/query`, key,
        capabilities: {
            chat: { api: resolved.chat.api, model: resolved.chat.model, streaming: false, ...(resolved.chat.api !== 'openai-completions' ? { textOnly: true } : {}) },
            embedding: { configured: Boolean(resolved.embedding.baseURL), api: 'openai-embeddings', model: resolved.embedding.model },
            retries: 0,
        },
        resetDiagnostics() { diagnostics.length = 0; diagnosticEpoch += 1; },
        getDiagnostics() { return structuredClone(diagnostics); },
        async close() {
            for (const controller of controllers) controller.abort(new Error('router closed'));
            await new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); server.closeAllConnections(); });
        },
    };
}

module.exports = { startProviderRouter, resolveProviders, ProviderError, DEFAULT_CHAT_URL, DEFAULT_CHAT_MODEL, supportedApis: APIS };
