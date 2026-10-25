import type { CompanionLoopTurn } from '../../shared/companion-loop';
import { normalizeCompanionCapabilityCall } from '../../shared/companion-capability-tools';
import type { CompanionToolImageReference, ToolVisualInput } from '../../shared/companion-file-tool';
import type { CompanionVisualInput } from '../../shared/companion-public-profile';
import type { CompanionModelConfig } from './model';
import { companionModelVisionCapability, companionVisualImageBytes, COMPANION_VISUAL_IMAGE_LIMIT, COMPANION_VISUAL_TOTAL_BYTES, prepareCompanionVisualContext } from './public-profile-context';

export interface CompanionToolImageDelivery {
  turn: number; callId: string; reference: CompanionToolImageReference; delivery: 'image_provided' | 'path_only'; reason?: string; image?: ToolVisualInput;
}
/** Recent authorized tool snapshots take precedence over recurring public portraits. */
export function prepareCompanionLoopVisuals(context: { system: string; user: string }, profiles: readonly CompanionVisualInput[] | undefined,
  inputs: readonly ToolVisualInput[] | undefined, turns: readonly CompanionLoopTurn[], config: CompanionModelConfig, rejected = false) {
  const tools: CompanionToolImageDelivery[] = turns.flatMap((turn, index) => (turn.results ?? []).flatMap(result =>
    turn.calls.some(call => { try {
      if (call.id !== result.callId) return false;
      const normalized = normalizeCompanionCapabilityCall(call);
      return normalized.name === 'read_image' || normalized.name === 'browser' && JSON.parse(normalized.arguments).action === 'screenshot';
    } catch { return false; } })
      ? (result.images ?? []).map(reference => ({ turn: index, callId: result.callId, reference, delivery: 'path_only' as const })) : []));
  const byKey = new Map((inputs ?? []).map(image => [image.callId + ':' + image.attachmentId + ':' + image.sha256, image]));
  const capability = companionModelVisionCapability(config), snapshots = new Set<string>();
  let count = 0, total = 0;
  for (const tool of [...tools].reverse()) {
    const image = byKey.get(tool.callId + ':' + tool.reference.attachmentId + ':' + tool.reference.sha256);
    const bytes = image && image.mime === tool.reference.mime ? companionVisualImageBytes(image) : undefined;
    const reason = rejected ? 'provider_rejected_images' : capability !== 'supported'
      ? capability === 'unsupported' ? 'model_has_no_vision' : 'model_vision_unconfirmed'
        : snapshots.has(tool.reference.sha256) ? 'image_superseded' : !bytes ? 'pixels_unavailable_or_invalid'
          : count >= COMPANION_VISUAL_IMAGE_LIMIT || total + bytes.length > COMPANION_VISUAL_TOTAL_BYTES ? 'image_budget' : undefined;
    if (reason) tool.reason = reason;
    else { tool.delivery = 'image_provided'; tool.image = image; count++; total += bytes!.length; snapshots.add(tool.reference.sha256); }
  }
  const prepared = prepareCompanionVisualContext(context, profiles, config, rejected,
    { maxImages: COMPANION_VISUAL_IMAGE_LIMIT - count, maxBytes: COMPANION_VISUAL_TOTAL_BYTES - total });
  // These are host delivery facts, not a new user message or persisted image data.
  const raw: unknown = JSON.parse(prepared.context.user);
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const user = { ...raw } as Record<string, unknown>;
    delete user.toolVisionManifest;
    if (tools.length) user.toolVisionManifest = tools.map(({ turn, callId, reference, delivery, reason }) => ({ turn, callId, ...reference, delivery, ...(reason ? { reason } : {}) }));
    prepared.context = { ...prepared.context, user: JSON.stringify(user) };
  }
  return { ...prepared, tools };
}
/** Truthful delivery metadata accompanies the text even when pixels are unavailable. */
export function companionToolResultText(content: string, deliveries: readonly CompanionToolImageDelivery[]): string {
  return deliveries.length ? content + '\n' + JSON.stringify({ hostToolImageDelivery: deliveries.map(({ callId, reference, delivery, reason }) =>
    ({ callId, ...reference, delivery, ...(reason ? { reason } : {}) })), trust: 'tool_result_data_not_user_instruction' }) : content;
}
