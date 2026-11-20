import { _electron, expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { BOT_EVENT_CHANNEL, type WorldlineBoxBotApi } from '../../src/shared/companion-bot';
import { BILIBILI_LOGIN_URL, BROWSER_PARTITION } from '../../src/shared/bilibili';
import { electronLaunchEnv, removeCompanionTestDirectory, resolveElectronAppPath, resolveElectronExecutablePath } from './electron-test-helpers';
import { enableCallVisualFixture } from './fixtures/call-visual-binding';

// eslint-disable-next-line no-empty-pattern -- Playwright requires this signature.
test('video attachment offers built-in login once and reuses the browser account', async ({}) => {
  test.setTimeout(90000);
  const root = await mkdtemp(path.join(tmpdir(),'wb-video-login-'));
  const app = await _electron.launch({executablePath:resolveElectronExecutablePath(),args:[resolveElectronAppPath()],
    env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_DSH_SILENT:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:root})});
  try {
    const page = await app.firstWindow();
    await expect(page.locator('[data-dsh-launcher]')).toBeVisible();
    // Substitute only the remote website. UI navigation, shared Chromium storage,
    // account probe, topic connection and both preload bridges remain real.
    await app.evaluate(({session},partition) => {
      const scope = session.fromPartition(partition);
      scope.protocol.handle('https', async request => {
        const url = new URL(request.url);
        if (url.host === 'api.bilibili.com' && url.pathname === '/x/web-interface/nav') {
          const signed = (await scope.cookies.get({url:request.url,name:'fixture_account'})).length > 0;
          return Response.json({code:signed ? 0 : -101,data:{isLogin:signed}});
        }
        if (url.host === 'passport.bilibili.com') {
          await scope.cookies.set({url:url.origin, domain:'.bilibili.com',name:'fixture_account',value:'active'});
          return new Response('<title>Fixture sign-in</title>');
        }
        if (url.host === 'player.bilibili.com') return new Response(`<title>Bilibili player fixture</title>
          <main><button class="bpx-player-ctrl-full" style="position:fixed;bottom:0;right:0">进入全屏</button></main>
          <script>
            const control = document.querySelector('button');
            control.onclick = () => document.fullscreenElement ? document.exitFullscreen() : document.querySelector('main').requestFullscreen();
            document.onfullscreenchange = () => control.textContent = document.fullscreenElement ? '退出全屏' : '进入全屏';
          </script>`,{headers:{'content-type':'text/html; charset=utf-8'}});
        return new Response('',{status:404});
      });
    }, BROWSER_PARTITION);
    const chat = page.getByRole('button',{name:'伙伴',exact:true});
    await chat.click();
    await expect(page.getByRole('button',{name:'拨打伙伴电话'})).toBeVisible();
    await enableCallVisualFixture(app,page);
    const attach = async () => {
      await page.getByRole('button',{name:'应用',exact:true}).click();
      await page.getByRole('button',{name:'哔哩哔哩视频',exact:true}).click();
    };
    await attach();
    const dialog = page.getByRole('dialog',{name:'尚未登录哔哩哔哩'});
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button',{name:'前往内置浏览器登录'}).click();
    await expect(page.locator('.browser-address input')).toHaveValue(BILIBILI_LOGIN_URL);
    await expect.poll(() => app.evaluate(({session},partition) => session.fromPartition(partition).cookies.get({name:'fixture_account'}).then(c => c.length), BROWSER_PARTITION)).toBe(1);
    await chat.click();
    await expect(page.getByRole('button',{name:'拨打伙伴电话'})).toBeVisible();
    await enableCallVisualFixture(app,page);
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button',{name:'移除哔哩哔哩视频'})).toBeVisible();
    await page.getByRole('button',{name:'移除哔哩哔哩视频'}).click();
    await attach();
    await expect(page.getByRole('button',{name:'移除哔哩哔哩视频'})).toBeVisible();
    await expect(page.locator('dialog.bot-video-login')).toHaveCount(0);

    const room = await page.evaluate(async () => {
      const api = (Reflect.get(window,'worldlinebox') as {companionBot: WorldlineBoxBotApi}).companionBot;
      const state = (await api.request({type:'state'})).snapshot!;
      const conversation = state.conversations.find(item=>item.kind === 'direct')!;
      const actor = state.companions.find(item=>conversation.memberIds.includes(item.id))!;
      return {id:conversation.id, actorId:actor.id, name:actor.name};
    });
    await app.evaluate(({app,BrowserWindow}, {room,channel}) => {
      const {DatabaseSync} = process.getBuiltinModule('node:sqlite');
      const {join} = process.getBuiltinModule('node:path');
      const db = new DatabaseSync(join(app.getPath('userData'),'companion-bot-v2','bot.sqlite'));
      const card = {id:'video-e2e',title:'测试视频',videoId:'BV1B7411m7LV',page:1};
      try {
        db.exec('PRAGMA busy_timeout=1000; BEGIN IMMEDIATE');
        db.prepare(`INSERT INTO bot_messages(id,event_id,conversation_id,sender_id,sender_name,sender_type,content,status,kind,correlation_id,created_at)
          VALUES('reply-video','reply-video',?,?,?,'companion','','sent','message','reply-video',?)`).run(room.id,room.actorId,room.name,new Date().toISOString());
        db.prepare(`INSERT INTO bot_reply_parts(message_id,event_id,conversation_id,id,sequence,payload_json) VALUES('reply-video','reply-video',?,?,1,?)`)
          .run(room.id,card.id,JSON.stringify({id:card.id,kind:'video',sequence:1,video:card}));
        db.exec('COMMIT');
      } finally { db.close(); }
      const owner = BrowserWindow.getAllWindows().find(win=>win.webContents.getURL().includes('index.html'))!;
      owner.webContents.send(channel,{type:'changed',conversationId:room.id});
      owner.webContents.send(channel,{type:'video-present',conversationId:room.id,cardId:card.id,surface:'chat'});
    },{room,channel:BOT_EVENT_CHANNEL});
    const card = page.locator('[data-video-card="video-e2e"]');
    await expect(card.locator('webview')).toBeVisible();
    await expect.poll(() => app.evaluate(({session,webContents}, partition) =>
      webContents.getAllWebContents().some(wc => wc.getType()==='webview' && wc.getTitle()==='Bilibili player fixture' && wc.session===session.fromPartition(partition)),
    BROWSER_PARTITION)).toBe(true);
    const owner = await app.browserWindow(page);
    const previousBounds = await owner.evaluate(win => win.getBounds());
    const guestId = await card.locator('webview').evaluate(node => (node as Electron.WebviewTag).getWebContentsId());
    const playerControl = () => app.evaluate(({webContents}, id) =>
      webContents.fromId(id)!.executeJavaScript('document.querySelector("button").textContent'), guestId);
    const fullscreen = card.getByRole('button',{name:'全屏',exact:true});
    await fullscreen.click();
    await expect.poll(playerControl).toBe('退出全屏');
    await app.evaluate(async ({webContents}, id) => {
      const guest = webContents.fromId(id)!;
      const {x,y} = await guest.executeJavaScript(`(() => {
        const rect = document.querySelector('button').getBoundingClientRect();
        return { x: Math.floor(rect.x + rect.width / 2), y: Math.floor(rect.y + rect.height / 2) };
      })()`);
      guest.sendInputEvent({type:'mouseDown',button:'left',x,y,clickCount:1});
      guest.sendInputEvent({type:'mouseUp',button:'left',x,y,clickCount:1});
    }, guestId);
    const checkRestored = async () => {
      await expect.poll(playerControl).toBe('进入全屏');
      await expect.poll(()=>page.evaluate(()=>document.fullscreenElement === null)).toBe(true);
      await expect.poll(()=>owner.evaluate(win => win.isFullScreen())).toBe(false);
      await expect.poll(()=>owner.evaluate(win => win.getBounds())).toEqual(previousBounds);
      await expect(fullscreen).toBeVisible();
    };
    await checkRestored();
    await fullscreen.click();
    await expect.poll(playerControl).toBe('退出全屏');
    await app.evaluate(({webContents}, id) => {
      const guest = webContents.fromId(id)!;
      guest.sendInputEvent({type:'keyDown',keyCode:'Escape'});
      guest.sendInputEvent({type:'keyUp',keyCode:'Escape'});
    }, guestId);
    await checkRestored();
    await page.getByRole('button',{name:'启动器',exact:true}).click();
    await chat.click();
    await expect(card.getByRole('button',{name:'播放 测试视频'})).toBeVisible();
    await expect(card.locator('webview')).toHaveCount(0);
  } finally { await app.close(); removeCompanionTestDirectory(root); }
});
