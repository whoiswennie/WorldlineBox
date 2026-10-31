import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, it } from 'vitest';

type NativeSource = { id: string; textHash: string; text: string };
interface Observation {
  contextReferences: Array<{ id: string; textHash: string; role: string }>;
  nativeSources: NativeSource[];
  beginContext(): void;
  observeCandidateRows(rows: object[]): void;
  observeContextRows(rows: object[], role: string): void;
  prepareRecall(messages: object[], clock?: object): Promise<{ nativeSources: NativeSource[] }>;
  load(name: string): Promise<object>;
  preprocess(messages: object[]): Promise<object>;
}
const { VcpMemoryPeripherals } = createRequire(import.meta.url)(path.resolve('src/main/vcp-memory/peripherals.cjs')) as {
  VcpMemoryPeripherals: new (runtime: object, configuration: object) => Observation;
};
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
const fixture = () => new VcpMemoryPeripherals({ kb: {}, scopeRoot: 'unused', fileIds: new Map([['original.txt', 'note_one']]) }, {});

it('captures only actual returned formatter chunks, binding unchanged fragment bytes to their observed id and hash', async () => {
  const observer = fixture(); observer.beginContext();
  const row = { fullPath: '/native/original.txt', text: '  实际返回的第二段。  ' };
  observer.observeCandidateRows([{ fullPath: '/native/original.txt', text: '候选淘汰片段，不应被当作返回。' }]);
  observer.observeContextRows([{ ...row, text: '额外聚焦输入。' }], 'focus_input');
  observer.observeContextRows([row, row], 'returned');
  expect(observer.nativeSources).toEqual([{ id: 'note_one', textHash: digest('实际返回的第二段。'), text: '实际返回的第二段。' }]);
  expect(observer.contextReferences).toContainEqual(expect.objectContaining({ id: 'note_one', role: 'returned', textHash: digest('实际返回的第二段。') }));
  observer.load = async () => ({ aiMemoHandler: { processAIMemoPlusAggregated: () => undefined } });
  observer.preprocess = async () => ({ messages: [], events: [] });
  const packet = await observer.prepareRecall([]);
  observer.nativeSources[0]!.text = 'later mutation';
  expect(packet.nativeSources[0]!.text).toBe('实际返回的第二段。');
});

it('does not reuse raw source bytes or invent a note id across formatter observation windows', () => {
  const observer = fixture(); observer.beginContext();
  observer.observeContextRows([{ fullPath: '/native/original.txt', text: '前轮的正文。' }], 'returned');
  observer.beginContext(); observer.observeContextRows([{ fullPath: '/native/unmapped.txt', text: '没有可信对应的正文。' }], 'returned');
  expect(observer.nativeSources).toEqual([]); expect(observer.contextReferences).toEqual([]);
});
