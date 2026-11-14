import { readFile, writeFile, mkdir, cp, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import AdmZip from 'adm-zip';

const args = process.argv.slice(2), option = name => { const index = args.indexOf(name); return index >= 0 ? args[index + 1] : undefined; };
const project = process.cwd();
const reference = option('--sdk');
if (reference) {
  for (const name of ['engine', 'live2d-pixi']) {
    const source = path.resolve(reference, 'packages', name), destination = path.resolve(project, 'vendor', 'soullink-emotion', name);
    const original = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8'));
    await mkdir(destination, { recursive: true });
    await cp(path.join(source, 'src'), path.join(destination, 'src'), { recursive: true, filter: async filename => {
      if ((await lstat(filename)).isSymbolicLink()) throw Error('SDK snapshot must not contain symbolic links');
      return !filename.includes('__tests__') && !filename.endsWith('.test.ts');
    } });
    await cp(path.join(source, 'LICENSE'), path.join(destination, 'LICENSE'));
    await cp(path.join(source, 'README.md'), path.join(destination, 'README.md'));
    await writeFile(path.join(destination, 'package.json'), JSON.stringify({ name: original.name, version: original.version, license: original.license,
      type: 'module', main: './dist/index.js', types: './dist/index.d.ts', exports: original.exports, peerDependencies: original.peerDependencies, files: ['dist', 'LICENSE', 'README.md'] }, null, 2));
    await writeFile(path.join(destination, 'tsconfig.build.json'), JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'ESNext', moduleResolution: 'Bundler',
      lib: ['ES2022', 'DOM'], strict: true, skipLibCheck: true, declaration: true, outDir: 'dist', rootDir: 'src' }, include: ['src/**/*.ts'] }, null, 2));
  }
}
const archive = option('--model');
const assetRoot = path.resolve(project, 'public', 'companion-call');
if (archive) {
  const modelRoot = path.join(assetRoot, 'deepseek'); await mkdir(modelRoot, { recursive: true });
  const bytes = await readFile(archive), zip = new AdmZip(bytes), prefix = 'DeepSeek免费公皮/DeepSeek/';
  for (const entry of zip.getEntries()) {
    const name = entry.entryName.replaceAll('\\', '/');
    if (entry.isDirectory || !name.startsWith(prefix) || !/\.(?:json|moc3|png|txt)$/iu.test(name)) continue;
    const relative = name.slice(prefix.length), target = path.resolve(modelRoot, relative);
    if (!relative || !target.startsWith(modelRoot + path.sep) || entry.header.size > 80 * 1024 * 1024) throw Error('Invalid model archive entry');
    await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, entry.getData());
  }
  const creditsEntry = zip.getEntries().find(entry => entry.entryName.endsWith('DeepSeek免费 Live2D 模型使用须知.txt'));
  if (creditsEntry) await writeFile(path.join(modelRoot, 'MODEL-LICENSE.txt'), creditsEntry.getData());
  const model = JSON.parse(await readFile(path.join(modelRoot, '大肥鱼.model3.json'), 'utf8'));
  const expressions = await Promise.all((await readdir(path.join(modelRoot, 'Exp3'))).filter(name => name.endsWith('.exp3.json')).map(async name => {
    const data = JSON.parse(await readFile(path.join(modelRoot, 'Exp3', name), 'utf8'));
    return { name: name.replace('.exp3.json', ''), file: 'Exp3/' + name, params: data.Parameters.map(parameter => parameter.Id) };
  }));
  const motions = await Promise.all((await readdir(path.join(modelRoot, 'Animation'))).filter(name => name.endsWith('.motion3.json')).map(async (name, index) => {
    const data = JSON.parse(await readFile(path.join(modelRoot, 'Animation', name), 'utf8'));
    return { name: name.replace('.motion3.json', ''), file: 'Animation/' + name, group: name.startsWith('IDLE.') ? 'Idle' : 'Interaction', index,
      duration: data.Meta.Duration, params: data.Curves.filter(curve => curve.Target === 'Parameter').map(curve => curve.Id) };
  }));
  for (const group of ['Idle', 'Interaction']) motions.filter(motion => motion.group === group).forEach((motion, index) => { motion.index = index; });
  model.FileReferences.Expressions = expressions.map(item => ({ Name: item.name, File: item.file }));
  model.FileReferences.Motions = Object.fromEntries(['Idle', 'Interaction'].map(group => [group, motions.filter(item => item.group === group).map(item => ({ File: item.file, FadeInTime: .3, FadeOutTime: .3 }))]));
  await writeFile(path.join(modelRoot, 'call.model3.json'), JSON.stringify(model, null, 2));
  await writeFile(path.join(modelRoot, 'catalog.json'), JSON.stringify({ expressions, motions, credits: 'DeepSeek-chan（大肥鱼）｜原画及拆分：神宫凉子｜Live2D 建模：霓虹猫_NeonNeko',
    license: 'MODEL-LICENSE.txt', sourceSha256: createHash('sha256').update(bytes).digest('hex'), redistribution: 'Original model license applies; local user-provided installation.' }, null, 2));
  process.stdout.write(`Model: ${expressions.length} expressions, ${motions.length} motions. PSD is excluded.\n`);
}
const privateRingtones = path.join(project, '.tools', 'original-call-ringtones');
for (const [argument, file] of [['--ringtone', 'ringtone.wav'], ['--dafeiyu-ringtone', 'dafeiyu.wav']]) {
  const input = option(argument);
  if (!input) continue;
  await mkdir(privateRingtones, { recursive: true });
  execFileSync(path.join(project, 'resources', 'ffmpeg', 'win32-x64', 'ffmpeg.exe'), [
    '-hide_banner', '-loglevel', 'error', '-i', path.resolve(input),
    '-map', '0:a:0', '-vn', '-c:a', 'pcm_s16le', '-y', path.join(privateRingtones, file),
  ], { windowsHide: true });
  process.stdout.write(`Staged private call audio: ${file}\n`);
}
