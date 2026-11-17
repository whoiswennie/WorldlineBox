import { readFile, writeFile, mkdir, cp, readdir, lstat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

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
const bundledModel = option('--bundled-model');
const assetRoot = path.resolve(project, 'public', 'companion-call');
const noticeName = 'DeepSeek免费 Live2D 模型使用须知.txt';
if (args.includes('--model')) throw Error('Use --bundled-model with the approved model directory.');
if (bundledModel) {
  const modelRoot = path.join(assetRoot, 'dafeiyu');
  const modelDirectory = path.resolve(bundledModel);
  const manifestSource = path.join(modelDirectory, '大肥鱼.model3.json');
  const model = JSON.parse(await readFile(manifestSource, 'utf8'));
  const notice = await readFile(path.join(path.dirname(modelDirectory), noticeName));
  await cp(modelDirectory, modelRoot, { recursive: true, filter: async filename => {
    const info = await lstat(filename);
    return info.isDirectory() || (info.isFile() && filename !== manifestSource && /\.(?:json|moc3|png)$/iu.test(filename));
  } });
  await writeFile(path.join(modelRoot, 'MODEL-LICENSE.txt'), notice);
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
    license: 'MODEL-LICENSE.txt' }, null, 2));
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
