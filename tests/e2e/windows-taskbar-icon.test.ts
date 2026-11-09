import {mkdtemp,rm,readFile,mkdir,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash} from 'node:crypto';
import {_electron as electron,expect,test} from '@playwright/test';
import {electronLaunchEnv,resolveElectronLaunchOptions} from './electron-test-helpers';

// eslint-disable-next-line no-empty-pattern -- Owns actual native Electron windows.
test('sets the WorldlineBox Windows taskbar identity and logo for main and child windows',async({},testInfo)=>{
  test.skip(process.platform!=='win32','Windows shell property-store verification.');test.setTimeout(120000);
  const profile=await mkdtemp(path.join(tmpdir(),'wlb-taskbar-icon-'));
  const app=await electron.launch({...resolveElectronLaunchOptions(),env:electronLaunchEnv({WORLDLINEBOX_E2E:'1',WORLDLINEBOX_E2E_PERF_OFFSCREEN:'1',WORLDLINEBOX_E2E_USER_DATA_PATH:profile})});
  try{
    await app.firstWindow();
    const handles=await app.evaluate(({BrowserWindow})=>{
      const main=BrowserWindow.getAllWindows()[0]!,child=new BrowserWindow({show:false,title:'Native DSH child icon check',webPreferences:{sandbox:true}});
      return [main,child].map(win=>win.getNativeWindowHandle().readBigUInt64LE().toString());
    });
    const evidence=[];
    for(const handle of handles){
      const result=await promisify(execFile)('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('tests/helpers/read-window-taskbar.ps1'),handle]);
      const actual=JSON.parse(result.stdout.replace(/^\uFEFF/u,'')) as {appId:string;icon:string;displayName:string;relaunchCommand:string};
      const iconPath=actual.icon.replace(/,\d+$/u,'').replace(/^"|"$/gu,''),hash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
      expect(actual.appId).toBe('com.worldlinebox.app');expect(path.isAbsolute(iconPath)).toBe(true);expect(actual.displayName).toBe('WorldlineBox');
      // Production ships resources/app.ico; development uses assets/icons/app.ico.
      // Verify the actual shell icon's bytes against the project logo in both.
      expect(hash(await readFile(iconPath))).toBe(hash(await readFile(path.resolve('assets/icons/app.ico'))));evidence.push(actual);
    }
    await testInfo.attach('windows-shell-properties',{body:JSON.stringify(evidence,null,2),contentType:'application/json'});
    await mkdir(path.resolve('artifacts/companion-topic-real'),{recursive:true});await writeFile(path.resolve('artifacts/companion-topic-real/windows-taskbar.json'),JSON.stringify(evidence,null,2));
  }finally{await app.close();await rm(profile,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
});
