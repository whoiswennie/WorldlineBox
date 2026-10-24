import { createRequire } from 'node:module';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
interface Clock { now: string; timeZone: string }
interface Row { text: string; score: number; source?: string; diff_days?: number; decay_factor?: number }
interface Rag { timeParser: { defaultTimezone: string; parse(text: string): Array<{ start: Date; end: Date }> }; _applyTimeDecay(rows: Row[], match: RegExpMatchArray, options: object): Row[];
  vectorDBManager: { getDiaryDateIndex(name: string): Promise<Array<{ relativePath: string; date: string }>> };
  _getDiaryDateIndexCached(name: string): Promise<Array<{ relativePath: string; date: string; diaryDate: Date }>> }
const { createRagQueryClock } = require('../../src/main/vcp-memory/peripherals.cjs') as {
  createRagQueryClock(): { load(file: string): Rag; run<T>(clock: Clock | undefined, operation: () => T): T };
};
const clock = (day: number): Clock => ({ now: `2035-03-${String(day).padStart(2, '0')}T00:00:00+08:00`, timeZone: 'Asia/Shanghai' });
const pathToRag = path.resolve('vendor/vcp-memory/Plugin/RAGDiaryPlugin/RAGDiaryPlugin.js');

describe('request-local dayjs injection into frozen VCP modules', () => {
  it('keeps yesterday and original exponential decay deterministic when a world pauses or advances rapidly', () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const adapter = createRagQueryClock(), rag = adapter.load(pathToRag), match = '::TimeDecay10/0'.match(/::TimeDecay(\d+)?(?:\/(\d+\.?\d*))?/u)!;
      const source = { text: '[2035-03-01] alpha historical event', score: 1 };
      const run = (day: number) => adapter.run(clock(day), () => ({ yesterday: rag.timeParser.parse('昨天'), decayed: rag._applyTimeDecay([{ ...source }], match, {}) }));
      const first = run(11), paused = run(11), accelerated = run(21);
      expect(first.yesterday[0]!.start.toISOString()).toBe('2035-03-09T16:00:00.000Z');
      expect(paused).toEqual(first);
      expect(accelerated.yesterday[0]!.start.toISOString()).toBe('2035-03-19T16:00:00.000Z');
      expect(first.decayed[0]).toMatchObject({ diff_days: 10, decay_factor: .5, score: .5 });
      expect(accelerated.decayed[0]).toMatchObject({ diff_days: 20, decay_factor: .25, score: .25 });
      expect(adapter.run(clock(21), () => rag._applyTimeDecay([{ ...source, source: 'time' }], match, {}))[0]).toEqual({ ...source, source: 'time' });
      expect(source.score).toBe(1);
    } finally { logs.mockRestore(); }
  });
  it('isolates overlapping asynchronous request clocks and leaves global Date and native no-clock behavior intact', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const adapter = createRagQueryClock(), rag = adapter.load(pathToRag), match = '::TimeDecay10/0'.match(/::TimeDecay(\d+)?(?:\/(\d+\.?\d*))?/u)!;
      const run = (day: number) => adapter.run(clock(day), async () => { await Promise.resolve(); return rag._applyTimeDecay([{ text: '[2035-03-01] alpha', score: 1 }], match, {})[0]!.score; });
      const before = Date.now(); expect(await Promise.all([run(11), run(21)])).toEqual([.5, .25]); expect(Date.now() - before).toBeLessThan(2000);
      expect(adapter.run(undefined, () => rag._applyTimeDecay([{ text: '[2035-03-01] alpha', score: 1 }], match, {}))[0]!.diff_days).toBe(0);
      expect(() => adapter.run({ now: 'bad', timeZone: 'Asia/Shanghai' }, () => true)).toThrow('Invalid VCP query clock');
      expect(() => adapter.run({ ...clock(11), timeZone: 'Invalid/Zone' }, () => true)).toThrow('timezone');
    } finally { logs.mockRestore(); }
  });
  it('aligns projected civil dates and AIMemo prompt dates with midnight and DST query zones, preserving absolute inputs', async () => {
    const logs = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const adapter = createRagQueryClock(), rag = adapter.load(pathToRag);
      const Handler = adapter.load(path.resolve('vendor/vcp-memory/Plugin/RAGDiaryPlugin/AIMemoHandler.js')) as unknown as new (plugin: Rag) => { _buildPrompt(k: string, u: string, a: string, template: string): string };
      const handler = new Handler(rag), match = '::TimeDecay180/0'.match(/::TimeDecay(\d+)?(?:\/(\d+\.?\d*))?/u)!;
      const cases = [
        { zone: 'Asia/Shanghai', now: '2035-03-11T00:30:00Z', day: '2035-03-11', start: '2035-03-10T16:00:00.000Z', age: 0 },
        { zone: 'UTC', now: '2035-03-11T00:30:00Z', day: '2035-03-10', start: '2035-03-10T00:00:00.000Z', age: 1 },
        { zone: 'America/Los_Angeles', now: '2035-03-11T00:30:00Z', day: '2035-03-10', start: '2035-03-10T08:00:00.000Z', age: 0 },
        { zone: 'America/New_York', now: '2026-03-09T04:30:00Z', day: '2026-03-08', start: '2026-03-08T05:00:00.000Z', age: 1 },
        { zone: 'America/New_York', now: '2026-11-02T05:30:00Z', day: '2026-11-01', start: '2026-11-01T04:00:00.000Z', age: 1 },
      ];
      for (const test of cases) {
        rag.vectorDBManager = { getDiaryDateIndex: async () => [{ relativePath: 'projected.md', date: test.day }, { relativePath: 'absolute.md', date: '2035-03-10T23:30:00-07:00' }] };
        const absolute = (await adapter.run(undefined, () => rag._getDiaryDateIndexCached('memories'))).find(row => row.relativePath === 'absolute.md')!.diaryDate;
        const actual = await adapter.run({ now: test.now, timeZone: test.zone }, async () => ({ index: await rag._getDiaryDateIndexCached('memories'),
          prompt: handler._buildPrompt('', '', '', '{{Date}} {{Time}}'), decay: rag._applyTimeDecay([{ text: `[${test.day}] alpha event`, score: 1 }], match, {})[0]! }));
        expect(actual.index.find(row => row.relativePath === 'projected.md')!.diaryDate.toISOString(), test.zone).toBe(test.start);
        expect(actual.index.find(row => row.relativePath === 'absolute.md')!.diaryDate).toEqual(absolute);
        expect(actual.prompt).toBe(new Intl.DateTimeFormat('sv', { timeZone: test.zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(test.now)));
        expect(actual.decay.diff_days, test.zone).toBe(test.age);
        expect(actual.decay.decay_factor).toBeCloseTo(Math.pow(.5, test.age / 180), 12);
      }
    } finally { logs.mockRestore(); }
  });
});
