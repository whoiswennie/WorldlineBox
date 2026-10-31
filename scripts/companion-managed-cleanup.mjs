import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
// Use the project's native SQLite ABI, without opening a desktop window.
if (!process.versions.electron) {
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit', windowsHide: true,
  });
  child.on('error', error => { process.stderr.write(error.message + '\n'); process.exitCode = 1; });
  child.on('exit', code => { process.exitCode = code ?? 1; });
} else {
  try {
    const args = process.argv.slice(2), mode = args.shift(), values = new Map();
    while (args.length) { const key = args.shift(), value = args.shift(); if (!key?.startsWith('--') || !value || values.has(key)) throw new Error('Invalid cleanup arguments.'); values.set(key, value); }
    const allowed = mode === 'plan' ? ['--library', '--library-id', '--out'] : ['--plan', '--plan-hash'];
    if ([...values.keys()].some(key => !allowed.includes(key))) throw new Error('Unknown cleanup option; no operation was performed.');
    const Database = require('better-sqlite3'), { rolldown } = await import('rolldown');
    // Bundle this fixed local entry and its typed retention dependencies in
    // memory. A single-file transpile leaves unresolved relative imports when
    // the result is loaded from a data URL. Never load code from a plan file.
    const bundle = await rolldown({ input: fileURLToPath(new URL('../src/companions/development-cleanup.ts', import.meta.url)),
      platform: 'node', external: /^node:/u });
    let compiled;
    try {
      const { output } = await bundle.generate({ format: 'esm', codeSplitting: false });
      if (output.length !== 1 || output[0].type !== 'chunk' || !output[0].isEntry || output[0].dynamicImports.length
        || output[0].imports.some(id => !id.startsWith('node:'))) throw new Error('Cleanup code must be one local bundle with only Node built-ins external.');
      compiled = output[0].code;
    } finally { await bundle.close(); }
    const api = await import('data:text/javascript;base64,' + Buffer.from(compiled).toString('base64'));
    const openDatabase = (file, readonly) => new Database(file, { readonly, fileMustExist: true, timeout: 0 });
    if (mode === 'plan') {
      if (!values.get('--library') || !values.get('--library-id') || !values.get('--out')) throw new Error('Usage: plan --library ABSOLUTE_PATH --library-id ID --out PLAN_FILE');
      const plan = await api.planCompanionManagedCleanup({ libraryPath: path.resolve(values.get('--library')), libraryId: values.get('--library-id'), openDatabase });
      await writeFile(path.resolve(values.get('--out')), JSON.stringify(plan, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(JSON.stringify({ planFile: path.resolve(values.get('--out')), planHash: plan.planHash, owners: plan.owners, files: plan.files.length, tables: plan.tables.map(table => ({ name: table.name, rows: table.rows })), preservedPaths: plan.preservedPaths }, null, 2) + '\n');
    } else if (mode === 'execute') {
      if (!values.get('--plan') || !values.get('--plan-hash')) throw new Error('Usage: execute --plan PLAN_FILE --plan-hash REVIEWED_HASH');
      const plan = JSON.parse(await readFile(path.resolve(values.get('--plan')), 'utf8'));
      const result = await api.executeCompanionManagedCleanup(plan, values.get('--plan-hash'), { libraryPath: plan.libraryPath, libraryId: plan.libraryId, openDatabase });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    } else throw new Error('Choose plan or execute. The tool never deletes data in plan mode.');
  } catch (error) { process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; }
}
