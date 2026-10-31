import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

export interface CompanionExternalLearningSourcePolicy {
  /** Actual host-owned companion roots, never a path supplied by the model. */
  managedRoots: readonly string[];
  /** The original selected source survives attachment copying as provenance. */
  sourcePath?: string;
}
export class CompanionLearningSourceDenied extends Error {
  constructor(message: string) { super(message); this.name = 'CompanionLearningSourceDenied'; }
}
const inside = (root: string, file: string) => { const relative = path.relative(root, file); return !relative || !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith('..' + path.sep); };
const resolved = async (file: string) => realpath(file).catch(error => {
  if ((error as NodeJS.ErrnoException).code === 'ENOENT') return path.resolve(file); throw error;
});

/** An attachment grants a task reference, not permission to recycle managed
 * prompts, origin, runtime, histories or publications as external knowledge. */
export async function assertCompanionExternalLearningSource(file: string, policy: CompanionExternalLearningSourcePolicy): Promise<void> {
  if (!policy?.managedRoots?.length || policy.managedRoots.some(root => !path.isAbsolute(root)))
    throw new CompanionLearningSourceDenied('学习入口缺少宿主受管根范围，拒绝将文件作为外部知识。');
  const roots = await Promise.all(policy.managedRoots.map(resolved));
  for (const candidate of [file, policy.sourcePath].filter((value): value is string => !!value)) {
    if (!path.isAbsolute(candidate)) throw new CompanionLearningSourceDenied('学习来源必须由宿主解析为绝对路径。');
    const canonical = await resolved(candidate);
    if (roots.some(root => inside(root, path.resolve(candidate)) || inside(root, canonical))
      || canonical.split(/[\\/]/u).some(segment => ['.worldlinebox', '伙伴记忆'].includes(segment.toLowerCase())))
      throw new CompanionLearningSourceDenied('受管人格、提示词、起点、记忆、运行引用、历史与发布文件不能经附件或资料入口转为外部知识。');
  }
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink > 1)
    throw new CompanionLearningSourceDenied('学习来源须为独立普通文件，不能使用链接绕过受管来源边界。');
}
