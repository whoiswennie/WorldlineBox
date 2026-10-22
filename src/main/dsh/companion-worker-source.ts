import { pathToFileURL } from 'node:url';

/** One official CLI host, exclusive requests, and a fresh owned native Agent per request. */
export function companionWorkerSource(adapterPath: string): string {
  return `import { apply as runTask } from ${JSON.stringify(pathToFileURL(adapterPath).href)};\n` + String.raw`
import { PassThrough } from 'node:stream';
import { createInterface } from 'node:readline';
export const name = 'worldlinebox-companion-worker';
export const inject = ['agents', 'agentDefaultModel', 'sessions', 'agentPresets'];
export function apply(ctx) {
  const emit = value => process.stdout.write(JSON.stringify(value)+'\n');
  let current, commands = Promise.resolve(), stopped = false;
  const ready = Promise.resolve().then(() => ctx.get('loader')?.await()).then(() => emit({type:'runtime_ready'}));
  const input = createInterface({input:process.stdin,terminal:false});
  input.on('line', line => {
    commands = commands.then(async () => {
      await ready;
      if (stopped || line.length > 2*1024*1024) throw Error('Invalid worker input');
      const value = JSON.parse(line);
      if (value.type !== 'open') { if (!current) throw Error('No active worker request'); current.input.write(line+'\n'); return; }
      if (current || typeof value.cwd !== 'string') throw Error('Worker request is already active or lacks its workspace');
      const task = {input:new PassThrough(),dispose:undefined,finishing:false}; current = task;
      task.dispose = runTask(ctx, {input:task.input,cwd:value.cwd,policy:value.policy,resumeSessionId:value.resumeSessionId,recovery:value.recovery,
        exit: code => {
          if (task.finishing) return; task.finishing = true;
          void Promise.resolve().then(async () => {
            await task.dispose?.(); task.input.destroy(); current = undefined;
            emit({type:'task_finished',code});
          }).catch(() => { emit({type:'worker_error'}); ctx.get('appExit')(1); });
        }});
    }).catch(() => { emit({type:'worker_error'}); ctx.get('appExit')(1); });
  });
  input.on('close', () => { stopped = true; void current?.dispose?.().finally(() => ctx.get('appExit')(0)); if (!current) ctx.get('appExit')(0); });
  ctx.effect(() => () => { stopped = true; input.close(); return current?.dispose?.(); });
  void ready.catch(() => { emit({type:'worker_error'}); ctx.get('appExit')(1); });
}
`;
}
