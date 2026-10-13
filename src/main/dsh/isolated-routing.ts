import path from 'node:path';
import { mkdir, realpath } from './disk';
import { atomicJson } from './files';
import { buildPrivateSkillRouting } from './private-skills-routing';

export function isolatedWorkspacePath(instanceRoot: string): string {
  return path.join(instanceRoot, 'user', 'Documents', 'deepseek-harness', 'default-workspace');
}
/** Unknown save formats never gain a route into the common credentials or session directory. */
export async function writeIsolatedRoutingPatch(instanceRoot: string, program: string, version: string, signal?: AbortSignal): Promise<string> {
  const root = await realpath(instanceRoot); const directory = path.join(root, 'launcher');
  await mkdir(directory, { recursive: true });
  if (await realpath(directory) !== directory) throw new Error('The isolated adapter directory is linked.');
  let patches: Awaited<ReturnType<typeof buildPrivateSkillRouting>> = [];
  try { patches = await buildPrivateSkillRouting(root, program, version, signal); }
  catch (error) {
    // Earlier official releases with no root override remain private through DSH_HOME and private cwd.
    if (!(error instanceof Error) || !error.message.startsWith('This DSH runtime has no verified private skill routing adapter.')) throw error;
  }
  signal?.throwIfAborted(); const file = path.join(directory, 'isolated-data.patch.yml');
  await atomicJson(file, patches); return file;
}
