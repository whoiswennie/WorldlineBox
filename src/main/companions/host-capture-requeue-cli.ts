import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { applyCompanionHostCaptureRequeue, planCompanionHostCaptureRequeue } from '../../companions/host-capture-requeue';

/** Explicit offline operator only; no renderer, ordinary IPC or discovery. */
function main(): void {
  const args = process.argv.slice(2), values = new Map<string, string>(); let apply = false;
  for (let index = 0; index < args.length; ++index) {
    const key = args[index]!;
    if (key === '--apply') { if (apply) throw new Error('重复应用标志。'); apply = true; continue; }
    if (!['--manifest', '--selection', '--approved-manifest-sha'].includes(key) || values.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('不支持的编码恢复参数。');
    values.set(key, args[++index]!);
  }
  const json = (key: string) => {
    const file = values.get(key); if (!file || path.extname(file).toLowerCase() !== '.json') throw new Error('编码恢复只接受明确的 JSON 材料。');
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 256 * 1024) throw new Error('编码恢复材料不是受限普通文件。');
    return JSON.parse(readFileSync(file, 'utf8')) as unknown;
  };
  const selection = z.strictObject({ libraryPath: z.string().refine(value => path.isAbsolute(value)), libraryId: z.string().min(1).max(100) }).parse(json('--selection'));
  const manifest = json('--manifest'), approved = values.get('--approved-manifest-sha');
  if (apply && !/^[a-f0-9]{64}$/u.test(approved ?? '') || !apply && approved !== undefined) throw new Error('仅显式应用接受准确批准的 manifest SHA。');
  console.log(JSON.stringify(apply ? applyCompanionHostCaptureRequeue(selection, manifest, approved!) : planCompanionHostCaptureRequeue(selection, manifest)));
}
try { main(); } catch (error) { console.error(JSON.stringify({ name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : '编码恢复失败。' })); process.exitCode = 1; }
