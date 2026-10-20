import { app, BrowserWindow } from 'electron';
import { createServer } from 'node:http';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BrowserAiService } from '../../../src/main/browser/ai-service';
import { getApplicationNetwork, closeApplicationNetwork } from '../../../src/main/application-network';
import { BrowserService } from '../../../src/main/browser/service';

const root = process.env.WORLDLINEBOX_BROWSER_AI_LIVE_ROOT;
const key = process.env.WORLDLINEBOX_BROWSER_AI_LIVE_KEY;
delete process.env.WORLDLINEBOX_BROWSER_AI_LIVE_KEY;
if (!root || !key) throw Error('An isolated root and explicit live-test credential are required.');
app.setPath('userData', path.join(root, 'profile'));
app.whenReady().then(async () => {
  await getApplicationNetwork();
  const service = new BrowserAiService(path.join(root, 'browser'), {
    getConfig: () => ({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: key }),
    changed: () => undefined, context: () => ({ activeTabId: 'live-research', tabs: [{ id: 'live-research', url: 'about:blank' }] }),
    hasTab: id => id === 'live-research', showResults: async () => undefined,
    tool: async () => ({ unavailable: 'This live test only exercises real public web search/fetch, not page actions.' }),
  });
  try {
    await service.init(); await service.handle({ type: 'ai.key.save', key });
    await service.handle({ type: 'ai.start', tabId: 'live-research', mode: 'research',
      query: '这是实际接口验收：使用 browser_search 查找 Electron WebContentsView 官方英文文档。搜索词必须使用 site:electronjs.org 和 lang:en，count=3；本问题没有日期条件，不要擅自添加。然后用 browser_fetch 抓取一个官方结果，依据正文用中文概括两句并给出真实来源引用。不要操作浏览器页面。' });
    const started = Date.now();
    while (['running', 'approval'].includes(service.state().task?.status ?? '')) {
      if (Date.now() - started > 150000) { const task = service.state().task!; await service.handle({ type: 'ai.cancel', tabId: task.tabId, taskId: task.id }); }
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const task = service.state().task!;
    const search = task.tools.find(tool => tool.name === 'browser_search' && tool.status === 'completed');
    const fetched = task.tools.find(tool => tool.name === 'browser_fetch' && tool.status === 'completed');
    const passed = task.status === 'completed' && !!search && !!fetched && !!task.sources.find(source => source.kind === 'fetched' && source.content.length > 100) && task.answer.includes('https://');
    const server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end('<!doctype html><title>Native workflow acceptance</title><style>body{padding:40px;font:18px system-ui}input,button{padding:12px}</style><h1>浏览器动作验收</h1><label>Search phrase <input aria-label="Search phrase" id="query"></label><button id="run">运行查询</button><p id="result">No query yet</p><script>document.querySelector("#run").onclick=()=>document.querySelector("#result").textContent="Result for "+document.querySelector("#query").value;</script>'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); if (!address || typeof address === 'string') throw Error('Missing acceptance port');
    const url = `http://127.0.0.1:${address.port}/page`;
    const host = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
    host.setOpacity(0); host.setFocusable(false); await host.loadURL('about:blank'); host.showInactive();
    const browser = new BrowserService(() => host, path.join(root, 'native-browser'), undefined, undefined, undefined,
      () => ({ apiFormat: 'openai_chat', model: 'deepseek-flash', baseUrl: 'https://api.deepseek.com', apiKey: key }));
    await browser.handle({ type: 'activate' }); await browser.handle({ type: 'layout', visible: true, bounds: { x: 0, y: 0, width: 1100, height: 780 } });
    await browser.handle({ type: 'ai.start', tabId: browser.state().activeTabId!, mode: 'followup',
      query: `这是本机无敏感数据的动作验收。不要搜索网络或使用远程抓取。打开 ${url} ，观察页面，将 Search phrase 输入框填写为 native-check，点击“运行查询”，然后重新阅读页面并告诉我实际结果。只做这些操作，不需要修改其他设置。` });
    const nativeStarted = Date.now();
    while (['running', 'approval'].includes(browser.state().ai?.task?.status ?? '')) {
      const current = browser.state().ai!.task!;
      if (current.approval) await browser.handle({ type: 'ai.approve', taskId: current.id, actionId: current.approval.id, allow: current.approval.description.includes('运行查询') });
      if (Date.now() - nativeStarted > 150000) await browser.handle({ type: 'ai.cancel', tabId: current.tabId, taskId: current.id });
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const nativeTask = browser.state().ai!.task!;
    const { webContents } = await import('electron');
    const actual = await webContents.getAllWebContents().find(contents => contents.getURL() === url)?.executeJavaScript('document.querySelector("#result").textContent');
    const nativePassed = nativeTask.status === 'completed' && actual === 'Result for native-check' && nativeTask.answer.includes('native-check');
    const nativeWorkflow = { passed: nativePassed, status: nativeTask.status, actual, answer: nativeTask.answer, error: nativeTask.error,
      durationMs: Date.now() - nativeStarted, tools: nativeTask.tools.map(({ name, status }) => ({ name, status })) };
    await browser.shutdown(); host.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    const receipt = { passed: passed && nativePassed, status: task.status, model: task.model, toolCalls: task.tools.map(({ name, status, input }) => ({ name, status, input })), nativeWorkflow,
      sources: task.sources.map(({ id, title, url, kind, content }) => ({ id, title, url, kind, contentCharacters: content.length })), answer: task.answer,
      error: task.error, durationMs: Date.now() - started, contextBytes: task.contextBytes };
    const serialized = JSON.stringify(receipt, null, 2); if (serialized.includes(key)) throw Error('Live receipt unexpectedly contains a credential.');
    await writeFile(path.join(root, 'result.json'), serialized, { mode: 0o600 });
    console.log(JSON.stringify({ passed: receipt.passed, status: task.status, tools: task.tools.map(({ name, status }) => ({ name, status })), sources: task.sources.length, durationMs: receipt.durationMs, error: task.error, nativeWorkflow: { ...nativeWorkflow, answer: undefined } }));
    await service.shutdown(); await closeApplicationNetwork(); app.exit(receipt.passed ? 0 : 1);
  } catch {
    await service.shutdown().catch(() => undefined); await closeApplicationNetwork().catch(() => undefined);
    console.error('Live browser AI verification failed. No credentials were logged.'); app.exit(1);
  }
});
