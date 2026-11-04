'use strict';

// The VCPChat algorithms below are loaded unchanged. This file supplies the
// filesystem/CLI boundary formerly supplied by Electron IPC and the renderer.
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { fileURLToPath, pathToFileURL } = require('node:url');
const chat = '../upstream/chat/';
const state = require(chat + 'modules/chat/contextCompactionState.js');
const prompts = require(chat + 'modules/chat/contextCompactionPrompts.js');
const fidelity = require(chat + 'modules/chat/contextCompactionFidelity.js');
const continuity = require(chat + 'modules/chat/contextCompactionContinuity.js');
const compaction = require(chat + 'modules/chat/contextCompactionService.js');
const mutations = require(chat + 'modules/chat/chatHistoryMutationAuthority.js');
const persistence = require(chat + 'modules/chat/chatHistoryPersistence.js');
const sideChat = require(chat + 'modules/chat/sideChatSessionService.js');
const branchTree = require(chat + 'modules/renderer/side-chat/branch-tree.js');
const branchNote = require(chat + 'modules/renderer/side-chat/note-exporter.js');
const groupWindow = require(chat + 'Groupmodules/groupContextWindow.js');
const sanitizer = require(chat + 'modules/contextSanitizer.js');
const tavernEngine = require(chat + 'modules/tavernRulesEngine.js');
const { stripHiddenToolResults } = require(chat + 'modules/renderer/toolResultRegions.js');
const { createSingleChatRequestOrchestrator } = require(chat + 'modules/chat/singleChatRequestOrchestrator.js');

function assertHistory(history) {
    if (!Array.isArray(history)) throw new TypeError('History must be an array');
    if (history.some(message => !message || typeof message !== 'object' || typeof message.role !== 'string')) {
        throw new TypeError('Every history message requires a role');
    }
    return history;
}

/** Local statistics and host-owned audit inputs, without making model calls. */
function inspectHistory(history) {
    assertHistory(history);
    const effective = state.effectiveContextHistory(history);
    const prepared = state.prepareCompactionState(history);
    return {
        totalMessages: history.length,
        effectiveMessages: effective.length,
        checkpoints: history.filter(state.isContextCheckpoint).length,
        estimatedTokens: compaction.estimateContextTokens(history),
        diaries: prepared.diaries,
        warnings: prepared.warnings,
        input: state.summarizeCompactionInput(history),
        previousAuditMissing: prepared.previousAuditMissing,
    };
}

function textForHash(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(p => p?.type === 'text' && typeof p.text === 'string').map(p => p.text).join('\n');
    if (typeof content?.text === 'string') return content.text;
    return '';
}

/** Exact wire contract of VCPChat modules/ipc/chatHandlers.js, sans Electron. */
function buildTimestampBindings(messages, context = null, requestId = null) {
    const messageTimestampBindings = [];
    messages.forEach((message, index) => {
        const meta = message?.__vcpchatTimestampMeta;
        if (!meta?.messageId || typeof meta.timestamp !== 'number' || !Number.isFinite(meta.timestamp)) return;
        messageTimestampBindings.push({
            messageId: meta.messageId,
            role: message.role || meta.role,
            timestamp: meta.timestamp,
            timestampIso: new Date(meta.timestamp).toISOString(),
            source: 'client_history',
            sentMessageHash: 'sha256:' + crypto.createHash('sha256').update(textForHash(message.content), 'utf8').digest('hex'),
            sentMessageIndex: index,
        });
    });
    const agentId = typeof context?.agentId === 'string' ? context.agentId.trim() : '';
    const agentName = typeof context?.agentName === 'string' ? context.agentName.trim() : '';
    const topicId = typeof context?.topicId === 'string' ? context.topicId.trim() : '';
    const requestContext = agentId || topicId ? {
        ...(typeof requestId === 'string' ? { requestId } : {}),
        ...(agentId ? { agentId } : {}), ...(agentName ? { agentName } : {}), ...(topicId ? { topicId } : {}),
        ownerType: context.isGroupMessage === true ? 'group' : 'agent',
        isGroupMessage: context.isGroupMessage === true,
    } : null;
    if (!messageTimestampBindings.length && !requestContext) return null;
    return {
        schemaVersion: 1, messageMetadataMode: 'hash_only',
        ...(messageTimestampBindings.length ? { messageTimestampBindings } : {}),
        ...(requestContext ? { requestContext } : {}),
    };
}

function stripInternalMessageMetadata(messages) {
    return messages.map(message => {
        const { __vcpchatTimestampMeta, __vcpContextCheckpoint, ...wire } = message;
        return wire;
    });
}

function localAttachmentPath(input, baseDirectory = process.cwd()) {
    if (typeof input !== 'string' || !input) throw new TypeError('Attachment path must be a nonempty string');
    if (input.startsWith('file:')) return path.resolve(fileURLToPath(input));
    if (/^[a-z][a-z\d+.-]*:/i.test(input) && !/^[a-z]:[\\/]/i.test(input)) throw new TypeError('Attachment reads require a local path or file:// URL');
    return path.resolve(baseDirectory, input);
}

function attachmentData(attachment) { return { ...attachment, ...(attachment?._fileManagerData || {}) }; }
function attachmentSource(attachment) {
    const data = attachmentData(attachment);
    return attachment?.path || data.path || data.sourcePath || attachment?.internalPath || data.internalPath || attachment?.src || data.src;
}

/** Read-only Electron capability replacement, restricted to declared files. */
function createFileSystemAttachmentAPI({ attachments = [], baseDirectory = process.cwd(), maxBytes } = {}) {
    if (maxBytes !== undefined && (!Number.isSafeInteger(maxBytes) || maxBytes < 1)) throw new TypeError('attachmentMaxBytes must be a positive integer');
    const allowed = new Set();
    for (const attachment of attachments) {
        const source = attachmentSource(attachment);
        if (!source) continue;
        try { allowed.add(localAttachmentPath(source, baseDirectory)); }
        catch (error) { if (attachment.path || attachmentData(attachment).path) throw error; }
    }
    async function checked(input) {
        const absolute = localAttachmentPath(input, baseDirectory);
        if (!allowed.has(absolute)) throw new Error('Attachment path was not explicitly declared in this request');
        const stat = await fs.stat(absolute);
        if (!stat.isFile()) throw new Error(`Attachment is not a file: ${absolute}`);
        if (maxBytes !== undefined && stat.size > maxBytes) throw new Error(`Attachment exceeds attachmentMaxBytes: ${absolute}`);
        return absolute;
    }
    return {
        async getTextContent(input, type) {
            const absolute = await checked(input);
            const manager = require(chat + 'modules/fileManager.js');
            return manager.getTextContent(absolute, type, path.basename(absolute));
        },
        async getFileAsBase64(input) {
            const absolute = await checked(input);
            const bytes = await fs.readFile(absolute);
            if (/\.(?:png|jpe?g|webp|gif|bmp|tiff?|svg)$/i.test(absolute)) {
                // Mirrors Chat's get-file-as-base64 IPC image handling: JPEG,
                // 800px edge, quality70; GIF samples begin at frame0 then500ms.
                const sharp = require('sharp');
                const frame = page => sharp(bytes, page === undefined ? {} : { page })
                    .resize({ width: 800, height: 800, fit: sharp.fit.inside, withoutEnlargement: true })
                    .jpeg({ quality: 70 }).toBuffer();
                if (/\.gif$/i.test(absolute)) {
                    const meta = await sharp(bytes, { animated: true }).metadata();
                    const frames = []; let elapsed = 0;
                    for (let page = 0; page < (meta.pages || 1); page++) {
                        if (page === 0 || elapsed >= 500) { frames.push((await frame(page)).toString('base64')); elapsed = 0; }
                        elapsed += meta.delay?.[page] > 0 ? meta.delay[page] : (meta.pages > 1 ? 100 : 0);
                    }
                    return { success: true, base64Frames: frames, isGif: true };
                }
                try { return { success: true, base64Frames: [(await frame()).toString('base64')], isGif: false }; }
                catch (error) {
                    // The original IPC falls back to unmodified bytes when a
                    // static image codec cannot decode an otherwise stored file.
                    return { success: true, base64Frames: [bytes.toString('base64')], isGif: false };
                }
            }
            return { success: true, base64Frames: [bytes.toString('base64')], isGif: false };
        },
        resolvePath: input => localAttachmentPath(input, baseDirectory),
        checkPath: checked,
    };
}

async function hydrateHistoryAttachments(history, host, diagnostics = []) {
    const result = structuredClone(history);
    for (const message of result) {
        for (const attachment of message.attachments || []) {
            const data = attachmentData(attachment), source = attachmentSource(attachment);
            if (!source) continue;
            // Existing snapshots remain usable if their old source file has
            // disappeared. Explicit path and live references request a new read.
            const explicit = attachment.path || data.path;
            const live = attachment.isLiveReference === true || data.isLiveReference === true;
            if (!explicit && !live && (data.extractedText || data.imageFrames?.length)) continue;
            let absolute;
            try { absolute = host.resolvePath ? host.resolvePath(source) : localAttachmentPath(source); }
            catch (error) {
                if (explicit) throw error;
                continue; // Remote/data URLs are not filesystem read requests.
            }
            if (host.checkPath) await host.checkPath(absolute);
            const url = pathToFileURL(absolute).href;
            attachment.internalPath = url; attachment.src = url;
            attachment.name ||= path.basename(absolute);
            const type = attachment.type || data.type || require('mime-types').lookup(absolute) || 'application/octet-stream';
            attachment.type = type;
            const textExtension = /\.(?:txt|md|jsonc?|xml|csv|html?|css|[cm]?js|bat|sh|py|java|c|cpp|h|hpp|cs|go|rb|php|swift|kt|kts|ts|tsx|jsx|vue|ya?ml|toml|ini|log|sql|rs|dart|lua|r|pl|ex|exs|zig|hs|scala|groovy|d|nim|cr)$/i.test(absolute);
            const extractType = textExtension ? 'application/octet-stream' : type;
            if (textExtension || type.startsWith('text/') || ['application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'].includes(type)) {
                const extracted = await host.getTextContent(absolute, extractType);
                if (!extracted || (extracted.text === null && !extracted.imageFrames?.length)) throw new Error(`Attachment text extraction failed: ${absolute}`);
                if (typeof extracted.text === 'string') attachment.extractedText = extracted.text;
                if (extracted.imageFrames?.length) attachment.imageFrames = extracted.imageFrames;
                if (extracted.pdfMeta) attachment.pdfMeta = extracted.pdfMeta;
                if (extracted.pdfMeta?.error) diagnostics.push({ path: absolute, error: extracted.pdfMeta.error, fallback: 'original PDF residual text' });
            } else if (/^(?:image|audio|video)\//.test(type)) {
                const media = await host.getFileAsBase64(url);
                if (!media?.success || !media.base64Frames?.length) throw new Error(`Attachment media read failed: ${absolute}`);
            } else {
                diagnostics.push({ path: absolute, warning: `Original VCPChat text extraction does not support ${type}; path is preserved` });
            }
            if (attachment._fileManagerData) attachment._fileManagerData = { ...attachment._fileManagerData, ...attachment, _fileManagerData: undefined };
        }
    }
    return result;
}

async function hydrateCompactionState(prepared, options = {}) {
    if (options.readAttachmentFiles === false) return prepared;
    const host = createFileSystemAttachmentAPI({
        attachments: prepared.messages.flatMap(message => message.attachments || []),
        baseDirectory: options.attachmentBaseDirectory,
        maxBytes: options.attachmentMaxBytes,
    });
    // Prepared state is operation-local. Replacing this projection preserves
    // the original durable snapshot used by the source's stale-write check.
    prepared.messages = await hydrateHistoryAttachments(prepared.messages, host);
    return prepared;
}

/**
 * Reuse VCPChat's outbound request builder, including checkpoint boundaries,
 * AgentName, Tavern rules, inherited branch context and attachment capability
 * hooks. Callers can supply read-only file adapters through electronAPI.
 */
async function prepareMessages(history, options = {}) {
    assertHistory(history);
    const {
        agentId = 'agent', topicId = 'default', agentName = agentId,
        agentConfig = {}, settings = {}, requestId = crypto.randomUUID(),
        electronAPI: injectedAPI = {}, tavernRules = [], sanitize = false,
        sanitizerDepth = 2, keepThoughtChains = false,
        parentSnapshot = [], contextMode = 'references-only',
        systemPromptPrefix = '', systemPromptAppend = '',
        readAttachmentFiles = true, attachmentBaseDirectory = process.cwd(), attachmentMaxBytes,
        ...hooks
    } = options;
    const declared = [...(contextMode === 'parent-snapshot' ? parentSnapshot : []), ...history].flatMap(message => message.attachments || []);
    const filesystemAPI = createFileSystemAttachmentAPI({ attachments: declared, baseDirectory: attachmentBaseDirectory, maxBytes: attachmentMaxBytes });
    const electronAPI = readAttachmentFiles ? { ...filesystemAPI, ...injectedAPI } : injectedAPI;
    const attachmentDiagnostics = [];
    const hydrated = readAttachmentFiles ? await hydrateHistoryAttachments(history, electronAPI, attachmentDiagnostics) : history;
    const parent = contextMode === 'parent-snapshot' && readAttachmentFiles
        ? await hydrateHistoryAttachments(parentSnapshot, electronAPI, attachmentDiagnostics) : parentSnapshot;
    const inherited = contextMode === 'parent-snapshot' ? sideChat.freezeParentHistory(parent) : [];
    const requestHooks = Object.fromEntries(['modelConfigOverrides', 'transformMessageText', 'buildMessageContent', 'postProcessMessageContent']
        .filter(key => hooks[key] !== undefined).map(key => [key, hooks[key]]));
    const orchestrator = createSingleChatRequestOrchestrator({ electronAPI, tavernEngine });
    const fullHistory = [...inherited, ...hydrated];
    // Delegate ordinary attachment handling to the original builder. This
    // singleton request has no rules/prompt hooks and is never sent anywhere.
    const originalContent = async message => {
        const single = await orchestrator.buildRequest({
            settings, agentConfig: {}, history: [message], messageId: requestId,
            context: { agentId, topicId, agentName }, tavernRules: [],
        });
        return single.messages[0]?.content || [];
    };
    const adaptedContent = async ({ message }) => {
        if (!Array.isArray(message.content)) {
            return originalContent(typeof message.content?.text === 'string'
                ? { ...message, content: message.content.text } : message);
        }
        const parts = structuredClone(message.content).map(part =>
            part.type === 'text' && typeof part.text === 'string'
                ? { ...part, text: stripHiddenToolResults(part.text) } : part);
        if (message.attachments?.length) {
            // Preserve already-formed media while allowing the original code
            // to read/refresh separate text, image, PDF and live references.
            parts.push(...await originalContent({ ...message, content: '' }));
        }
        return parts;
    };
    const prepared = await orchestrator.buildRequest({
        settings, agentConfig: { name: agentName, ...agentConfig },
        history: fullHistory, messageId: requestId,
        context: { agentId, topicId, agentName },
        currentUserMessageId: [...history].reverse().find(m => m.role === 'user')?.id,
        systemPromptPrefix, systemPromptAppend, tavernRules,
        // Desktop histories normally store strings and separate attachments.
        // CLI agents also pass already-formed multimodal API content. Use the
        // upstream capability hook to retain those arrays without stringifying.
        buildMessageContent: fullHistory.some(message => Array.isArray(message.content) || typeof message.content?.text === 'string')
            ? adaptedContent
            : undefined,
        ...requestHooks,
    });
    // Bind hashes after the final client transformation, as the desktop client
    // does; never bind original HTML hashes to a sanitized payload.
    let messages = prepared.messages;
    if (sanitize) {
        // Preserve timestamp metadata through the sanitizer's intentional
        // field allowlist, then remove it from the actual model messages.
        const clean = sanitizer.sanitizeMessages(messages, sanitizerDepth, keepThoughtChains);
        messages = clean.map((message, index) => ({
            ...message,
            ...(prepared.messages[index].__vcpchatTimestampMeta ? { __vcpchatTimestampMeta: prepared.messages[index].__vcpchatTimestampMeta } : {}),
            ...(prepared.messages[index].__vcpContextCheckpoint ? { __vcpContextCheckpoint: true } : {}),
        }));
    }
    const vcpchat = buildTimestampBindings(messages, prepared.context, requestId);
    return {
        ...prepared,
        messages: stripInternalMessageMetadata(messages),
        vcpchatExtensions: vcpchat,
        ...(attachmentDiagnostics.length ? { attachmentDiagnostics } : {}),
    };
}

async function compactHistory(history, settings, options = {}) {
    assertHistory(history);
    const prepared = state.prepareCompactionState(history);
    if (!prepared.sourceCount) throw new Error('No context available for compaction');
    await hydrateCompactionState(prepared, options);
    const response = Object.hasOwn(options, 'response')
        ? options.response
        : await compaction.requestContextCompaction({ settings, state: prepared, ...options });
    const message = prompts.createCheckpointMessage(prepared, response, settings, options);
    return { history: [...structuredClone(history), message], message, warnings: prepared.warnings };
}

function compactionDecision(history, { settings = {}, agentConfig = {}, pendingText = '' } = {}) {
    const estimatedTokens = compaction.estimateContextTokens([
        ...state.effectiveContextHistory(history), { role: 'user', content: pendingText },
    ], agentConfig.systemPrompt || '');
    const limit = Number(agentConfig.contextTokenLimit);
    if (!prompts.compactionSettings(settings).enabled) return { compacted: false, reason: 'disabled', estimatedTokens };
    if (!compaction.shouldCompactContext(history, agentConfig, pendingText)) {
        return { compacted: false, reason: 'below-threshold-or-checkpoint-only', estimatedTokens, thresholdTokens: Number.isFinite(limit) && limit > 0 ? limit * 0.85 : null };
    }
    return { required: true, estimatedTokens, thresholdTokens: limit * 0.85 };
}

async function autoCompactionDecision(history, payload) {
    const projected = { messages: state.effectiveContextHistory(history) };
    if (prompts.compactionSettings(payload.settings).enabled) await hydrateCompactionState(projected, payload.options || {});
    return compactionDecision(projected.messages, payload);
}

function component(value, name) {
    if (typeof value !== 'string' || !value || value === '.' || value === '..' || /[\u0000-\u001f/\\]/u.test(value)) {
        throw new TypeError(`Invalid ${name}`);
    }
    // Prefix also avoids Windows device names (CON, AUX, COM1) and trailing-dot
    // normalization. The encoded identity remains reversible in listTopics.
    return 'id-' + encodeURIComponent(value).replace(/\./g, '%2E');
}

/** Filesystem replacement for the original Electron chat repository. */
class ContextStore {
    constructor(root) {
        if (!root) throw new TypeError('ContextStore requires a data root');
        this.root = path.resolve(root);
        this.repository = {
            getHistory: this.getHistory.bind(this),
            saveHistory: this.saveHistory.bind(this),
        };
        const authority = mutations.createChatHistoryMutationAuthority({ repository: this.repository });
        this.authority = {
            ...authority,
            mutate: (descriptor, transform) => this.withLock(descriptor,
                () => authority.mutate(descriptor, transform)),
            replace: (descriptor, history) => this.withLock(descriptor,
                () => authority.replace(descriptor, history)),
        };
    }

    topicPath(itemId, itemType, topicId) {
        if (!['agent', 'group'].includes(itemType)) throw new TypeError('itemType must be agent or group');
        return path.join(this.root, 'sessions', itemType, component(itemId, 'itemId'), component(topicId, 'topicId'));
    }

    async readJson(file, fallback) {
        try { return JSON.parse(await fs.readFile(file, 'utf8')); }
        catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
    }

    async withLock({ itemId, itemType = 'agent', topicId }, operation) {
        const directory = this.topicPath(itemId, itemType, topicId);
        await fs.mkdir(directory, { recursive: true });
        const lockPath = path.join(directory, '.history.lock');
        const started = Date.now();
        let handle;
        while (!handle) {
            try {
                handle = await fs.open(lockPath, 'wx');
                await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now() }));
            } catch (error) {
                if (error.code !== 'EEXIST') throw error;
                // Never unlink another process's lock automatically: a stale
                // owner check followed by unlink has a reclaim race. A crashed
                // writer leaves an inspectable PID record for explicit recovery.
                if (Date.now() - started >= 30000) throw new Error('History is locked by another process');
                await new Promise(resolve => setTimeout(resolve, 20));
            }
        }
        try { return await operation(); }
        finally { await handle.close(); await fs.rm(lockPath, { force: true }); }
    }

    async writeJson(file, value) {
        await fs.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp-' + crypto.randomUUID();
        try {
            await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
            try { await fs.copyFile(file, file + '.bak'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
            await fs.rename(tmp, file);
        } finally { await fs.rm(tmp, { force: true }); }
    }

    async getHistory(itemId, itemType = 'agent', topicId) {
        const data = await this.readJson(path.join(this.topicPath(itemId, itemType, topicId), 'history.json'), []);
        // TopicMemo supports both historic envelopes and current arrays.
        return assertHistory(Array.isArray(data) ? data : data?.messages);
    }

    async saveHistory(itemId, itemType = 'agent', topicId, history) {
        assertHistory(history);
        await this.writeJson(path.join(this.topicPath(itemId, itemType, topicId), 'history.json'), history);
        return { success: true };
    }

    async append({ itemId, itemType = 'agent', topicId }, messages) {
        assertHistory(messages);
        const additions = messages.map(message => ({
            ...structuredClone(message),
            id: message.id || crypto.randomUUID(), timestamp: message.timestamp ?? Date.now(),
        }));
        return this.authority.mutate({ itemId, itemType, topicId, category: 'append' }, history => [...history, ...additions]);
    }

    async listTopics(itemId, itemType = 'agent') {
        const base = path.dirname(this.topicPath(itemId, itemType, '_'));
        let entries;
        try { entries = await fs.readdir(base, { withFileTypes: true }); }
        catch (error) { if (error.code === 'ENOENT') return []; throw error; }
        const topics = [];
        for (const entry of entries.filter(e => e.isDirectory() && e.name.startsWith('id-'))) {
            const topicId = decodeURIComponent(entry.name.slice(3));
            const directory = this.topicPath(itemId, itemType, topicId);
            const metadata = await this.readJson(path.join(directory, 'sidechat-metadata.json'), null);
            const history = await this.getHistory(itemId, itemType, topicId);
            topics.push({ topicId, itemId, itemType, messages: history.length, metadata });
        }
        return topics.sort((a, b) => a.topicId.localeCompare(b.topicId));
    }

    /** Freeze the complete ancestor chain; never re-read its later live state. */
    async fork({ itemId, topicId, childTopicId, forkMessageId = null, title = null, forkLabel = null }) {
        childTopicId ||= `sidechat_${Date.now()}_${crypto.randomBytes(5).toString('hex')}`;
        const parentPath = this.topicPath(itemId, 'agent', topicId);
        const childPath = this.topicPath(itemId, 'agent', childTopicId);
        if (parentPath === childPath) throw new Error('Parent and child topics must differ');
        const own = await this.getHistory(itemId, 'agent', topicId);
        const ancestor = await this.readJson(path.join(parentPath, 'parent-snapshot.json'), []);
        const parentMeta = await this.readJson(path.join(parentPath, 'sidechat-metadata.json'), null);
        let combined = [...ancestor, ...own];
        if (forkMessageId) {
            const boundary = combined.findIndex(message => message.id === forkMessageId || message.sourceMessageId === forkMessageId);
            if (boundary < 0) throw new Error('Fork message does not exist in parent context');
            combined = combined.slice(0, boundary + 1);
        }
        const snapshot = sideChat.freezeParentHistory(combined);
        const metadata = sideChat.createSideChatDescriptor({
            parent: parentMeta?.parent || { itemId, topicId, name: itemId },
            childTopicId, title, contextMode: 'parent-snapshot', parentSnapshot: [],
            rootTopicId: parentMeta?.rootTopicId || childTopicId,
            forkFromTopicId: parentMeta ? topicId : null,
            forkMessageId, forkLabel, branchTitle: title,
            depth: parentMeta ? (parentMeta.depth || 0) + 1 : 0,
        });
        // mkdir without recursive is the creation claim: an existing child's
        // history cannot be replaced by another fork request.
        await fs.mkdir(path.dirname(childPath), { recursive: true });
        await fs.mkdir(childPath);
        await this.writeJson(path.join(childPath, 'parent-snapshot.json'), snapshot);
        await this.writeJson(path.join(childPath, 'sidechat-metadata.json'), metadata);
        await this.saveHistory(itemId, 'agent', childTopicId, []);
        return { metadata, snapshot };
    }

    async branchContext(itemId, topicId) {
        const directory = this.topicPath(itemId, 'agent', topicId);
        const metadata = await this.readJson(path.join(directory, 'sidechat-metadata.json'), null);
        if (!metadata) throw new Error('Branch metadata does not exist');
        const snapshot = await this.readJson(path.join(directory, 'parent-snapshot.json'), []);
        const history = await this.getHistory(itemId, 'agent', topicId);
        return { metadata, snapshot, history, messages: [...snapshot, ...sideChat.freezeParentHistory(history)] };
    }

    async crystallize(itemId, topicId, { maxAnswerChars = Number.MAX_SAFE_INTEGER } = {}) {
        const { metadata, history } = await this.branchContext(itemId, topicId);
        const note = branchNote.buildBranchNote({
            descriptor: metadata,
            ownHistory: history.map(message => Array.isArray(message.content) ? { ...message, content: textForHash(message.content) } : message),
            maxAnswerChars,
        });
        const directory = this.topicPath(itemId, 'agent', topicId);
        await fs.writeFile(path.join(directory, 'knowledge-crystal.md'), note, 'utf8');
        await this.writeJson(path.join(directory, 'sidechat-metadata.json'), { ...metadata, crystallized: true });
        return { note, path: path.join(directory, 'knowledge-crystal.md') };
    }

    async close() { await this.authority.dispose(); }
}

function createContextService({ root, store = new ContextStore(root), ...options } = {}) {
    const request = options.request || compaction.requestContextCompaction;
    const service = compaction.createContextCompactionService({
        historyMutationAuthority: store.authority, ...options,
        async request(args) {
            await hydrateCompactionState(args.state, options);
            return request(args);
        },
    });
    return {
        store,
        ...service,
        async compact({ scope, settings, ...rest }) {
            const history = await store.getHistory(scope.itemId, scope.itemType || 'agent', scope.topicId);
            return service.compact({ scope: { itemType: 'agent', ...scope }, history, settings, ...rest });
        },
        async close() { service.dispose(); await store.close(); },
    };
}

/** JSON operation boundary used by the CLI worker; no Electron is required. */
async function dispatch(operation, payload = {}, { home } = {}) {
    const action = operation.replace(/^context\./, 'context:').replace(/^session\./, 'session:');
    const history = payload.history || [];
    if (action === 'context:inspect') return inspectHistory(history);
    if (action === 'context:effective') return state.effectiveContextHistory(assertHistory(history));
    if (action === 'context:prepare') return prepareMessages(history, payload.options || payload);
    if (action === 'context:compaction-input') return {
        state: state.prepareCompactionState(assertHistory(history)),
        messages: prompts.buildCompactionMessages(state.prepareCompactionState(history), payload.settings || {}),
    };
    if (action === 'context:compact') return compactHistory(history, payload.settings || {}, payload.options || {});
    if (action === 'context:auto-compact') {
        assertHistory(history);
        const decision = await autoCompactionDecision(history, payload);
        if (!decision.required) return decision;
        return { ...await compactHistory(history, payload.settings || {}, payload.options || {}), compacted: true, decision };
    }
    if (action === 'context:group-window') return groupWindow.selectGroupContextHistory(history, payload.config || {});
    if (action === 'context:branches') {
        const forest = branchTree.buildBranchForest(payload.metadata || []);
        // Source nodes contain parent cycles. Project identifiers for JSON.
        return [...forest.nodes.values()].map(({ parent, children, meta, ...node }) => ({
            ...node, parent: parent?.topicId || null, children: children.map(child => child.topicId),
        }));
    }
    if (!action.startsWith('session:')) throw new Error(`Unknown context operation: ${operation}`);
    if (!home) throw new TypeError('Session operations require home');
    const store = new ContextStore(home);
    const scope = {
        itemId: payload.itemId || payload.agent || 'agent',
        itemType: payload.itemType || 'agent',
        topicId: payload.topicId || payload.session || 'default',
    };
    try {
        if (action === 'session:list') return await store.listTopics(scope.itemId, scope.itemType);
        if (action === 'session:get') return await store.getHistory(scope.itemId, scope.itemType, scope.topicId);
        if (action === 'session:put') return await store.authority.replace({ ...scope, category: 'replace' }, assertHistory(history));
        if (action === 'session:append') return await store.append(scope, payload.messages || (payload.message ? [payload.message] : history));
        if (action === 'session:inspect') return inspectHistory(await store.getHistory(scope.itemId, scope.itemType, scope.topicId));
        if (action === 'session:fork') {
            if (scope.itemType !== 'agent') throw new Error('Side chat branches support agent topics only');
            return await store.fork({ ...payload, ...scope });
        }
        if (action === 'session:branch') return await store.branchContext(scope.itemId, scope.topicId);
        if (action === 'session:crystallize') return await store.crystallize(scope.itemId, scope.topicId, payload.options || {});
        if (action === 'session:compact' || action === 'session:auto-compact') {
            let decision;
            if (action === 'session:auto-compact') {
                decision = await autoCompactionDecision(await store.getHistory(scope.itemId, scope.itemType, scope.topicId), payload);
                if (!decision.required) return decision;
            }
            const service = createContextService({
                store,
                ...(Object.hasOwn(payload, 'response') ? { request: async () => payload.response } : {}),
            });
            try {
                const result = await service.compact({ scope, settings: payload.settings || {} });
                return decision ? { ...result, compacted: true, decision } : result;
            }
            finally { await service.close(); }
        }
        if (action === 'session:prepare') {
            const messages = await store.getHistory(scope.itemId, scope.itemType, scope.topicId);
            const branchDirectory = store.topicPath(scope.itemId, scope.itemType, scope.topicId);
            const metadata = await store.readJson(path.join(branchDirectory, 'sidechat-metadata.json'), null);
            const snapshot = metadata ? await store.readJson(path.join(branchDirectory, 'parent-snapshot.json'), []) : [];
            return prepareMessages(messages, {
                ...(metadata ? { contextMode: metadata.contextMode, parentSnapshot: snapshot } : {}),
                ...(payload.options || {}), agentId: scope.itemId, topicId: scope.topicId,
            });
        }
        throw new Error(`Unknown session operation: ${operation}`);
    } finally { await store.close(); }
}

module.exports = {
    ...state, ...prompts, ...fidelity, ...continuity, ...compaction,
    ...mutations, ...persistence, ...sideChat, ...branchTree, ...branchNote, ...groupWindow,
    sanitizer, tavernEngine, createSingleChatRequestOrchestrator,
    inspectHistory, buildTimestampBindings, stripInternalMessageMetadata,
    prepareMessages, compactHistory, compactionDecision, ContextStore, createContextService, dispatch,
    createFileSystemAttachmentAPI, hydrateHistoryAttachments,
};
