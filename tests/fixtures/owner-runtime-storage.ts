import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { CompanionOwnerRuntimeStorage, CompanionOwnerRuntimePaths } from '../../src/main/companions/owner-runtime-storage';
import { loadInitialTimelinePrompts } from '../../src/main/vcp-memory/owner-prompts';

/** Synthetic asset library with the same bootstrap-then-live-file contract. */
export function fixtureOwnerRuntimePaths(workspaceRoot: string): (ownerId: string) => Promise<CompanionOwnerRuntimePaths> {
  return async ownerId => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(ownerId)) throw new Error('Invalid fixture owner.');
    const ownerRoot = path.join(path.resolve(workspaceRoot), ownerId);
    return { ownerId, workspaceRoot: path.resolve(workspaceRoot), ownerRoot, indexRoot: path.join(ownerRoot, '.认知索引') };
  };
}
export function fixtureOwnerRuntimeStorage(workspaceRoot: string, options: { vendorRoot?: string } = {}): (ownerId: string) => Promise<CompanionOwnerRuntimeStorage> {
  return async ownerId => {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(ownerId)) throw new Error('Invalid fixture owner.');
    const ownerRoot = path.join(path.resolve(workspaceRoot), ownerId), indexRoot = path.join(ownerRoot, '.认知索引');
    const promptsRoot = path.join(ownerRoot, '提示词'), focus = path.join(promptsRoot, '记忆聚焦.md');
    const marker = path.join(ownerRoot, '.fixture-runtime-prompts.json');
    try { await readFile(marker, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      await mkdir(indexRoot, { recursive: true }); await mkdir(promptsRoot, { recursive: true });
      const vendor = options.vendorRoot ?? path.resolve('vendor/vcp-memory');
      const initial = await loadInitialTimelinePrompts(vendor);
      const aimemo = await readFile(path.join(vendor, 'Plugin/RAGDiaryPlugin/AIMemoPrompt.txt'), 'utf8');
      for (const [file, content] of [['记忆聚焦.md', aimemo], ['月度时间线.md', initial.timeline], ['月度摘要.md', initial.summary]]) {
        await writeFile(path.join(promptsRoot, file!), content!, { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
      }
      await writeFile(marker, '{}', { flag: 'wx' }).catch(error => { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; });
    }
    return { ownerId, workspaceRoot: path.resolve(workspaceRoot), ownerRoot, indexRoot,
      ownerPrompts: { aimemoTemplate: await readFile(focus, 'utf8'), timelineTemplate: await readFile(path.join(promptsRoot, '月度时间线.md'), 'utf8'),
        summaryTemplate: await readFile(path.join(promptsRoot, '月度摘要.md'), 'utf8') } };
  };
}
