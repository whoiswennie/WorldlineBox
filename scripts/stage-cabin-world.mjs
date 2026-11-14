import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';

const root = path.resolve(import.meta.dirname, '..');
const lock = JSON.parse(await readFile(path.join(root, 'resources/cabin-world-release.json'), 'utf8'));
const cache = path.join(root, '.tools', 'cabin-world', lock.sha256);
const archive = path.join(cache, 'CabinWorld-win64.zip');
const target = path.join(root, 'resources', 'cabin-world');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const override = process.argv[2];
const packaged = process.argv[3];

async function verify(directory) {
  const receipt = JSON.parse(await readFile(path.join(directory, 'release.json'), 'utf8'));
  if (receipt.sha256 !== lock.sha256 || receipt.version !== lock.version) throw Error('Cabin World release does not match the lock.');
  for (const file of ['CabinWorld.exe', 'bridge/bridge.mjs', 'bridge/openai-tools.json', 'LICENSE']) {
    if (!receipt.files[file]) throw Error(`Missing Cabin World release receipt for ${file}.`);
  }
  for (const [file, expected] of Object.entries(receipt.files)) {
    if (hash(await readFile(path.join(directory, file))) !== expected) throw Error(`Cabin World packaged file differs: ${file}`);
  }
}

if (override === '--verify' && !packaged) throw Error('Pass the packaged Cabin World resource directory.');
if (override === '--verify') await verify(packaged);
else if (override || !await verify(target).then(() => true, () => false)) {
  await mkdir(cache, { recursive: true });
  let bytes = await readFile(override ?? archive).catch(error => { if (override || error.code !== 'ENOENT') throw error; });
  if (!bytes) {
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw Error(`Cabin World download failed (${response.status}). Pass the official ZIP as the script argument to stage it locally.`);
    bytes = Buffer.from(await response.arrayBuffer());
  }
  if (hash(bytes) !== lock.sha256) throw Error('Cabin World archive SHA-256 differs from the release lock.');
  await writeFile(archive, bytes);
  await mkdir(target, { recursive: true });
  const stage = await mkdtemp(path.join(cache, 'stage-'));
  const files = {};
  try {
    for (const entry of new AdmZip(bytes).getEntries()) {
      if (entry.isDirectory) continue;
      const match = /^CabinWorld\/((?:bridge\/[^:]+)|CabinWorld\.exe|cabinworld\.ini|LICENSE(?:-NOTES\.md)?|README\.md|third-party\/[^:]+)$/.exec(entry.entryName);
      if (!match) continue;
      const file = match[1];
      if (file.includes('\\') || file.split('/').includes('..')) throw Error('Unsafe path in Cabin World archive.');
      const data = entry.getData();
      const output = path.join(stage, file);
      await mkdir(path.dirname(output), { recursive: true });
      await writeFile(output, data);
      files[file] = hash(data);
    }
    if (!files['CabinWorld.exe'] || !files['bridge/bridge.mjs'] || !files.LICENSE) throw Error('Incomplete Cabin World release.');
    for (const file of Object.keys(files)) {
      const destination = path.join(target, file);
      await mkdir(path.dirname(destination), { recursive: true });
      await rename(path.join(stage, file), destination);
    }
    await writeFile(path.join(target, 'release.json'), JSON.stringify({ ...lock, files }, null, 2) + '\n');
  } finally { await rm(stage, { recursive: true, force: true }); }
}
console.log(`Cabin World ${lock.version} ${override === '--verify' ? 'verified' : 'staged'}.`);
