import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    notes: { type: 'string', default: '24' },
    history: { type: 'string', default: '64' },
    cold: { type: 'string', default: '5' },
    hot: { type: 'string', default: '25' },
    program: { type: 'string' },
    'await-sampling': { type: 'boolean', default: false },
    conditions: { type: 'string', default: 'Manual benchmark run' },
  },
});
for (const [name, minimum, maximum] of [
  ['notes', 12, 10000],
  ['history', Number(values.notes), 100000],
  ['cold', 1, 40],
  ['hot', 1, 500],
]) {
  const count = Number(values[name]);
  if (!Number.isSafeInteger(count) || count < minimum || count > maximum)
    throw Error(`--${name} requires an integer in ${minimum}..${maximum}`);
}
let program = values.program || process.env.WORLDLINEBOX_BOT_DSH_PROGRAM;
if (!program) {
  const base = path.join(process.env.APPDATA, 'WorldlineBox', 'dsh');
  const catalog = JSON.parse(await readFile(path.join(base, 'runtimes.json'), 'utf8'));
  const runtime = catalog
    .filter((row) => row.adapter === 'node-cli-web-v1')
    .sort((a, b) => b.version.localeCompare(a.version, undefined, { numeric: true }))[0];
  if (!runtime) throw Error('Pass --program=<installed DSH program directory>.');
  program = path.join(base, 'runtimes', runtime.id, 'program');
}
const stamp = new Date().toISOString();
const output = path.resolve('artifacts/superagent-bot-development', 'chat-recall-' + stamp.replace(/[:.]/g, '-'));
console.log(JSON.stringify({ output, ...(values['await-sampling'] && { startSamplingFile: path.join(output, 'sample.ready') }) }));
const child = spawn(
  process.execPath,
  ['scripts/run-vitest-with-electron.mjs', 'run', 'tests/unit/bot-live-chat-recall-benchmark.test.ts', '--maxWorkers=1'],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      WORLDLINEBOX_VCP_CHAT_BENCH: '1',
      WORLDLINEBOX_BOT_DSH_PROGRAM: program,
      WORLDLINEBOX_BENCH_OUTPUT: output,
      WORLDLINEBOX_BENCH_AWAIT_SAMPLING: values['await-sampling'] ? '1' : '0',
      WORLDLINEBOX_BENCH_NOTES: values.notes,
      WORLDLINEBOX_BENCH_HISTORY: values.history,
      WORLDLINEBOX_BENCH_COLD: values.cold,
      WORLDLINEBOX_BENCH_HOT: values.hot,
      WORLDLINEBOX_BENCH_CONDITIONS: values.conditions,
    },
  },
);
const code = await new Promise((resolve, reject) => {
  child.once('error', reject);
  child.once('exit', (value) => resolve(value ?? 1));
});
if (!code) {
  const file = path.join(output, 'result.json'),
    result = JSON.parse(await readFile(file, 'utf8'));
  console.log(JSON.stringify({ file, summary: result.summary }, null, 2));
}
process.exitCode = code;
