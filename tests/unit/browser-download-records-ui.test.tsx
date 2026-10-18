// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import { BrowserDownloadRecords } from '../../src/renderer/browser/BrowserDownloadRecords';
import { browserEn, browserZh } from '../../src/renderer/browser/messages';
import type { BrowserDownload } from '../../src/shared/browser';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement; let root: Root;
afterEach(async () => { await act(() => root?.unmount()); host?.remove(); });
function records(count: number): BrowserDownload[] {
  return Array.from({ length: count }, (_, index) => ({ id: 'download-' + index, filename: 'file-' + index + '.zip',
    url: 'https://downloads.example.test/' + index, path: 'C:\\Downloads\\file-' + index + '.zip',
    received: 10, total: 100, status: 'completed', startedAt: '2026-10-18T00:00:00Z' }));
}
async function mount(downloads: BrowserDownload[], english = false) {
  const run = vi.fn();
  const labels = (english ? browserEn : browserZh) as unknown as Record<string, string>;
  const b = (key: string) => labels[key] ?? key;
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  const render = async (next: BrowserDownload[]) => act(() => root.render(<BrowserDownloadRecords downloads={next} run={run} b={b} />));
  await render(downloads);
  return { run, render };
}
function button(label: string): HTMLButtonElement {
  const value = [...host.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === label);
  if (!value) throw new Error('No button: ' + label); return value;
}
async function search(value: string): Promise<void> {
  const input = host.querySelector<HTMLInputElement>('input[type="search"]')!;
  await act(() => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
const names = () => [...host.querySelectorAll('.browser-downloads strong')].map(item => item.textContent);

it('paginates all records beyond the old 100-row cap in explicit 20-row pages', async () => {
  await mount(records(125)); expect(names()).toHaveLength(20);
  expect(button('上一页').disabled).toBe(true); expect(host.textContent).toContain('125 / 125');
  for (let page = 1; page < 7; page++) await act(() => button('下一页').click());
  expect(names()).toEqual(['file-120.zip', 'file-121.zip', 'file-122.zip', 'file-123.zip', 'file-124.zip']);
  expect(button('下一页').disabled).toBe(true); expect(host.textContent).toContain('7 / 7');
  await act(() => button('上一页').click()); expect(names()[0]).toBe('file-100.zip');
});

it('searches filename, URL, error text, and localized status without changing saved records', async () => {
  const values = records(4);
  values[0]!.filename = 'Special-Archive.ZIP'; values[1]!.url = 'https://media.other.test/asset';
  values[2]!.status = 'interrupted'; values[2]!.error = 'ERR_CONNECTION_RESET'; values[3]!.status = 'paused';
  const before = structuredClone(values); const { run } = await mount(values);
  for (const [query, filename] of [[' special-archive ', 'Special-Archive.ZIP'], ['MEDIA.OTHER', 'file-1.zip'],
    ['connection_reset', 'file-2.zip'], ['已暂停', 'file-3.zip'], ['interrupted', 'file-2.zip']]) {
    await search(query!); expect(names()).toEqual([filename]);
  }
  expect(values).toEqual(before); expect(run).not.toHaveBeenCalled();
});

it('combines status filtering with search and resets the page for either choice', async () => {
  const values = records(45); values[44]!.status = 'paused'; await mount(values);
  await act(() => button('下一页').click()); expect(names()[0]).toBe('file-20.zip');
  const filter = host.querySelector<HTMLSelectElement>('select')!;
  await act(() => { filter.value = 'paused'; filter.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(names()).toEqual(['file-44.zip']); expect(button('上一页').disabled).toBe(true);
  await search('file-0'); expect(names()).toHaveLength(0); expect(host.textContent).toContain('没有符合条件的下载记录');
  expect(button('下一页').disabled).toBe(true);
});

it('preserves every existing state-specific download action and record identity', async () => {
  const values = records(5);
  const statuses: BrowserDownload['status'][] = ['progressing', 'paused', 'completed', 'cancelled', 'interrupted'];
  values.forEach((item, index) => { item.status = statuses[index]!; });
  const { run } = await mount(values);
  const expected = [['pause', 'cancel'], ['resume', 'cancel'], ['open', 'reveal'], ['retry', 'reveal'], ['retry', 'reveal']];
  for (const [index, row] of [...host.querySelectorAll<HTMLLIElement>('.browser-downloads li')].entries()) {
    for (const [actionIndex, control] of [...row.querySelectorAll<HTMLButtonElement>('button')].entries()) {
      await act(() => control.click());
      expect(run).toHaveBeenLastCalledWith({ type: 'download.action', id: values[index]!.id, action: expected[index]![actionIndex] });
    }
  }
  expect(run).toHaveBeenCalledTimes(10);
});

it('clamps the selected page after records are cleared and stays there when new downloads arrive', async () => {
  const values = records(25); const { render } = await mount(values);
  await act(() => button('下一页').click()); expect(names()[0]).toBe('file-20.zip');
  await render(values.slice(0, 1)); expect(names()).toEqual(['file-0.zip']);
  expect(button('上一页').disabled).toBe(true); expect(button('下一页').disabled).toBe(true);
  await render(values); expect(names()[0]).toBe('file-0.zip'); expect(host.textContent).toContain('1 / 2');
  await render([]); expect(host.textContent).toContain('暂无下载记录'); expect(names()).toHaveLength(0);
});

it('localizes filters, pagination, result counts and no-match feedback in English', async () => {
  await mount(records(1), true);
  expect(host.querySelector('input')?.getAttribute('aria-label')).toBe('Search filename, URL, or error');
  expect(host.textContent).toContain('All statuses'); expect(host.textContent).toContain('Matching records');
  expect(button('Previous page').disabled).toBe(true); expect(button('Next page').disabled).toBe(true);
  await search('missing'); expect(host.textContent).toContain('No matching downloads.');
});
