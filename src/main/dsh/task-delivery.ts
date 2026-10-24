import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { createReadStream, lstat, readFile, realpath } from './disk';
import type { DshTaskSpec } from '../../shared/dsh-task-spec';
import type { DshTaskResult } from '../../shared/dsh-tasks';

// A deliberately explicit, supported JSON Schema subset. Reject unknown assertions instead of ignoring them.
const schemaKeys = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const', 'minimum', 'maximum',
  'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'minItems', 'maxItems', 'description', 'title']);
export function compileDshDeliverySchema(schema?: Record<string, unknown>): z.ZodType | undefined {
  if (!schema) return;
  const check = (value: unknown, depth: number): void => {
    if (depth > 20 || !value || typeof value !== 'object' || Array.isArray(value)) throw new Error('The delivery JSON schema is invalid or too deep.');
    for (const [key, item] of Object.entries(value)) {
      if (!schemaKeys.has(key)) throw new Error(`Unsupported delivery JSON schema keyword: ${key}`);
      if (key === 'properties') {
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid delivery schema properties.');
        for (const child of Object.values(item)) check(child, depth + 1);
      } else if (key === 'items' || key === 'additionalProperties' && typeof item !== 'boolean') check(item, depth + 1);
    }
  };
  check(schema, 0);
  try { return z.fromJSONSchema(schema); } catch { throw new Error('The delivery JSON schema is not supported.'); }
}
function inside(root: string, candidate: string) { const relative = path.relative(root, candidate); return !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`); }

/** Verify actual files and structured content after native completion; prose requirements remain explicitly unverified. */
export async function verifyDshDelivery(result: DshTaskResult, delivery: DshTaskSpec['delivery'], workspace: string,
  allowedRoots: readonly string[] = [], signal?: AbortSignal): Promise<void> {
  const schema = compileDshDeliverySchema(delivery?.jsonSchema);
  if (schema && !schema.safeParse(result.structured).success) throw new Error('The task JSON delivery does not satisfy its required schema.');
  const roots = await Promise.all([workspace, ...allowedRoots].map(root => realpath(root)));
  const requirements = delivery?.artifacts ?? [];
  for (const required of requirements) {
    const target = path.resolve(workspace, required.path);
    if (!(result.artifacts ?? []).some(artifact => path.resolve(artifact.path) === target)) throw new Error('A required task artifact was not presented.');
  }
  const verified: NonNullable<DshTaskResult['artifacts']> = [];
  for (const artifact of result.artifacts ?? []) {
    signal?.throwIfAborted();
    const info = await lstat(artifact.path).catch(() => undefined);
    if (!info?.isFile() || info.isSymbolicLink()) throw new Error('The reported task artifact is unavailable or is not a regular file.');
    const resolved = await realpath(artifact.path);
    if (!roots.some(root => inside(root, resolved))) throw new Error('The reported task artifact is outside the authorized workspace.');
    const hash = createHash('sha256'); const input = createReadStream(resolved, { signal });
    for await (const chunk of input) hash.update(chunk);
    const sha256 = hash.digest('hex');
    const required = requirements.filter(item => path.resolve(workspace, item.path) === path.resolve(artifact.path));
    for (const rule of required) {
      if (rule.minBytes !== undefined && info.size < rule.minBytes || rule.maxBytes !== undefined && info.size > rule.maxBytes || rule.sha256 && rule.sha256 !== sha256)
        throw new Error('The task artifact does not satisfy its size or digest requirement.');
      if (rule.containsText !== undefined) {
        if (info.size > 2 * 1024 ** 2) throw new Error('The artifact is too large for the requested text verification.');
        if (!(await readFile(resolved, 'utf8')).includes(rule.containsText)) throw new Error('The task artifact does not contain the required text.');
      }
    }
    const after = await lstat(resolved);
    if (after.size !== info.size || after.mtimeMs !== info.mtimeMs || after.ino !== info.ino) throw new Error('The task artifact changed during verification.');
    verified.push({ ...artifact, bytes: info.size, sha256 });
  }
  result.artifacts = verified;
  result.verification = { status: 'passed', jsonSchema: !!schema, artifactChecks: requirements.length,
    unverifiedRequirements: delivery?.requirements ?? [] };
}
