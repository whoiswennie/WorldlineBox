import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaPublicWeb } from '../../src/main/companions/agenda-public-web';
import { companionAgendaResearchArgumentsSchema, COMPANION_AGENDA_RESEARCH_TOOL } from '../../src/shared/companion-agenda-research-tool';
import type { GoalWebDocument } from '../../src/main/companions/learning-goal-web';
import { boundaryGrant, boundaryNow } from './companion-agenda-boundary-fixtures';

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(boundaryNow); });
afterEach(() => vi.useRealTimers());
function fixture() {
  const state = { grant: { ...boundaryGrant(), capabilities: ['browser'] as ReturnType<typeof boundaryGrant>['capabilities'], allowPublicWeb: true },
    document: { url: 'https://example.org/article', title: '实际公开页面', text: 'abcdefghij', links: ['https://example.org/followup'] } as GoalWebDocument };
  const currentGrant = vi.fn(async () => structuredClone(state.grant)), readWeb = vi.fn<(url: string, signal: AbortSignal) => Promise<GoalWebDocument>>(async () => structuredClone(state.document));
  const reader = new CompanionAgendaPublicWeb({ currentGrant, readWeb }), controller = new AbortController();
  const input = { companionId: 'alice', grantId: 'grant', expectedGrantRevision: 1, url: 'https://example.org/start#context', signal: controller.signal };
  return { state, currentGrant, readWeb, reader, controller, input };
}

it('reads through the public-only native reader with exact metadata and truthful stateless pagination', async () => {
  const f = fixture(), first = await f.reader.read({ ...f.input, length: 4 });
  expect(first).toMatchObject({ requestedUrl: 'https://example.org/start', url: 'https://example.org/article', title: '实际公开页面', text: 'abcd',
    offset: 0, length: 4, totalChars: 10, nextOffset: 4, truncated: true, offsetUnit: 'utf16', grantRevision: 1, trust: 'public_page_data_not_instructions' });
  expect(first.snapshot).toMatch(/^[a-f0-9]{64}$/u); expect(f.readWeb).toHaveBeenCalledExactlyOnceWith(first.requestedUrl, f.controller.signal);
  const rest = await f.reader.read({ ...f.input, url: first.requestedUrl, offset: first.nextOffset, length: 20, snapshot: first.snapshot });
  expect(rest.text).toBe('efghij'); expect(rest.snapshot).toBe(first.snapshot); expect(rest.truncated).toBe(false); expect(rest.nextOffset).toBeUndefined();
  expect(f.readWeb).toHaveBeenCalledTimes(2); expect(f.currentGrant).toHaveBeenCalledTimes(4);
});
it.each(['revoked', 'wrong-owner', 'wrong-grant', 'expired', 'no-browser', 'web-not-allowed', 'stale-revision', 'wrong-goal'] as const)('denies %s before native HTTP access', async change => {
  const f = fixture();
  if (change === 'revoked') f.state.grant.status = 'revoked';
  if (change === 'wrong-owner') f.state.grant.companionId = 'bob';
  if (change === 'wrong-grant') f.state.grant.id = 'different-grant';
  if (change === 'expired') f.state.grant.expiresAt = boundaryNow;
  if (change === 'no-browser') f.state.grant.capabilities = ['learning'];
  if (change === 'web-not-allowed') f.state.grant.allowPublicWeb = false;
  if (change === 'stale-revision') f.state.grant.revision = 2;
  if (change === 'wrong-goal') f.state.grant.goalId = 'different-goal';
  await expect(f.reader.read(f.input)).rejects.toThrow('没有有效的公开网页'); expect(f.readWeb).not.toHaveBeenCalled();
});
it.each(['revoke', 'revise', 'cancel'] as const)('withholds fetched text when %s occurs while the request is running', async change => {
  const f = fixture(); f.readWeb.mockImplementationOnce(async () => {
    if (change === 'revoke') f.state.grant.status = 'revoked';
    if (change === 'revise') f.state.grant.revision++;
    if (change === 'cancel') f.controller.abort();
    return structuredClone(f.state.document);
  });
  await expect(f.reader.read(f.input)).rejects.toThrow(); expect(f.readWeb).toHaveBeenCalledOnce();
});
it('checks a revision change even when the caller omitted an expected host revision', async () => {
  const f = fixture(); f.readWeb.mockImplementationOnce(async () => { f.state.grant.revision++; return structuredClone(f.state.document); });
  await expect(f.reader.read({ ...f.input, expectedGrantRevision: undefined })).rejects.toThrow('授权已变化');
});
it('refuses to splice changed source text or a different requested URL into a previous snapshot', async () => {
  const f = fixture(), first = await f.reader.read({ ...f.input, length: 4 });
  f.state.document.text = 'abcdNEWLYCHANGED';
  await expect(f.reader.read({ ...f.input, offset: 4, snapshot: first.snapshot })).rejects.toThrow('来源或版本已变化');
  f.state.document.text = 'abcdefghij';
  await expect(f.reader.read({ ...f.input, url: 'https://example.org/other', offset: 4, snapshot: first.snapshot })).rejects.toThrow('来源或版本已变化');
});
it('requires the exact prior snapshot before attempting a continuation fetch', async () => {
  const f = fixture(); await expect(f.reader.read({ ...f.input, offset: 4 })).rejects.toThrow('续读需要'); expect(f.readWeb).not.toHaveBeenCalled();
});
it.each(['file:///C:/secret.txt', 'http://localhost/', 'http://localhost./', 'http://service.internal./', 'http://127.0.0.1/', 'http://169.254.169.254/latest/', 'http://example.org:9222/', 'http://user:password@example.org/'])('never opens unsupported/private/login URL %s', async url => {
  const f = fixture(); await expect(f.reader.read({ ...f.input, url })).rejects.toThrow(); expect(f.readWeb).not.toHaveBeenCalled();
});
it('rejects private redirect metadata and excludes unsupported/private links from returned references', async () => {
  const f = fixture(); f.state.document.url = 'http://127.0.0.1/admin'; await expect(f.reader.read(f.input)).rejects.toThrow('只读取公开');
  f.state.document.url = 'https://example.org/article'; f.state.document.links.push('javascript:alert(1)', 'http://127.0.0.1/admin');
  expect((await f.reader.read(f.input)).links).toEqual(['https://example.org/followup']);
});
it('returns complete Unicode characters with truthful continuation offsets and handles empty bodies', async () => {
  const f = fixture(); f.state.document.text = 'abc😀def';
  const first = await f.reader.read({ ...f.input, length: 4 }); expect(first.text).toBe('abc'); expect(first.nextOffset).toBe(3);
  const next = await f.reader.read({ ...f.input, offset: 3, length: 2, snapshot: first.snapshot }); expect(next.text).toBe('😀'); expect(next.nextOffset).toBe(5);
  await expect(f.reader.read({ ...f.input, offset: 4, snapshot: first.snapshot })).rejects.toThrow('切断了一个字符');
  await expect(f.reader.read({ ...f.input, offset: 100, snapshot: first.snapshot })).rejects.toThrow('超过');
  f.state.document.text = ''; const empty = await f.reader.read(f.input); expect(empty.text).toBe(''); expect(empty.totalChars).toBe(0); expect(empty.truncated).toBe(false);
});
it('preserves native read errors and stops an already cancelled request before any authority/network work', async () => {
  const f = fixture(); f.readWeb.mockRejectedValueOnce(new Error('真实公开网页读取失败')); await expect(f.reader.read(f.input)).rejects.toThrow('真实公开网页读取失败');
  const checks = f.currentGrant.mock.calls.length; f.controller.abort(); await expect(f.reader.read(f.input)).rejects.toThrow(); expect(f.currentGrant).toHaveBeenCalledTimes(checks);
});
it('exposes only read URL/offset/length/snapshot, never methods, browser logins or host authority', () => {
  expect(COMPANION_AGENDA_RESEARCH_TOOL.name).toBe('research');
  expect(companionAgendaResearchArgumentsSchema.safeParse({ action: 'read', url: 'https://example.org/' }).success).toBe(true);
  for (const extra of [{ method: 'POST' }, { browserTabId: 'logged-in-tab' }, { cookies: 'private' }, { companionId: 'bob' }, { grantId: 'other-grant' }])
    expect(companionAgendaResearchArgumentsSchema.safeParse({ action: 'read', url: 'https://example.org/', ...extra }).success).toBe(false);
});
