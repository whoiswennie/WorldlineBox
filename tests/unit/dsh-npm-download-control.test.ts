import { createServer } from 'node:http';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it, vi } from 'vitest';
import { OperationStore } from '../../src/main/dsh/operations';
import { runNodeInstall } from '../../src/main/dsh/node-runtime-service';
import { removeManaged } from '../../src/main/dsh/files';

it('keeps the npm failure reason ahead of verbose peer warnings in the operation error', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'worldlinebox-npm-error-'));
  const installer = path.join(root, 'installer.cjs');
  await writeFile(installer, "console.error('npm error code ETARGET\\nnpm error notarget No matching version found for @deepseek-ai/cordis@~4.1.0.'); console.error('npm warn peer dependency warning\\n'.repeat(300)); process.exitCode=1;");
  try {
    const { TEST_NODE_EXECUTABLE, TEST_NODE_VERSION } = await import('../helpers/node-executable');
    await expect(runNodeInstall({ nodeExecutable: TEST_NODE_EXECUTABLE, npmCli: installer, nodeVersion: TEST_NODE_VERSION, npmVersion: 'fixture' }, [], root, process.env, {
      id: 'npm-error', signal: AbortSignal.timeout(5000), log: async () => undefined, update: async () => undefined,
    })).rejects.toThrow(/exit 1\)\. npm error code ETARGET\nnpm error notarget No matching version found for @deepseek-ai\/cordis@~4\.1\.0/);
  } finally { await removeManaged(tmpdir(), root); }
});

it.skipIf(process.platform !== 'win32')('observes a cached helper exiting before the asynchronous progress journal finishes', async () => {
  const root=await mkdtemp(path.join(tmpdir(),'worldlinebox-fast-npm-'));
  const installer=path.join(root,'installer.cjs');await writeFile(installer,"console.log('cached helper finished');");
  try{
    await runNodeInstall({nodeExecutable:process.execPath,npmCli:installer,nodeVersion:process.versions.node,npmVersion:'fixture'},[],root,process.env,{
      id:'cached-helper',signal:AbortSignal.timeout(3000),log:async()=>undefined,update:async()=>undefined,
      download:{begin:async()=>{await new Promise(resolve=>setTimeout(resolve,350));},report:()=>undefined,wait:async()=>undefined,end:async()=>undefined},
    });
  }finally{await removeManaged(tmpdir(),root);}
},5000);

it.skipIf(process.platform !== 'win32')('cooperatively pauses real package-manager HTTP streams and cancellation closes the owned child', async () => {
  const root = await mkdtemp(path.join(tmpdir(),'worldlinebox-npm-control-'));
  const timers = new Set<ReturnType<typeof setInterval>>();
  const server = createServer((_req, response) => {
    response.writeHead(200); let chunks=0;
    const timer=setInterval(()=> { response.write(Buffer.alloc(16*1024)); if (++chunks===90) { clearInterval(timer); timers.delete(timer); response.end(); } },20);
    timers.add(timer); response.on('close',()=>{clearInterval(timer);timers.delete(timer);});
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};
  const installer=path.join(root,'installer.cjs');
  await writeFile(installer, `const http=require('node:http');let consumed=0;http.request('http://127.0.0.1:${address.port}',res=>{res.on('data',chunk=>{consumed+=chunk.length;console.log('consumed:'+consumed)});res.on('end',()=>console.log('complete'))}).end();`);
  const tools={nodeExecutable:process.execPath,npmCli:installer,nodeVersion:process.versions.node,npmVersion:'fixture'};
  const operations=new OperationStore(path.join(root,'operations'),()=>undefined);
  const seen=new Map<string,number>();
  try {
    await operations.init();
    const ids=[];
    for (const name of ['a','b']) {
      const cwd=path.join(root,name);await mkdir(cwd);
      ids.push(await operations.run('runtime.install',name,undefined,async op=> {
        await runNodeInstall(tools,[],cwd,process.env,{...op,log:async text=>{
          const values=[...text.matchAll(/consumed:(\d+)/g)]; if(values.length)seen.set(op.id,Number(values.at(-1)![1]));
        }});
      }));
    }
    const [a,b]=ids as [string,string];
    await vi.waitFor(()=>expect(seen.get(a)).toBeGreaterThan(32000));
    await operations.pause(a);
    await new Promise(resolve=>setTimeout(resolve,100));const frozen=seen.get(a)!;
    await new Promise(resolve=>setTimeout(resolve,300));
    expect(seen.get(a)).toBe(frozen);expect(seen.get(b)).toBeGreaterThan(frozen);
    await operations.resume(a);await vi.waitFor(()=>expect(seen.get(a),JSON.stringify(operations.list())).toBeGreaterThan(frozen));
    await operations.pause(a);operations.cancel(a);await operations.settle();
    expect(operations.list().find(value=>value.id===a)?.status).toBe('cancelled');
    expect(operations.list().find(value=>value.id===b)?.status).toBe('succeeded');
    expect((await readdir(path.join(root,'a'))).some(value=>value.startsWith('.worldline-download-'))).toBe(false);
    expect((await readdir(path.join(root,'b'))).some(value=>value.startsWith('.worldline-download-'))).toBe(false);
  } finally { await operations.shutdown(); for(const timer of timers)clearInterval(timer);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await removeManaged(tmpdir(),root); }
});
