import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { build } from 'vite';
import { test, expect } from '@playwright/test';
import { electronLaunchEnv, resolveElectronExecutablePath } from './electron-test-helpers';

test('installs the official DSH release through system proxy and reuses its verified dependency cache', async () => {
  test.skip(process.env.WORLDLINEBOX_DSH_REAL_INSTALL !== '1', 'Opt-in real public package download.');
  test.setTimeout(1_800_000);
  const reuse = process.env.WORLDLINEBOX_DSH_INSTALL_REUSE_ROOT;
  const root = reuse ? await realpath(reuse) : await mkdtemp(path.join(tmpdir(),'worldlinebox-dsh-install-network-'));
  if (path.dirname(root) !== await realpath(tmpdir()) || !path.basename(root).startsWith('worldlinebox-dsh-install-network-')) throw Error('Unexpected isolated install fixture');
  await mkdir(path.join(root,'electron-data'),{recursive:true});
  await build({ configFile:false,logLevel:'error',ssr:{noExternal:true,external:['electron','koffi']},build:{ssr:path.resolve('tests/fixtures/dsh-network/install.ts'),outDir:path.join(root,'fixture'),target:'node24',
    rollupOptions:{external:['electron','koffi'],output:{format:'cjs',entryFileNames:'main.cjs',paths:{koffi:path.resolve('node_modules/koffi')}}}} });
  const child=spawn(resolveElectronExecutablePath(),[path.join(root,'fixture','main.cjs')],{cwd:process.cwd(),windowsHide:true,stdio:['ignore','pipe','pipe'],env:electronLaunchEnv({WORLDLINEBOX_DSH_INSTALL_FIXTURE_ROOT:root,...(reuse?{WORLDLINEBOX_DSH_INSTALL_REUSE_ROOT:root}:{})})});
  let output='';
  child.stdout.on('data',chunk=>{output+=String(chunk);console.log(String(chunk).trim());});
  child.stderr.on('data',chunk=>{output+=String(chunk);console.log(String(chunk).trim());});
  const deadline=setTimeout(()=>child.kill(),1_790_000);
  const code=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);}).finally(()=>clearTimeout(deadline));
  expect(code,`${output}\nFixture: ${root}`).toBe(0);
  const results=JSON.parse(/^INSTALL_RESULT (.+)$/m.exec(output)?.[1]??'[]') as Array<{bytes:number;version:string;cli:string}>;
  expect(results).toHaveLength(reuse ? 1 : 2);
  expect(results[0]?.version).toBe('0.2.1-rc.2');expect(results[0]?.cli).toContain('0.2.1-rc.2');
  if (reuse) expect(results[0]!.bytes).toBeLessThan(100_000);
  else expect(results[1]!.bytes).toBeLessThan(results[0]!.bytes/5);
  await test.info().attach('real-install-results',{body:output,contentType:'text/plain'});
});
