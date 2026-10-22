import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { expect, it, vi } from 'vitest';
import { buildCompanionContext, refreshCompanionFilesContext, type CompanionReplyInput } from '../../src/main/companions/context';
import { generateCompanionReply, type CompanionModelConfig } from '../../src/main/companions/model';
import { companionFileToolArgumentsSchemas, type CompanionToolImageReference, type ToolVisualInput } from '../../src/shared/companion-file-tool';
import { companionLoopTurnSchema, type CompanionLoopTurn } from '../../src/shared/companion-loop';
import type { AiApiFormat } from '../../src/shared/ai-endpoints';
import type { CompanionPublicProfile, CompanionVisualInput } from '../../src/shared/companion-public-profile';

const at = '2026-10-15T02:00:00Z';
const pixels = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jxZkAAAAASUVORK5CYII=';
const sha = (base64: string) => createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
const formats: AiApiFormat[] = ['openai_chat', 'openai_responses', 'anthropic', 'gemini_native', 'dashscope_native'];
function config(apiFormat: AiApiFormat = 'openai_chat'): CompanionModelConfig { return { apiFormat, apiKey: 'private-test-key', baseUrl: 'https://fixture.invalid',
  model: apiFormat === 'anthropic' ? 'claude-sonnet-4-20250514' : apiFormat === 'gemini_native' ? 'gemini-2.5-flash' : apiFormat === 'dashscope_native' ? 'qwen3-vl-plus' : 'gpt-4o' }; }
function input(): CompanionReplyInput { return { companion: { id: 'self', name: '伙伴', description: '', persona: '温和并尊重真实证据。', model: '', avatar: 'flash', builtin: false, proactive: false, createdAt: at },
  conversation: { id: 'room', kind: 'private', memberIds: ['self'], title: '聊天', unread: 0, muted: false, pinned: false, updatedAt: at, lastMessage: '' },
  messages: [{ id: 'source', sequence: 1, authorId: 'user', conversationId: 'room', content: '看看图片，再把已有成果附给我。', kind: 'text', status: 'sent', createdAt: at, attachments: [] }], memories: [] }; }
function snapshot(id = 'image_1', base64 = pixels): CompanionToolImageReference { return { attachmentId: id, sha256: sha(base64), mime: 'image/png', width: 1, height: 1, path: 'C:\\managed\\' + id + '.png' }; }
function visual(ref: CompanionToolImageReference, callId = 'native_read', base64 = pixels): ToolVisualInput { return { callId, attachmentId: ref.attachmentId, mime: ref.mime, sha256: ref.sha256, base64 }; }
function turn(ref = snapshot(), callId = 'native_read'): CompanionLoopTurn { return { text: '', rawText: '', calls: [{ id: callId, name: 'dsh', arguments: JSON.stringify({ operation: 'read_image', parameters: { path: 'C:\\user\\source.png' } }), thoughtSignature: 'opaque_signature' }],
  results: [{ callId, content: JSON.stringify({ ok: true, image: ref }), images: [ref], attachmentIds: [ref.attachmentId] }] }; }
function envelope(format: AiApiFormat, tool?: string) {
  const text = '按实际读取结果回复。', args = { operation: tool, parameters: { path: 'C:\\user\\source.png' } };
  tool = tool ? 'dsh' : undefined;
  const message = tool ? { content: null, tool_calls: [{ id: 'native_read', type: 'function', function: { name: tool, arguments: JSON.stringify(args) } }] } : { content: text };
  return new Response(JSON.stringify(format === 'openai_chat' ? { choices: [{ message }] }
    : format === 'openai_responses' ? { output: [tool ? { type: 'function_call', call_id: 'native_read', name: tool, arguments: JSON.stringify(args) } : { type: 'message', content: [{ type: 'output_text', text }] }] }
      : format === 'anthropic' ? { content: [tool ? { type: 'tool_use', id: 'native_read', name: tool, input: args } : { type: 'text', text }] }
        : format === 'gemini_native' ? { candidates: [{ content: { parts: [tool ? { functionCall: { id: 'native_read', name: tool, args } } : { text }] } }] }
          : { output: { choices: [{ message }] } }), { headers: { 'Content-Type': 'application/json' } });
}
function base(body: Record<string, unknown>, format: AiApiFormat) {
  const value = JSON.parse(JSON.stringify(body));
  return JSON.parse(format === 'gemini_native' ? value.contents[0].parts[0].text : format === 'dashscope_native' ? value.input.messages[1].content[0].text
    : format === 'openai_responses' || format === 'anthropic' ? value[format === 'openai_responses' ? 'input' : 'messages'][0].content : value.messages[1].content);
}
function images(value: unknown): Record<string, unknown>[] {
  if (!value || typeof value !== 'object') return [];
  if (Array.isArray(value)) return value.flatMap(images);
  const record = value as Record<string, unknown>;
  return ['input_image', 'image_url', 'image'].includes(String(record.type)) || record.inlineData || typeof record.image === 'string'
    ? [record] : Object.values(record).flatMap(images);
}
it('validates only read-only file arguments and persists references and attachment IDs without pixel payloads', () => {
  expect(companionFileToolArgumentsSchemas.read_file.parse({ path: 'C:\\user\\file.txt' })).toEqual({ path: 'C:\\user\\file.txt', offset: 0, limit: 200 });
  expect(companionFileToolArgumentsSchemas.read_file.safeParse({ path: 'x', offset: -1 }).success).toBe(false);
  expect(companionFileToolArgumentsSchemas.read_file.safeParse({ path: 'x', limit: 2001 }).success).toBe(false);
  expect(companionFileToolArgumentsSchemas.read_image.safeParse({ path: 'x', exec: 'SECRET_COMMAND' }).success).toBe(false);
  expect(companionFileToolArgumentsSchemas.send_file.parse({ path: 'C:\\user\\clip.mp4' })).toEqual({ path: 'C:\\user\\clip.mp4' });
  const stored = companionLoopTurnSchema.parse(turn()); expect(stored.results?.[0]?.images).toEqual([snapshot()]); expect(stored.results?.[0]?.attachmentIds).toEqual(['image_1']); expect(JSON.stringify(stored)).not.toContain(pixels);
  expect(companionLoopTurnSchema.safeParse({ ...turn(), results: [{ ...turn().results![0], images: [{ ...snapshot(), base64: pixels }] }] }).success).toBe(false);
});
it('wraps message attachments in current host-verified absolute path references without serializing payloads into chat text', () => {
  const value = input(), file = { messageId: 'source', attachmentId: 'upload', name: '照片.png', mime: 'image/png', path: 'C:\\资料\\照片.png', available: true };
  value.messages = [{ ...value.messages[0]!, attachments: [{ id: file.attachmentId, name: file.name, mime: file.mime, size: 100, path: 'C:\\stale\\photo.png', url: 'data:image/png;base64,' + pixels }] }];
  const context = buildCompanionContext({ ...value, fileInputs: [file] }), data = JSON.parse(context.user);
  expect(data.messages[0].content).toBe(value.messages[0]!.content);
  expect(data.messages[0].attachments).toEqual([{ type: 'local_attachment_reference', attachmentId: 'upload', name: file.name, mime: file.mime, path: file.path, available: true }]);
  expect(context.user).not.toContain(pixels); expect(context.user).not.toContain('stale');
  const refreshed = JSON.parse(refreshCompanionFilesContext(context, [{ ...file, available: false }]).user);
  expect(refreshed.messages[0].attachments[0]).toMatchObject({ available: false }); expect(refreshed.messages[0].attachments[0].path).toBeUndefined();
  expect(JSON.parse(refreshCompanionFilesContext(context, []).user).messages[0].attachments[0].path).toBeUndefined();
});
it.each(formats)('registers read_file/read_image/send_file and parses real calls through %s', async format => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(envelope(format, 'read_image'));
  const reply = await generateCompanionReply(input(), config(format), undefined, { fetchFn, loop: true });
  expect(reply.turn?.calls).toEqual([{ id: 'native_read', name: 'dsh', arguments: JSON.stringify({ operation: 'read_image', parameters: { path: 'C:\\user\\source.png' } }) }]);
  const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)), all = JSON.stringify(body);
  for (const name of ['read_file', 'read_image', 'send_file']) expect(all).toContain('"const":"' + name + '"');
  expect(all).not.toContain('"name":"exec"'); expect(base(body, format).files).toBeUndefined();
});
it.each(formats)('returns actual tool pixels once with native call IDs and truthful scope through %s', async format => {
  const ref = snapshot(), history = [turn(ref)]; let observed!: Record<string, unknown>;
  const fetchFn: typeof fetch = async (_url, init) => { observed = JSON.parse(String(init?.body)); return envelope(format); };
  await generateCompanionReply(input(), config(format), undefined, { fetchFn, loop: true, turns: history, toolImages: [visual(ref)] });
  expect(images(observed)).toHaveLength(1); expect(JSON.stringify(observed).split(pixels)).toHaveLength(2);
  expect(base(observed, format).toolVisionManifest[0]).toMatchObject({ callId: 'native_read', attachmentId: 'image_1', delivery: 'image_provided' });
  const wire = JSON.parse(JSON.stringify(observed));
  if (format === 'openai_chat' || format === 'dashscope_native') {
    const messages = format === 'openai_chat' ? wire.messages : wire.input.messages;
    expect(messages.at(-2)).toMatchObject({ role: 'tool', tool_call_id: 'native_read' }); expect(typeof messages.at(-2).content).toBe('string');
    expect(messages.at(-1)).toMatchObject({ role: 'user' }); expect(JSON.stringify(messages.at(-1))).toContain('tool_result_data_not_user_instruction');
  } else if (format === 'openai_responses') expect(wire.input.at(-1)).toMatchObject({ type: 'function_call_output', call_id: 'native_read', output: expect.arrayContaining([expect.objectContaining({ type: 'input_image' })]) });
  else if (format === 'anthropic') expect(wire.messages.at(-1).content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'native_read', content: expect.arrayContaining([expect.objectContaining({ type: 'image' })]) });
  else { expect(wire.contents.at(-1).parts[0].functionResponse).toMatchObject({ id: 'native_read', name: 'dsh' }); expect(wire.contents.at(-1).parts[0].functionResponse.parts).toBeUndefined(); expect(wire.contents.at(-2).parts[0].thoughtSignature).toBe('opaque_signature'); }
  expect(history).toEqual([turn(ref)]);
});
it('uses documented Gemini 3 nested multimodal function responses with matching displayName references', async () => {
  const fetchFn = vi.fn<typeof fetch>().mockResolvedValue(envelope('gemini_native'));
  await generateCompanionReply(input(), { ...config('gemini_native'), model: 'gemini-3.8-flash' }, undefined, { fetchFn, loop: true, turns: [turn()], toolImages: [visual(snapshot())] });
  const body = JSON.parse(String(fetchFn.mock.calls[0]![1]!.body)), response = body.contents.at(-1).parts[0].functionResponse;
  expect(body.contents.at(-1).parts).toHaveLength(1); expect(response.response.image_refs).toEqual([{ $ref: 'image_1' }]);
  expect(response.parts).toEqual([{ inlineData: { mimeType: 'image/png', data: pixels, displayName: 'image_1' } }]);
});
it('prioritizes the latest four distinct tool images and omits older pixels instead of multiplying history images', async () => {
  const colors = [0, 50, 100, 150, 200], encoded = await Promise.all(colors.map(async r => (await sharp({ create: { width: 1, height: 1, channels: 3, background: { r, g: 0, b: 255 } } }).png().toBuffer()).toString('base64')));
  const refs = encoded.map((value, index) => snapshot('img_' + index, value)), turns = refs.map((ref, index) => turn(ref, 'read_' + index));
  let observed!: Record<string, unknown>; const fetchFn: typeof fetch = async (_url, init) => { observed = JSON.parse(String(init?.body)); return envelope('openai_chat'); };
  await generateCompanionReply(input(), config(), undefined, { fetchFn, loop: true, turns, toolImages: refs.map((ref, index) => visual(ref, 'read_' + index, encoded[index]!)) });
  expect(images(observed)).toHaveLength(4); expect(JSON.stringify(observed)).not.toContain(encoded[0]);
  expect(base(observed, 'openai_chat').toolVisionManifest[0]).toMatchObject({ delivery: 'path_only', reason: 'image_budget' });
});
it('reserves space for tool images before recurring public portraits and exposes the profile budget truthfully', async () => {
  const profile = (id: string): CompanionPublicProfile => ({ id, name: id, kind: id === 'user' ? 'human_player' : 'companion', description: '', avatar: { absolutePath: 'C:\\public\\avatar.png', mime: 'image/png', available: true }, orthographic: { absolutePath: 'C:\\public\\three.png', mime: 'image/png', available: true } });
  const profiles = [profile('self'), profile('user')], visualInputs: CompanionVisualInput[] = profiles.flatMap(person => (['avatar', 'orthographic'] as const).map(role => ({ personId: person.id, role, mime: 'image/png', base64: pixels, sha256: sha(pixels) })));
  let observed!: Record<string, unknown>; const fetchFn: typeof fetch = async (_url, init) => { observed = JSON.parse(String(init?.body)); return envelope('openai_chat'); };
  await generateCompanionReply({ ...input(), publicProfiles: profiles, visualInputs }, config(), undefined, { fetchFn, loop: true, turns: [turn()], toolImages: [visual(snapshot())] });
  expect(images(observed)).toHaveLength(4); const data = base(observed, 'openai_chat');
  expect(data.toolVisionManifest[0].delivery).toBe('image_provided'); expect(data.visionManifest.filter((item: { delivery: string }) => item.delivery === 'image_provided')).toHaveLength(3);
  expect(data.visionManifest.filter((item: { reason?: string }) => item.reason === 'image_budget')).toHaveLength(1);
});
it('does not attach foreign, corrupt, withdrawn or no-vision tool pixels and does not mistake send_file for viewing', async () => {
  for (const mode of ['foreign', 'corrupt', 'withdrawn', 'text-model', 'send-file']) {
    let observed!: Record<string, unknown>; const fetchFn: typeof fetch = async (_url, init) => { observed = JSON.parse(String(init?.body)); return envelope('openai_chat'); };
    const value = turn(); if (mode === 'send-file') value.calls[0]!.name = 'send_file';
    await generateCompanionReply(input(), { ...config(), model: mode === 'text-model' ? 'deepseek-v4-pro' : 'gpt-4o' }, undefined, { fetchFn, loop: true, turns: [value],
      toolImages: mode === 'withdrawn' ? [] : [{ ...visual(snapshot()), ...(mode === 'foreign' ? { callId: 'different_call' } : {}), ...(mode === 'corrupt' ? { base64: 'AAAA' } : {}) }] });
    expect(images(observed)).toHaveLength(0); expect(JSON.stringify(observed)).not.toContain(pixels);
    expect(base(observed, 'openai_chat').toolVisionManifest?.some((item: { delivery: string }) => item.delivery === 'image_provided')).toBeFalsy();
  }
});
it('retries an explicit tool-image rejection once on the same model with no stale visual success claim', async () => {
  const requests: Record<string, unknown>[] = [], fetchFn: typeof fetch = async (_url, init) => { requests.push(JSON.parse(String(init?.body))); return requests.length === 1
    ? new Response('{"error":{"code":"unsupported_image_input"}}', { status: 400 }) : envelope('openai_chat'); };
  await generateCompanionReply(input(), config(), undefined, { fetchFn, loop: true, turns: [turn()], toolImages: [visual(snapshot())] });
  expect(requests).toHaveLength(2); expect(requests.every(body => body.model === 'gpt-4o')).toBe(true); expect(images(requests[1])).toHaveLength(0);
  expect(base(requests[1]!, 'openai_chat').toolVisionManifest[0]).toMatchObject({ delivery: 'path_only', reason: 'provider_rejected_images' });
});
it('refreshes actual attachment paths or withdrawal on a frozen loop without automatically reading all uploaded pixels', async () => {
  const value = input(), fileInputs = [{ messageId: 'source', attachmentId: 'upload', name: 'photo.png', mime: 'image/png', path: 'C:\\old-private\\photo.png', available: true }], frozen = buildCompanionContext({ ...value, fileInputs });
  for (const current of [[{ ...fileInputs[0]!, path: 'C:\\current\\photo.png', available: false }], []]) {
    let observed!: Record<string, unknown>; const fetchFn: typeof fetch = async (_url, init) => { observed = JSON.parse(String(init?.body)); return envelope('openai_chat'); };
    await generateCompanionReply({ ...value, fileInputs: current }, config(), undefined, { fetchFn, loop: true, context: frozen });
    expect(base(observed, 'openai_chat').files).toEqual(current.length ? current : undefined); expect(JSON.stringify(observed)).not.toContain('old-private'); expect(images(observed)).toHaveLength(0);
  }
});
