import { createHash } from 'node:crypto';
import { inventoryTree, type TreeInventory } from './files';

const GENERATED_METADATA = new Set(['node-runtime.json', 'dsh/package.json', 'dsh/package-lock.json', 'dsh/node_modules/.package-lock.json']);
/** A portable identity covers every actual SDK and binary byte; only four manager-generated metadata files vary by installation. */
export async function nodeRuntimePayloadSha256(program: string, signal?: AbortSignal): Promise<string> {
  const actual = await inventoryTree(program, signal);
  return nodeRuntimePayloadShaFromInventory(actual);
}
/** The caller supplies an inventory just computed from actual files, or verified against its registered full seal. */
export function nodeRuntimePayloadShaFromInventory(actual: TreeInventory): string {
  const files = actual.files.filter(file => !GENERATED_METADATA.has(file.path));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
