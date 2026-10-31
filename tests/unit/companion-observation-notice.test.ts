import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('electron', () => ({ BrowserWindow: vi.fn(() => { throw Error('Native notice must not be created in this unit test'); }), screen: {} }));
import { CompanionObservationNotice } from '../../src/main/companions/observation-notice';

const notices: CompanionObservationNotice[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime('2026-10-29T10:00:00.000Z'); });
afterEach(() => { for (const notice of notices.splice(0)) notice.close(); vi.useRealTimers(); });
function fixture() {
  const show = vi.fn(), hide = vi.fn(), close = vi.fn(), report = vi.fn();
  const notice = new CompanionObservationNotice({ surface: { show, hide, close }, report }); notices.push(notice);
  const enter = (owner = 'alice', key = owner) => notice.enter({ key, companionId: owner, name: owner === 'alice' ? '小肥鱼' : '大肥鱼' });
  return { notice, enter, show, hide, close, report };
}

it('combines different companion names and deduplicates simultaneous observations by one companion', () => {
  const f = fixture(), first = f.enter(), second = f.enter('alice', 'second');
  expect(f.show).toHaveBeenCalledTimes(1); expect(f.show).toHaveBeenLastCalledWith(['小肥鱼'], undefined);
  f.enter('bob'); expect(f.show).toHaveBeenLastCalledWith(['小肥鱼', '大肥鱼'], undefined);
  first(); expect(f.show).toHaveBeenCalledTimes(2); second(); expect(f.show).toHaveBeenLastCalledWith(['大肥鱼'], undefined);
});

it('hides after 3.5 seconds even if a long-running watch has not left', () => {
  const f = fixture(), leave = f.enter(); vi.advanceTimersByTime(3499); expect(f.hide).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(f.hide).toHaveBeenCalledOnce(); const shows = f.show.mock.calls.length;
  vi.advanceTimersByTime(120000); expect(f.show).toHaveBeenCalledTimes(shows); leave(true); expect(f.show).toHaveBeenCalledTimes(shows);
});

it('merges a new companion without extending the original display deadline', () => {
  const f = fixture(); f.enter(); vi.advanceTimersByTime(3000); f.enter('bob');
  expect(f.show).toHaveBeenLastCalledWith(['小肥鱼', '大肥鱼'], undefined); vi.advanceTimersByTime(500); expect(f.hide).toHaveBeenCalledOnce();
  vi.advanceTimersByTime(3000); expect(f.hide).toHaveBeenCalledOnce();
});

it('does not flash the same start notice for repeated short observations during its cooldown', () => {
  const f = fixture(); f.enter()(true); expect(f.show).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 8; i++) { vi.advanceTimersByTime(100); f.enter()(true); }
  expect(f.show).toHaveBeenCalledTimes(2); vi.advanceTimersByTime(2700); expect(f.hide).toHaveBeenCalledOnce();
  f.enter()(true); expect(f.show).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(6500); f.enter(); expect(f.show).toHaveBeenCalledTimes(3);
});

it.each([true, false])('shows a brief completion=%s receipt without creating a new timer', completed => {
  const f = fixture(), leave = f.enter(); vi.advanceTimersByTime(2000); leave(completed);
  expect(f.show).toHaveBeenLastCalledWith(['小肥鱼'], completed ? '刚刚看了看你这边的情况' : '这次留意已经停止');
  expect(vi.getTimerCount()).toBe(1); leave(completed); expect(f.show).toHaveBeenCalledTimes(2);
  vi.advanceTimersByTime(1500); expect(f.hide).toHaveBeenCalledOnce();
});

it('keeps replacement session tokens exact and close leaves no timers or delayed redisplay', () => {
  const f = fixture(), old = f.enter('alice', 'same-key'), replacement = f.enter('alice', 'same-key'); old(true);
  expect(f.show).toHaveBeenCalledTimes(1); replacement(true); expect(f.show).toHaveBeenCalledTimes(2);
  f.notice.close(); expect(f.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0);
  f.enter('bob')(); vi.advanceTimersByTime(20000); expect(f.show).toHaveBeenCalledTimes(2); expect(f.hide).not.toHaveBeenCalled();
});

it('reports a synchronous fake-surface error without breaking observation execution or timer cleanup', () => {
  const f = fixture(); f.show.mockImplementation(() => { throw Error('surface unavailable'); });
  const leave = f.enter(); expect(f.report).toHaveBeenCalledOnce(); expect(() => leave()).not.toThrow();
  vi.advanceTimersByTime(3500); expect(f.hide).toHaveBeenCalledOnce();
});
