import { readdir, readFile, writeFile, lstat, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { acceptanceProcesses, inspectAcceptanceRoot, removeAcceptanceRoot } from './bot-acceptance-cleanup-lib.mjs';

const output = path.resolve(process.argv[3] ?? 'artifacts/superagent-bot-development/temporary-cleanup-plan.json');
const temporary = await realpath(os.tmpdir()), project = path.resolve('artifacts/superagent-bot-development');
const bundles = ['protocol-acceptance/main.cjs', 'real-acceptance/main.cjs'].map(value => path.join(project, value));
if (process.argv[2] === '--plan') {
  const processes = await acceptanceProcesses(), targets = [];
  for (const entry of await readdir(temporary, { withFileTypes: true })) if (/^worldlinebox-bot-(host|real)-/.test(entry.name)) {
    targets.push(await inspectAcceptanceRoot(path.join(temporary, entry.name), processes));
  }
  const generatedFiles = [];
  for (const filename of bundles) try { if ((await lstat(filename)).isSymbolicLink()) throw Error('Bundle is a link'); generatedFiles.push(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const manifest = { format: 'wlb-bot-acceptance-cleanup-v1', createdAt: new Date().toISOString(), temporary, targets, generatedFiles };
  await writeFile(output, JSON.stringify(manifest, null, 2) + '\n');
  process.stdout.write(JSON.stringify({ manifest: output, roots: targets.length, rootReparse: targets.some(value => value.rootReparse), alive: targets.filter(value => value.alivePids.length), generatedFiles }) + '\n');
} else if (process.argv[2] === '--apply') {
  const manifest = JSON.parse(await readFile(output, 'utf8'));
  if (manifest.format !== 'wlb-bot-acceptance-cleanup-v1' || path.resolve(manifest.temporary).toLowerCase() !== temporary.toLowerCase()) throw Error('Cleanup plan temporary root differs.');
  const removed = [];
  for (const target of manifest.targets) {
    await removeAcceptanceRoot(target.path);
    try { await lstat(target.path); throw Error('Target still exists after removal.'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    removed.push(target.path);
  }
  for (const filename of manifest.generatedFiles) {
    if (!bundles.includes(filename) || (await lstat(filename)).isSymbolicLink() || (await realpath(filename)).toLowerCase() !== filename.toLowerCase()) throw Error('Cleanup plan contains an unowned generated file.');
    await unlink(filename);
  }
  await writeFile(path.join(project, 'temporary-cleanup-result.json'), JSON.stringify({ removed, generatedFiles: manifest.generatedFiles, completedAt: new Date().toISOString() }, null, 2));
  process.stdout.write(JSON.stringify({ removedRoots: removed.length, removedBundles: manifest.generatedFiles.length }) + '\n');
} else throw Error('Use --plan or --apply followed by an optional manifest path.');
