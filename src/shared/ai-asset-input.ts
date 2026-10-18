import { IMAGE_EXTENSIONS, VIDEO_EXTENSIONS, MODEL_EXTENSIONS } from './media-formats';
import { TEXT_EXTENSIONS } from './text-media';

export type AiAssetInputKind = 'image' | 'video' | 'model' | 'text' | 'document' | 'unsupported';
const formats: ReadonlyArray<readonly [AiAssetInputKind, readonly string[]]> = [
  ['image', IMAGE_EXTENSIONS], ['video', VIDEO_EXTENSIONS], ['model', MODEL_EXTENSIONS],
  ['text', TEXT_EXTENSIONS], ['document', ['.pdf', '.ai']],
];
/** Input adapters deliberately cover less than import. Never infer content from a filename. */
export function aiAssetInputKind(filename: string): AiAssetInputKind {
  const extension = /\.[^./\\]+$/u.exec(filename)?.[0]?.toLowerCase() ?? '';
  return formats.find(([, extensions]) => extensions.includes(extension))?.[0] ?? 'unsupported';
}
export const AI_ASSET_TEXT_MAX_BYTES = 64 * 1024;
