import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { restoreMissingVcpFiles, VCP_LICENSE } from './vcp-memory-vendor-restore.mjs';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(path.join(projectRoot, 'docs/developer/research-vcp-memory-replacement-manifest.json'), 'utf8'));
const destination = path.join(projectRoot, 'vendor/vcp-memory');
const sourceArgument = process.argv.find(argument => argument.startsWith('--source='));
const sourceRoot = sourceArgument && path.resolve(sourceArgument.slice('--source='.length));
const verifyOnly = process.argv.includes('--verify');
const restoreMissing = process.argv.includes('--restore-missing');
if (!verifyOnly && !restoreMissing && !sourceRoot) throw new Error('Pass --source=<VCPToolBox checkout>, --restore-missing, or --verify.');
const entries = [...manifest.hotCore.files, ...manifest.hotCore.resources,
  ...manifest.native.sourceFiles, manifest.native.testedBinary, VCP_LICENSE];
const peripheralManifestPath = path.join(destination, 'peripheral-manifest.json');
let peripheralManifest;
if (verifyOnly || restoreMissing) peripheralManifest = JSON.parse(await readFile(peripheralManifestPath, 'utf8'));
else {
  const graph = JSON.parse(await readFile(path.join(projectRoot, 'docs/developer/research-vcp-memory-peripheral-dependencies.json'), 'utf8'));
  const selected = ['DailyNote', 'DailyNoteManager', 'RAGDiaryPlugin', 'LightMemo', 'VCPTimeLine'];
  const graphFiles = new Map(selected.flatMap(name => graph.entries[name].files)
    .filter(file => file.kind === 'js').map(file => [file.path, file]));
  const assets = selected.map(name => `Plugin/${name}/plugin-manifest.json`).concat([
    'Plugin/DailyNote/TagMaster.txt', 'Plugin/DailyNoteManager/Readme.md', 'Plugin/LightMemo/config.env.example',
    'Plugin/RAGDiaryPlugin/README.md', 'Plugin/RAGDiaryPlugin/META_THINKING_GUIDE.md',
    'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt', 'Plugin/RAGDiaryPlugin/MoreAIMemoPresets/AIMemoPromptX.txt',
    'Plugin/RAGDiaryPlugin/config.env.example', 'Plugin/RAGDiaryPlugin/rag_tags.json.example',
    'Plugin/RAGDiaryPlugin/semantic_groups.json.example', 'Plugin/RAGDiaryPlugin/semantic_groups.edit.json.example',
  ]);
  const extraFiles = [...graphFiles.values()].filter(file => !entries.some(entry => entry.path === file.path))
    .map(({ path: filePath, bytes, sha256 }) => ({ path: filePath, bytes, sha256 }));
  for (const asset of assets) {
    const bytes = await readFile(path.join(sourceRoot, asset));
    extraFiles.push({ path: asset, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  peripheralManifest = { repository: manifest.upstream.repository, commit: manifest.upstream.commit,
    plugins: selected, files: extraFiles, runtimePackages: [...new Set(selected.flatMap(name => graph.entries[name].npmPackages))]
      .filter(name => !name.startsWith('vexus-lite-')).sort() };
}
entries.push(...peripheralManifest.files);
const restored = restoreMissing ? await restoreMissingVcpFiles({ destination, entries,
  repository: manifest.upstream.repository, commit: manifest.upstream.commit }) : 0;
for (const entry of entries) {
  const relative = entry.path;
  if (path.isAbsolute(relative) || relative.split(/[\\/]/u).includes('..')) throw new Error(`Unsafe manifest path: ${relative}`);
  const source = path.join(verifyOnly || restoreMissing ? destination : sourceRoot, relative);
  let bytes;
  try { bytes = await readFile(source); }
  catch (error) { if (error.code !== 'ENOENT') throw error; throw new Error(`Missing VCP file ${relative}; run node scripts/vendor-vcp-memory.mjs --restore-missing.`, { cause: error }); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (digest !== entry.sha256 || bytes.length !== entry.bytes) throw new Error(`Upstream checksum mismatch: ${relative}`);
  if (!verifyOnly && !restoreMissing) {
    const output = path.join(destination, relative);
    await mkdir(path.dirname(output), { recursive: true });
    await copyFile(source, output);
  }
}
if (!verifyOnly && !restoreMissing) {
  await writeFile(path.join(destination, 'package.json'), JSON.stringify({
    name: '@worldlinebox/vcp-memory-vendor', private: true, type: 'commonjs',
    description: `Unmodified VCP memory core from ${manifest.upstream.commit}`,
  }, null, 2) + '\n');
  await writeFile(path.join(destination, 'upstream-manifest.json'), JSON.stringify({
    repository: manifest.upstream.repository, commit: manifest.upstream.commit,
    files: entries,
  }, null, 2) + '\n');
  await writeFile(peripheralManifestPath, JSON.stringify(peripheralManifest, null, 2) + '\n');
}
console.log(`${restoreMissing ? `Restored ${restored} missing files; verified` : verifyOnly ? 'Verified' : 'Vendored'} ${entries.length} unchanged VCP files (${manifest.upstream.commit}).`);
