import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CompanionAgendaObservation, type CompanionObservationSource } from '../../src/main/companions/agenda-observation';
import { boundaryGrant, boundaryNow } from './companion-agenda-boundary-fixtures';

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date(boundaryNow)); });
afterEach(() => vi.useRealTimers());
function fixture() {
  const binding: CompanionObservationSource = { id: 'window:1:0', title: '编辑器', displayId: 'display-1' };
  const state = { locked: false, grant: boundaryGrant(), sources: [binding] };
  const pixels = new Uint8Array([1, 2, 3]);
  const capture = vi.fn(async () => pixels), sources = vi.fn(async () => state.sources);
  const currentGrant = vi.fn(async () => state.grant);
  const observer = new CompanionAgendaObservation({ locked: () => state.locked, sources, currentGrant, capture });
  return { state, capture, sources, currentGrant, observer, pixels,
    input: { companionId: 'alice', grantId: 'grant', sourceId: binding.id, binding } };
}

it('returns only pixels for the exact explicitly selected source with a current grant', async () => {
  const f = fixture(), result = await f.observer.capture(f.input);
  expect(result.bytes).toBe(f.pixels); expect(result.source).toEqual(f.input.binding); expect(result.grantRevision).toBe(1);
  expect(f.capture).toHaveBeenCalledExactlyOnceWith(f.input.sourceId); expect(f.currentGrant).toHaveBeenCalledTimes(2);
});
it.each(['locked', 'revoked', 'wrong-owner', 'expired', 'no-observe', 'unselected', 'missing-source', 'renamed', 'display-changed', 'grant-binding-changed'] as const)('rejects %s before taking any pixels, without falling back to another source', async change => {
  const f = fixture();
  if (change === 'locked') f.state.locked = true;
  if (change === 'revoked') f.state.grant.status = 'revoked';
  if (change === 'wrong-owner') f.state.grant.companionId = 'bob';
  if (change === 'expired') f.state.grant.expiresAt = boundaryNow;
  if (change === 'no-observe') f.state.grant.capabilities = ['dsh'];
  if (change === 'unselected') f.state.grant.windowIds = ['screen:0:0'];
  if (change === 'missing-source') f.state.sources = [{ id: 'screen:0:0', title: '其他画面' }];
  if (change === 'renamed') f.state.sources = [{ ...f.input.binding, title: '另一个程序' }];
  if (change === 'display-changed') f.state.sources = [{ ...f.input.binding, displayId: 'display-2' }];
  if (change === 'grant-binding-changed') f.state.grant.captureSources = [{ ...f.input.binding, title: '新授权的另一个窗口' }];
  await expect(f.observer.capture(f.input)).rejects.toThrow(); expect(f.capture).not.toHaveBeenCalled();
});
it.each(['locked', 'revoked', 'revision', 'source-changed', 'abort'] as const)('withholds captured pixels if %s changes before delivery', async change => {
  const f = fixture(), controller = new AbortController();
  f.capture.mockImplementationOnce(async () => {
    if (change === 'locked') f.state.locked = true;
    if (change === 'revoked') f.state.grant = { ...f.state.grant, status: 'revoked' };
    if (change === 'revision') f.state.grant = { ...f.state.grant, revision: 2 };
    if (change === 'source-changed') f.state.sources = [{ ...f.input.binding, title: '窗口句柄被复用' }];
    if (change === 'abort') controller.abort();
    return f.pixels;
  });
  await expect(f.observer.capture({ ...f.input, signal: controller.signal })).rejects.toThrow(); expect(f.capture).toHaveBeenCalledTimes(1);
});
it('does not enumerate sources while locked or deliver empty/stale image substitutes', async () => {
  const f = fixture(); f.state.locked = true; expect(await f.observer.sources()).toEqual([]); expect(f.sources).not.toHaveBeenCalled();
  f.state.locked = false; f.capture.mockResolvedValueOnce(new Uint8Array());
  await expect(f.observer.capture(f.input)).rejects.toThrow('真实图像'); expect(f.capture).toHaveBeenCalledTimes(1);
});
