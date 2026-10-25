import { app } from 'electron';
import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { LauncherNetwork } from '../../../src/main/dsh/launcher-network';
import { RuntimeService } from '../../../src/main/dsh/runtime-service';
import { resolvePortableTools } from '../../../src/main/portable-tools';
import { OperationStore } from '../../../src/main/dsh/operations';
import { validateOfficialNodeRelease } from '../../../src/main/dsh/node-runtime-service';

const root = process.env.WORLDLINEBOX_DSH_INSTALL_FIXTURE_ROOT!;
app.setPath('userData', path.join(root, 'electron-data'));
app.whenReady().then(async () => {
  const network = new LauncherNetwork(root, () => undefined); await network.init();
  const tools = await resolvePortableTools({ appPath:process.cwd() });
  const metadata = await network.json('https://registry.npmjs.org/@deepseek-ai%2fdsh/0.2.1-rc.2') as {version:string;dist:{tarball:string;integrity:string}};
  const release = validateOfficialNodeRelease({ version:metadata.version,...metadata.dist });
  console.log('INSTALL_ROUTE', await network.test());
  let current = '';
  const ops = new OperationStore(path.join(root,'operations'), () => {
    const op = ops.list()[0]!;
    if (op && current !== op.phase) { current=op.phase; if(!op.phase.includes(':') || /(?:0\/|[05]0\/)/.test(op.phase)) console.log('INSTALL_PHASE', op.phase, op.download?.transferredBytes ?? 0); }
  });
  await ops.init();
  const manager = new RuntimeService({ rootPath:root,onChanged:()=>undefined,
    fetch:network.fetch,nodeTools:async()=>tools,nodeInstallNetwork:signal=>network.nodeInstallNetwork(signal) });
  await manager.init();
  const results = [];
  for (const label of process.env.WORLDLINEBOX_DSH_INSTALL_REUSE_ROOT ? ['cached-parallel-copy'] : ['cold','warm']) {
    const started = Date.now();
    await ops.run('runtime.install', label, undefined, async op => { await manager.installNode(release,op); });
    await ops.settle();
    const op = ops.list()[0]!;
    console.log('INSTALL_COMPLETE', label, JSON.stringify(op));
    if (op.status !== 'succeeded') {
      console.error(await readFile(path.join(root,'operations',`${op.id}.log`),'utf8'));
      throw Error(op.error);
    }
    const runtime = manager.list()[0]!; const plan = manager.plan(runtime.id);
    const cli = await promisify(execFile)(plan.executable,[plan.cli,'--version'], { windowsHide:true,timeout:60_000, env:{...process.env,...plan.env,DSH_HOME:path.join(root,'cli-home')} });
    results.push({ label,elapsedMs:Date.now()-started,bytes:op.download?.transferredBytes,version:runtime.version,cli:cli.stdout.trim() });
  }
  await mkdir(path.join(root,'results'),{recursive:true});
  await writeFile(path.join(root,'results','install.json'),JSON.stringify(results,null,2));
  console.log('INSTALL_RESULT', JSON.stringify(results));
  app.exit(0);
}).catch(error=>{ console.error(error);app.exit(1); });
