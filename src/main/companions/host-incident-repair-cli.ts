import { lstatSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { runCompanionHostIncidentRepair, runCompanionHostQualitativeRepair } from './host-incident-repair';

/** Offline operator entry, intentionally unreferenced by Electron Main and all
 * renderer IPC. Build/run only through the explicit repair script. */
function main(): void {
  const args = process.argv.slice(2), values = new Map<string, string>(); let apply = false;
  for (let index = 0; index < args.length; ++index) {
    const key = args[index]!;
    if (key === '--apply') { if (apply) throw new Error('重复应用标志。'); apply = true; continue; }
    if (!['--manifest', '--parent-manifest', '--selection', '--validation-before', '--validation-after', '--approved-manifest-sha'].includes(key) || values.has(key) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new Error('不支持的事故修复参数。');
    values.set(key, args[++index]!);
  }
  const bytes = (key: string) => {
    const file = values.get(key); if (!file || path.extname(file).toLowerCase() !== '.json') throw new Error('事故修复仅接受明确的 JSON 材料文件。');
    const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 8 * 1024 * 1024) throw new Error('事故修复材料不是受限普通文件。'); return readFileSync(file);
  };
  const input = JSON.parse(bytes('--selection').toString('utf8')) as { libraryPath: string; libraryId: string };
  if (!path.isAbsolute(input.libraryPath) || typeof input.libraryId !== 'string') throw new Error('事故修复必须明确选定真实宿主资产库。');
  const selection = { libraryPath: input.libraryPath, libraryId: input.libraryId }, manifest = JSON.parse(bytes('--manifest').toString('utf8'));
  const approved = values.get('--approved-manifest-sha');
  if (apply && !/^[a-f0-9]{64}$/u.test(approved ?? '')) throw new Error('应用必须逐字批准事故修复 manifest SHA。');
  if (!apply && approved) throw new Error('只读计划无需批准应用 SHA。');
  const options = { mode: apply ? 'apply' as const : 'plan' as const, approvedManifestSHA: approved, validationBefore: bytes('--validation-before'), validationAfter: bytes('--validation-after') };
  const result = manifest?.schema === 'worldlinebox.host-shutdown-qualitative-flags-v1'
    ? runCompanionHostQualitativeRepair(selection, manifest, JSON.parse(bytes('--parent-manifest').toString('utf8')), options)
    : runCompanionHostIncidentRepair(selection, manifest, options);
  console.log(JSON.stringify(result));
}
try { main(); } catch (error) { console.error(JSON.stringify({ name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : '事故修复失败。' })); process.exitCode = 1; }
