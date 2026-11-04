#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');
const root = path.resolve(__dirname,'..');
const provenancePath = path.join(root,'upstream','manifest-worldline.json');
const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--verify')) {
  const manifest = JSON.parse(fs.readFileSync(provenancePath,'utf8'));
  const failures = [];
  for (const file of manifest.files) {
    const filename = path.resolve(root,file.path);
    if (!filename.startsWith(root+path.sep)) throw new Error('Manifest path outside package');
    try { const bytes = fs.readFileSync(filename); if(bytes.length !== file.bytes || sha256(bytes) !== file.sha256) failures.push(file.path); }
    catch(error) { failures.push(file.path+': '+error.message); }
  }
  console.log(JSON.stringify({ok:!failures.length,files:manifest.files.length,failures},null,2));
  process.exitCode = failures.length ? 1 : 0;
  return;
}
const ts = require('typescript');
const sourceIndex = process.argv.indexOf('--source');
const source = path.resolve(sourceIndex >= 0 ? process.argv[sourceIndex+1] : path.join(root,'..','WorldlineBox'));
const upstream = path.join(root,'upstream','worldline');
const bundle = path.join(root,'vendor','local-embedding');
const files = [];
function write(destination,bytes,extra={}) {
  fs.mkdirSync(path.dirname(destination),{recursive:true}); fs.writeFileSync(destination,bytes);
  files.push({path:path.relative(root,destination).split(path.sep).join('/'),bytes:bytes.length,sha256:sha256(bytes),...extra});
}
for (const name of ['embedding-llama-session','embedding-process-owner']) {
  const relative = `src/main/${name}.ts`;
  const bytes = fs.readFileSync(path.join(source,relative));
  write(path.join(upstream,relative),bytes,{source:relative,kind:'unmodified-source'});
  const compiled = ts.transpileModule(bytes.toString('utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  write(path.join(upstream,'compiled',`${name}.js`),Buffer.from(compiled),{source:relative,kind:'typescript-transpile'});
}
for (const relative of ['src/shared/embedding/profile.ts','src/shared/embedding/global-profile.ts']) {
  write(path.join(upstream,relative),fs.readFileSync(path.join(source,relative)),{source:relative,kind:'unmodified-reference'});
}
write(path.join(upstream,'LICENSE'),fs.readFileSync(path.join(source,'LICENSE')),{kind:'license'});
const modelSource = path.join(source,'resources','embedding-models');
const modelManifest = JSON.parse(fs.readFileSync(path.join(modelSource,'manifest.json'),'utf8'));
const artifacts = new Map();
function visit(value) {
  if (!value || typeof value !== 'object') return;
  if (typeof value.path === 'string' && /^[a-f0-9]{64}$/i.test(value.sha256 || '')) artifacts.set(value.path,value);
  for (const child of Object.values(value)) visit(child);
}
visit(modelManifest);
for (const [relative,expected] of artifacts) {
  const from = path.resolve(modelSource,relative);
  if (!from.startsWith(modelSource+path.sep)) throw new Error('Model manifest escapes bundle');
  const bytes = fs.readFileSync(from);
  if (bytes.length !== expected.bytes || sha256(bytes) !== expected.sha256) throw new Error('Model/runtime hash mismatch: '+relative);
  write(path.join(bundle,relative),bytes,{kind:'pinned-model-or-runtime'});
}
write(path.join(bundle,'manifest.json'),fs.readFileSync(path.join(modelSource,'manifest.json')),{kind:'original-model-manifest'});
for (const name of ['ffmpeg.exe','ffprobe.exe']) {
  const from = path.join(source,'resources','ffmpeg','win32-x64',name);
  if (fs.existsSync(from)) write(path.join(bundle,'media',name),fs.readFileSync(from),{kind:'original-media-runtime'});
}
for (const name of ['bundle-lock.json','source-lock.json','README.md']) {
  write(path.join(bundle,'media',name),fs.readFileSync(path.join(source,'resources','media-binaries',name)),{kind:'media-provenance'});
}
write(path.join(bundle,'THIRD_PARTY_NOTICES.WorldlineBox.md'),fs.readFileSync(path.join(source,'THIRD_PARTY_NOTICES.md')),{kind:'upstream-notices'});
const manifest = {version:1,createdAt:new Date().toISOString(),source:{path:source,commit:cp.execFileSync('git',['-C',source,'rev-parse','HEAD'],{encoding:'utf8'}).trim()},typescript:ts.version,model:{id:modelManifest.modelId,dimension:modelManifest.dimension,revision:modelManifest.revision},files};
fs.writeFileSync(provenancePath,JSON.stringify(manifest,null,2)+'\n');
console.log(JSON.stringify({ok:true,files:files.length,bytes:files.reduce((n,f)=>n+f.bytes,0),bundle},null,2));
