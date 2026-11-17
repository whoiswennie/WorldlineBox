import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, open, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { DEFAULT_BOT_COMPANION_ID, YACHIYO_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { CALL_MODEL_HOST, type BotCallModel } from '../../shared/companion-call';
import { atomicJson, contained, safeRelative } from '../dsh/files';
import { readBotCallModel } from './call-models';

const maxAssetSize = 128 * 1024 ** 2;
const maxModelSize = 512 * 1024 ** 2;
const maxFolderEntries = 4096;
const fileTypes = new Map([['.json', 'application/json'], ['.png', 'image/png'], ['.moc3', 'application/octet-stream']]);
const modelFile = /\.model3\.json$/iu;
const animationFile = /\.(?:exp3|motion3)\.json$/iu;
const vtsFile = /\.vtube\.json$/iu;
const modelKey = /^[a-f0-9]{64}$/u;
const generationId = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
const dafeiyuRoot = (profile: string) => path.join(profile, 'companion-call-model');
const yachiyoRoot = (profile: string) => path.join(profile, 'companion-call-model-yachiyo');
const importsRoot = (profile: string) => path.join(profile, 'companion-call-model-imports');
const companionModelKey = (companionId: string) => createHash('sha256').update(companionId).digest('hex');
const selection = 'active.json';

const reference = (extension: RegExp) => z.string().max(220).regex(extension).transform((name, context) => {
  try {
    if (/[%#]/u.test(name) || name.includes('\0')) throw Error();
    return safeRelative(name.replaceAll('\\', '/').replace(/^\.\//u, ''));
  } catch {
    context.addIssue({ code: 'custom', message: '模型文件引用无效。' });
    return z.NEVER;
  }
});
const jsonReference = reference(/\.json$/iu);
const manifestSchema = z.looseObject({
  FileReferences: z.looseObject({
    Moc: reference(/\.moc3$/iu),
    Textures: z.array(reference(/\.png$/iu)).min(1).max(32),
    Physics: jsonReference.optional(),
    Pose: jsonReference.optional(),
    DisplayInfo: jsonReference.optional(),
    UserData: jsonReference.optional(),
    Expressions: z.array(z.looseObject({ Name: z.string(), File: reference(/\.exp3\.json$/iu) })).max(100).optional(),
    Motions: z.record(z.string(), z.array(z.looseObject({ File: reference(/\.motion3\.json$/iu) }))).optional(),
  }),
});

function modelUrl(relative: string): string {
  return `worldlinebox://${CALL_MODEL_HOST}/${relative.split('/').map(encodeURIComponent).join('/')}`;
}

async function activeGeneration(root: string): Promise<string | undefined> {
  try {
    const value: unknown = JSON.parse(await readFile(path.join(root, selection), 'utf8'));
    if (typeof value === 'string' && generationId.test(value)) return value;
  } catch { /* Older profiles have no custom selection. */ }
}

export async function readLocalCallModel(profile: string, companionId: string): Promise<BotCallModel | undefined> {
  const key = companionModelKey(companionId);
  const root = path.join(importsRoot(profile), key);
  const generation = await activeGeneration(root);
  if (generation) {
    const model = await readBotCallModel(path.join(root, generation), companionId);
    if (model) return { ...model, modelUrl: modelUrl(`imports/${key}/${generation}/${model.model}`), localImport: true };
  }
  const legacyRoot = companionId === DEFAULT_BOT_COMPANION_ID ? dafeiyuRoot(profile)
    : companionId === YACHIYO_BOT_COMPANION_ID ? yachiyoRoot(profile) : undefined;
  const model = await readBotCallModel(legacyRoot, companionId);
  if (model) return { ...model, modelUrl: modelUrl(model.model) };
}

async function folderFiles(root: string, accept: (name: string) => boolean, firstLevelWithMatches = false): Promise<string[]> {
  let directories = [''];
  let visited = 0;
  const files: string[] = [];
  for (let depth = 0; depth <= 6 && directories.length; depth++) {
    const next: string[] = [];
    for (const folder of directories) {
      const entries = await readdir(path.join(root, folder), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.')) continue;
        if (++visited > maxFolderEntries) throw Error('文件夹里有太多文件，请直接选择模型所在的文件夹。');
        const relative = path.posix.join(folder, entry.name);
        if (entry.isFile() && accept(entry.name)) files.push(relative);
        if (entry.isDirectory()) next.push(relative);
      }
    }
    if (firstLevelWithMatches && files.length) break;
    directories = next;
  }
  return files.sort();
}

async function checkSignature(file: string, signature: Buffer) {
  const handle = await open(file, 'r');
  try {
    const actual = Buffer.alloc(signature.length);
    await handle.read(actual, 0, actual.length, 0);
    if (!actual.equals(signature)) throw Error(`模型文件格式无效：${path.basename(file)}`);
  } finally { await handle.close(); }
}

export async function importLocalCallModel(profile: string, companionId: string, directory: string): Promise<void> {
  const picked = await realpath(directory);
  const candidate = await folderFiles(picked, name => modelFile.test(name), true);
  if (candidate.length !== 1) throw Error(candidate.length
    ? '这个文件夹包含多个模型，请选择只包含一个 .model3.json 的模型文件夹。'
    : '找不到 .model3.json。请解压模型并选择其所在的文件夹。');
  const source = await realpath(path.dirname(contained(picked, candidate[0]!)));
  contained(picked, path.relative(picked, source));
  const manifestName = path.basename(candidate[0]!);
  const stem = manifestName.replace(modelFile, '');
  const sourceAsset = async (name: string) => {
    try {
      const file = await realpath(contained(source, safeRelative(name)));
      contained(source, path.relative(source, file));
      const info = await stat(file);
      if (info.isFile() && info.size > 0 && info.size <= maxAssetSize) return { file, size: info.size };
    } catch { /* Report a user-facing error with the asset name. */ }
    throw Error(`模型资源缺失、超出大小限制或不可读取：${name}`);
  };
  let manifest: z.infer<typeof manifestSchema>;
  try {
    const input = await sourceAsset(manifestName);
    manifest = manifestSchema.parse(JSON.parse((await readFile(input.file, 'utf8')).replace(/^\uFEFF/u, '')));
  } catch { throw Error(`无法读取 ${manifestName}。请选择完整的 Live2D Cubism 导出模型。`); }
  const refs = manifest.FileReferences;
  const declaredAnimations = [
    ...(refs.Expressions ?? []).map(item => item.File),
    ...Object.values(refs.Motions ?? {}).flatMap(items => items.map(item => item.File)),
  ];
  const discovered = await folderFiles(source, name => animationFile.test(name) || vtsFile.test(name));
  const vtsCandidates = discovered.filter(name => vtsFile.test(name));
  const vts = vtsCandidates.find(name => name.toLowerCase() === `${stem.toLowerCase()}.vtube.json`)
    ?? (vtsCandidates.length === 1 ? vtsCandidates[0] : undefined);
  const assets = new Set([refs.Moc, ...refs.Textures, refs.Physics, refs.Pose, refs.DisplayInfo, refs.UserData,
    ...declaredAnimations, ...discovered.filter(name => animationFile.test(name)), vts].filter((name): name is string => !!name));
  // Preserve the original companion portrait when importing the original SnowBear pack.
  const yachiyoPortrait = companionId === YACHIYO_BOT_COMPANION_ID && stem === '八千代辉夜姬'
    ? await sourceAsset('八千代辉夜姬头像1.png').catch(() => undefined) : undefined;
  if (assets.size > 256) throw Error('这个模型包含太多资源文件。');
  const root = path.join(importsRoot(profile), companionModelKey(companionId));
  const generation = randomUUID();
  const staged = path.join(root, generation);
  const modelRoot = path.join(staged, 'model');
  await mkdir(modelRoot, { recursive: true });
  try {
    let total = 0;
    for (const name of assets) {
      const { file, size } = await sourceAsset(name);
      total += size;
      if (total > maxModelSize) throw Error('模型资源总大小超过 512 MB。');
      if (name === refs.Moc) await checkSignature(file, Buffer.from('MOC3'));
      if (refs.Textures.includes(name)) await checkSignature(file, Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const target = contained(modelRoot, safeRelative(name));
      await mkdir(path.dirname(target), { recursive: true });
      await copyFile(file, target);
    }
    if (yachiyoPortrait) await copyFile(yachiyoPortrait.file, path.join(staged, 'portrait.png'));
    await writeFile(contained(modelRoot, safeRelative(manifestName)), JSON.stringify(manifest));
    await writeFile(path.join(staged, 'models.json'), JSON.stringify({
      [companionId]: { model: `model/${manifestName}`, ...(vts ? { vts: `model/${vts}` } : {}) },
    }));
    const model = await readBotCallModel(staged, companionId);
    if (!model || declaredAnimations.some(file => ![...model.assets.expressions, ...model.assets.motions].some(item => item.file === file))) {
      throw Error('模型配置或描述文件引用的表情、动作无法加载。');
    }
    await atomicJson(path.join(root, selection), generation);
  } catch (error) {
    await rm(contained(root, generation), { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function resetLocalCallModel(profile: string, companionId: string): Promise<void> {
  await rm(path.join(importsRoot(profile), companionModelKey(companionId), selection), { force: true });
}

// Keep retired generations available to any open renderer for this app session.
export async function pruneLocalCallModelImports(profile: string): Promise<void> {
  const root = await realpath(importsRoot(profile)).catch(() => undefined);
  if (!root) return;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !modelKey.test(entry.name)) continue;
    const directory = contained(root, entry.name);
    const active = await activeGeneration(directory);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (!entry.isDirectory() || !generationId.test(entry.name) || entry.name === active) continue;
      const target = contained(directory, entry.name);
      if (await realpath(target) === target) await rm(target, { recursive: true, force: true });
    }
  }
}

export async function serveLocalCallModel(profile: string, request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  try {
    const [folder, ...parts] = decodeURIComponent(new URL(request.url).pathname.slice(1)).split('/');
    let relative = parts.join('/');
    let base: string;
    if (folder === 'imports') {
      const [key, generation, assetFolder, ...assetParts] = parts;
      if (!key || !modelKey.test(key) || !generation || !generationId.test(generation) || assetFolder !== 'model') return new Response(null, { status: 404 });
      base = path.join(importsRoot(profile), key, generation, 'model');
      relative = assetParts.join('/');
    } else if (folder === 'deepseek' || folder === 'yachiyo') {
      base = path.join(folder === 'deepseek' ? dafeiyuRoot(profile) : yachiyoRoot(profile), folder);
      if (folder === 'yachiyo' && relative === 'portrait.png' && !await stat(path.join(base, relative)).catch(() => undefined)) {
        const root = path.join(importsRoot(profile), companionModelKey(YACHIYO_BOT_COMPANION_ID));
        const generation = await activeGeneration(root);
        if (generation) base = path.join(root, generation);
      }
    } else return new Response(null, { status: 404 });
    const contentType = fileTypes.get(path.posix.extname(relative).toLowerCase());
    if (!contentType) return new Response(null, { status: 404 });
    const root = await realpath(base);
    const file = await realpath(contained(root, safeRelative(relative)));
    contained(root, path.relative(root, file));
    const info = await stat(file);
    if (!info.isFile() || info.size > maxAssetSize) return new Response(null, { status: 404 });
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response(null, { status: 404 }); }
}
