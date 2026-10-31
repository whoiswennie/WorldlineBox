import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { builtinModules, createRequire } from 'node:module';
import path from 'node:path';
import { build } from 'vite';

const require = createRequire(import.meta.url);
const project = process.cwd();
const pointer = JSON.parse(await readFile('artifacts/memory-latency-20261030/source-queue-profile-pointer.json', 'utf8'));
const root = pointer.privateRoot;
if (!path.isAbsolute(root) || !path.basename(root).startsWith('wlb-source-queue-')) throw new Error('The frozen baseline root is missing.');
const originalReport = JSON.parse(await readFile('artifacts/memory-latency-20261030/full-respond-benchmark/final-fenced-concurrent-result.json', 'utf8'));
const input = originalReport.privateClone.path;
if (!path.basename(input).startsWith('wlb-full-respond-')) throw new Error('Only a retained real benchmark clone is allowed.');
const accessCompare = process.env.WORLDLINEBOX_SOURCE_ACCESS_COMPARE === '1';
const source = path.resolve(accessCompare ? 'src/companions/source-access.ts' : 'src/companions/execution-source-store.ts');
const sourceDb = path.join(input, 'messages.sqlite');
const fileHash = async filename => createHash('sha256').update(await readFile(filename)).digest('hex');
const beforeHash = await fileHash(sourceDb);
const variants = process.env.WORLDLINEBOX_SOURCE_QUEUE_CPU_ONLY === '1' ? ['cpu'] : ['baseline', 'indexed'];
if (accessCompare && variants[0] === 'cpu') throw new Error('CPU-only and source-access comparison are separate diagnostics.');
const prefix = accessCompare ? 'access-' : '';
function child(command, args, extra = {}) {
  return new Promise((resolve, reject) => {
    const process = spawn(command, args, { cwd: project, env: { ...globalThis.process.env, ...extra }, stdio: 'inherit' });
    process.on('error', reject); process.on('exit', code => code === 0 ? resolve() : reject(new Error('Source queue child failed: ' + code)));
  });
}
await child('python', ['-c', 'import sqlite3,sys,pathlib;from contextlib import closing\nwith closing(sqlite3.connect(pathlib.Path(sys.argv[1]).as_uri()+"?mode=ro",uri=True)) as src:\n for target in sys.argv[2:]:\n  with closing(sqlite3.connect(target)) as dst:src.backup(dst)', sourceDb, ...variants.map(variant => path.join(root, prefix + variant + '.sqlite'))]);
function instrument(text) {
  text = text.replace('const proofs = new Map<string, Proof>();', `const proofs = new Map<string, Proof>();\nconst __stats = Reflect.get(globalThis, '__sourceQueueStats');`);
  const line = 'const messages = [root], notes: string[] = [], events: string[] = [], seenMessages = new Set<string>(), seenNotes = new Set<string>(), seenEvents = new Set<string>();';
  text = text.replace(line, line + `\nif (__stats) { __stats.roots++; __stats.pushes++;
    for (const queue of [messages,notes,events]) { const push = queue.push; queue.push = (...items: string[]) => { __stats.pushes += items.length; const result=push.apply(queue,items);__stats.maximumQueueLength=Math.max(__stats.maximumQueueLength,queue.length);return result; }; } }`);
  for (const [id, seen] of [['id','seenMessages'],['noteId','seenNotes'],['eventId','seenEvents']]) {
    const anchor = `if (${id} && !${seen}.has(${id}))`;
    text = text.replace(anchor, `if (__stats && ${id}) { __stats.pops++; if (${seen}.has(${id})) __stats.duplicatePops++; }\n` + anchor);
  }
  return text;
}
for (const variant of variants) {
  const text = await readFile(variant === 'baseline' ? path.join(root, accessCompare ? 'baseline-source-access.ts' : 'baseline-execution-source-store.ts') : source, 'utf8');
  await build({ configFile: false, logLevel: 'error', resolve: { conditions: ['node'], mainFields: ['module', 'jsnext:main', 'jsnext'] },
    plugins: [{ name: 'profile-actual-execution-source-queue', enforce: 'pre', transform(_code, id) { if (path.resolve(id) === source) return variant === 'cpu' || accessCompare ? text : instrument(text); } }],
    build: { ssr: path.resolve('tests/fixtures/companion-source-queue-profile.ts'), outDir: path.join(root, prefix + variant + '-build'), emptyOutDir: true,
      rollupOptions: { external: ['better-sqlite3', 'electron', ...builtinModules, ...builtinModules.map(name => 'node:' + name)], output: { format: 'cjs', entryFileNames: 'profile.cjs' } } } });
  if (!accessCompare) await child(require('electron'), [path.join(root, variant + '-build', 'profile.cjs')],
    { ELECTRON_RUN_AS_NODE: '1', WORLDLINEBOX_SOURCE_QUEUE_ROOT: root, WORLDLINEBOX_SOURCE_QUEUE_VARIANT: variant, NODE_PATH: path.join(project, 'node_modules') });
}
if (accessCompare) {
  await child(require('electron'), [path.resolve('tests/fixtures/companion-source-access-compare.cjs')],
    { ELECTRON_RUN_AS_NODE: '1', WORLDLINEBOX_SOURCE_QUEUE_ROOT: root, WORLDLINEBOX_SOURCE_ACCESS_CONTROLLED: '1', NODE_PATH: path.join(project, 'node_modules') });
  const result = JSON.parse(await readFile(path.join(root, 'source-access-result.json'), 'utf8'));
  result.originalPrivateCloneUnchanged = await fileHash(sourceDb) === beforeHash;
  result.baselineSourceSha256 = pointer.sourceAccessBaselineSha256; result.indexedSourceSha256 = await fileHash(source);
  await writeFile(path.join(root, 'source-access-result.json'), JSON.stringify(result));
  if (!result.originalPrivateCloneUnchanged) process.exitCode = 1;
} else if (variants[0] === 'cpu') {
  const result = JSON.parse(await readFile(path.join(root, 'cpu-profile-result.json'), 'utf8'));
  result.originalPrivateCloneUnchanged = await fileHash(sourceDb) === beforeHash;
  await writeFile(path.join(root, 'cpu-profile-result.json'), JSON.stringify(result));
  console.log(JSON.stringify(result));
  if (!result.originalPrivateCloneUnchanged) process.exitCode = 1;
} else {
const baseline = JSON.parse(await readFile(path.join(root, 'baseline-result.json'), 'utf8'));
const indexed = JSON.parse(await readFile(path.join(root, 'indexed-result.json'), 'utf8'));
const equivalent = baseline.results.every((result, index) => result.case === indexed.results[index].case && result.normalizedProofHash === indexed.results[index].normalizedProofHash);
const report = { equivalent, actualStore: true, isMainOrProviderLatency: false, originalPrivateCloneUnchanged: await fileHash(sourceDb) === beforeHash,
  baselineSourceSha256: pointer.baselineSha256, indexedSourceSha256: await fileHash(source), baseline: baseline.results, indexed: indexed.results };
await writeFile(path.join(root, 'result.json'), JSON.stringify(report));
console.log(JSON.stringify(report));
if (!report.equivalent || !report.originalPrivateCloneUnchanged) process.exitCode = 1;
}
