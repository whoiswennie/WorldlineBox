import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { openPromise } from 'yauzl';
import { z } from 'zod';
import { DEFAULT_BOT_COMPANION_ID } from '../../shared/builtin-bot-companions';
import { CALL_MODEL_HOST } from '../../shared/companion-call';
import { contained, safeRelative } from '../dsh/files';
import { readBotCallModel } from './call-models';

const manifestName = '大肥鱼.model3.json';
const credits = 'DeepSeek-chan · 原画及拆分：神宫凉子 · Live2D 建模：霓虹猫_NeonNeko';
const fileTypes = new Map([['.json', 'application/json'], ['.png', 'image/png'], ['.moc3', 'application/octet-stream']]);
const references = z.object({ FileReferences: z.object({
  Moc: z.string().endsWith('.moc3'),
  Textures: z.array(z.string().endsWith('.png')).min(1).max(32),
  Physics: z.string().endsWith('.json').optional(),
  Pose: z.string().endsWith('.json').optional(),
  DisplayInfo: z.string().endsWith('.json').optional(),
}) });

export async function readLocalCallModel(root: string, companionId: string) {
  if (companionId !== DEFAULT_BOT_COMPANION_ID) return;
  const model = await readBotCallModel(root, companionId);
  if (model) return { ...model, modelUrl: `worldlinebox://${CALL_MODEL_HOST}/${model.model.split('/').map(encodeURIComponent).join('/')}` };
}

export async function importDafeiyuModel(root: string, archive: string): Promise<void> {
  const source = await stat(archive);
  if (!source.isFile() || source.size > 256 * 1024 ** 2) throw Error('请选择小于 256 MB 的大肥鱼原始 ZIP。');
  if (await readLocalCallModel(root, DEFAULT_BOT_COMPANION_ID)) return;
  await mkdir(path.dirname(root), { recursive: true });
  const parentDirectory = path.resolve(path.dirname(root));
  const staged = await mkdtemp(path.join(parentDirectory, '.call-model-'));
  try {
    const zip = await openPromise(archive, { lazyEntries: true, autoClose: false, strictFileNames: true, validateEntrySizes: true });
    try {
      if (zip.entryCount > 1024) throw Error('模型 ZIP 包含太多文件。');
      const entries = [];
      for await (const entry of zip.eachEntry()) if (!entry.fileName.endsWith('/')) entries.push(entry);
      const modelEntries = entries.filter(entry => path.posix.basename(entry.fileName) === manifestName);
      if (modelEntries.length !== 1) throw Error('ZIP 中须包含一份大肥鱼模型。请使用作者发布的原始 ZIP。');
      const parent = path.posix.dirname(modelEntries[0]!.fileName);
      const prefix = parent === '.' ? '' : parent + '/';
      const names = new Set<string>();
      let bytes = 0;
      for (const entry of entries) {
        if (!entry.fileName.startsWith(prefix) || !fileTypes.has(path.posix.extname(entry.fileName).toLowerCase())) continue;
        const relative = safeRelative(entry.fileName.slice(prefix.length));
        const key = relative.normalize('NFC').toUpperCase();
        const mode = (entry.externalFileAttributes >>> 16) & 0o170000;
        bytes += entry.uncompressedSize;
        if (names.has(key) || entry.isEncrypted() || !entry.canDecodeFileData() || (mode !== 0 && mode !== 0o100000)
          || entry.uncompressedSize > 64 * 1024 ** 2 || bytes > 192 * 1024 ** 2) throw Error('模型 ZIP 包含不受支持、重复或过大的文件。');
        names.add(key);
        const target = contained(staged, 'deepseek/' + relative);
        await mkdir(path.dirname(target), { recursive: true });
        await pipeline(await zip.openReadStreamPromise(entry), createWriteStream(target, { flags: 'wx' }));
      }
      const notice = entries.find(entry => path.posix.basename(entry.fileName).endsWith('使用须知.txt') && entry.uncompressedSize <= 64 * 1024);
      if (notice) await pipeline(await zip.openReadStreamPromise(notice), createWriteStream(path.join(staged, 'MODEL-LICENSE.txt'), { flags: 'wx' }));
    } finally { zip.close(); }
    const model = references.parse(JSON.parse(await readFile(path.join(staged, 'deepseek', manifestName), 'utf8'))).FileReferences;
    for (const relative of [model.Moc, ...model.Textures, model.Physics, model.Pose, model.DisplayInfo]) {
      if (relative && !(await stat(contained(staged, 'deepseek/' + safeRelative(relative)))).size) throw Error('模型文件为空。');
    }
    await writeFile(path.join(staged, 'catalog.json'), JSON.stringify({ expressions: [], motions: [], credits, license: 'MODEL-LICENSE.txt' }));
    await writeFile(path.join(staged, 'models.json'), JSON.stringify({
      [DEFAULT_BOT_COMPANION_ID]: { model: 'deepseek/' + manifestName, catalog: 'catalog.json' },
    }));
    if (!await readLocalCallModel(staged, DEFAULT_BOT_COMPANION_ID)) throw Error('无法读取大肥鱼模型。');
    try { await rename(staged, root); }
    catch (error) { if (!await readLocalCallModel(root, DEFAULT_BOT_COMPANION_ID)) throw error; }
  } finally {
    if (path.dirname(staged) === parentDirectory) await rm(staged, { recursive: true, force: true });
  }
}

export async function serveLocalCallModel(root: string, request: Request): Promise<Response> {
  if (request.method !== 'GET') return new Response(null, { status: 405 });
  try {
    const relative = decodeURIComponent(new URL(request.url).pathname.slice(1));
    const contentType = fileTypes.get(path.posix.extname(relative).toLowerCase());
    if (!relative.startsWith('deepseek/') || !contentType) return new Response(null, { status: 404 });
    const base = await realpath(path.join(root, 'deepseek'));
    const file = await realpath(contained(base, safeRelative(relative.slice('deepseek/'.length))));
    contained(base, path.relative(base, file));
    const info = await stat(file);
    if (!info.isFile() || info.size > 64 * 1024 ** 2) return new Response(null, { status: 404 });
    const bytes = await readFile(file);
    return new Response(new Uint8Array(bytes), { headers: { 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return new Response(null, { status: 404 }); }
}
