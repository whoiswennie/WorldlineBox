import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {_electron as electron,expect,test} from '@playwright/test';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Owns actual native Electron windows.
test('sets the WorldlineBox Windows taskbar identity and logo for main and child windows',async({},testInfo)=>{
  test.skip(process.platform!=='win32','Windows shell property-store verification.');test.setTimeout(120000);
  const profile=await mkdtemp(path.join(tmpdir(),'wlb-taskbar-icon-'));
  const launch = () => electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile})});
  const link = path.join(profile, 'test-start-menu', '世界线盒子.lnk');
  let app = await launch();
  try{
    await app.firstWindow();
    const packaged = await app.evaluate(({app}) => app.isPackaged);
    if (packaged) {
      const exe = await app.evaluate(() => process.execPath);
      const staleIcon = path.join(profile, 'removed-install', 'app.ico');
      expect(await app.evaluate(({shell}, {link, staleIcon}) =>
        shell.writeShortcutLink(link, 'update', {icon: staleIcon, iconIndex: 0}), {link, staleIcon})).toBe(true);
      await app.close();
      app = await launch();
      await app.firstWindow();
      const shortcut = await app.evaluate(({shell}, link) => shell.readShortcutLink(link), link);
      expect(shortcut).toMatchObject({target: exe, icon: exe, iconIndex: 0, appUserModelId: 'com.worldlinebox.app'});
    }
    const shortcut = await app.evaluate(({shell}, link) => shell.readShortcutLink(link), link);
    const handles=await app.evaluate(({BrowserWindow})=>{
      const main=BrowserWindow.getAllWindows()[0]!,child=new BrowserWindow({show:false,title:'Native DSH child icon check',webPreferences:{sandbox:true}});
      return [main,child].map(win=>win.getNativeWindowHandle().readBigUInt64LE().toString());
    });
    const evidence=[];
    for(const handle of handles){
      const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tests/helpers/read-window-taskbar.ps1'),handle,shortcut.icon!,path.resolve('assets/icons/app.ico')]);
      const actual=JSON.parse(result.stdout.replace(/^\uFEFF/u,'')) as {appId:string;icon:string;displayName:string;relaunchCommand:string};
      expect(actual.appId).toBe(shortcut.appUserModelId);
      if (packaged) {
        expect(actual.icon).toBeFalsy();
        expect(actual.relaunchCommand).toBeFalsy();
      } else {
        expect(actual.icon.replace(/,0$/u, '')).toBe(shortcut.icon);
        expect(actual.displayName).toBe('WorldlineBox');
      }
      evidence.push(actual);
    }
    await testInfo.attach('windows-shell-properties',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
    await mkdir(path.resolve('artifacts/companion-topic-real'),{recursive:true});await writeFile(path.resolve('artifacts/companion-topic-real/windows-taskbar.json'),JSON.stringify(evidence,null,2));
  }finally{await app.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
