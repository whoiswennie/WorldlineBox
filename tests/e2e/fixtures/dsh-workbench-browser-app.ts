import { app, BrowserWindow, clipboard } from 'electron';
import { createServer } from 'node:http';
import { mkdirSync } from 'node:fs';
import { configureWorkbenchBrowser } from '../../../src/main/dsh/workbench-browser';

mkdirSync(process.env.WORLDLINEBOX_BROWSER_FIXTURE_PROFILE!, { recursive: true });
app.setPath('userData', process.env.WORLDLINEBOX_BROWSER_FIXTURE_PROFILE!);
const opened: string[] = []; const issues: string[] = [];
const server = createServer((_request, response) => {
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html><title>DSH browser contract fixture</title><button id="login">模拟网页登录</button><button id="copy">复制</button><output id="result"></output><script>
    document.querySelector('#login').onclick=()=>{const popup=window.open('about:blank','_blank');if(popup){popup.opener=null;setTimeout(()=>popup.location.replace('https://platform.deepseek.com/dsh/authorize?fixture=1'),200)}};
    document.querySelector('#copy').onclick=async()=>{try{await navigator.clipboard.writeText('WorldlineBox synthetic clipboard');document.querySelector('#result').textContent='copied'}catch(error){document.querySelector('#result').textContent=error.name}};
  </script>`);
});
void app.whenReady().then(async () => {
  const snapshot = { text: clipboard.readText(), html: clipboard.readHTML(), rtf: clipboard.readRTF() };
  const canRestoreClipboard = clipboard.availableFormats().every(format => ['text/plain', 'text/html', 'text/rtf'].includes(format));
  (globalThis as unknown as { fixture: unknown }).fixture = { opened, issues, canRestoreClipboard,
    clipboardMatches: () => clipboard.readText() === 'WorldlineBox synthetic clipboard',
    restoreClipboard: () => { if (canRestoreClipboard) clipboard.write(snapshot); } };
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as { port: number }; const url = `http://127.0.0.1:${address.port}/`;
  const window = new BrowserWindow({ show: true, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
  configureWorkbenchBrowser(window, url, { onIssue: message => issues.push(message), openExternal: async value => { opened.push(value); } });
  await window.loadURL(url); window.focus();
});
app.on('window-all-closed', () => app.quit()); app.on('will-quit', () => server.close());
