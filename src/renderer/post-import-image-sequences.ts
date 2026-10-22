import {
  DEFAULT_IMAGE_SEQUENCE_FPS,
  detectImageSequences,
  formatImageSequenceDisplayName,
  indexImageSequenceFramesByValue,
} from "../shared/image-sequence";
import type { AssetSummary } from "../shared/asset-types";
import type { ImageSequenceImportOffer } from "../shared/protocol/responses";

export const POST_IMPORT_SEQUENCE_OFFER_PREFIX = "post-import:";

export function isPostImportSequenceOfferId(
  offerId: string | undefined,
): boolean {
  return Boolean(offerId?.startsWith(POST_IMPORT_SEQUENCE_OFFER_PREFIX));
}

export type PostImportSequencePlan = {
  readonly offer: ImageSequenceImportOffer;
  readonly sequences: readonly {
    readonly frameAssetIds: readonly string[];
    readonly frameNumbers: readonly number[];
    /** 预览按修订取源文件：`worldlinebox://source` 需要 revision。 */
    readonly frameRevisionIds: readonly string[];
  }[];
};

function matchingSizeFrames(
  frames: readonly AssetSummary[],
): AssetSummary[] {
  const sized = frames.filter(
    (frame) => frame.width !== null && frame.height !== null,
  );
  if (sized.length !== frames.length) return [...frames];
  const width = sized[0]!.width;
  const height = sized[0]!.height;
  const matched = sized.filter(
    (frame) => frame.width === width && frame.height === height,
  );
  return matched.length >= 3 ? matched : [];
}

export function postImportSequencePlanFromAssets(
  libraryId: string,
  assets: readonly AssetSummary[],
): PostImportSequencePlan | null {
  const eligible = assets.filter(
    (asset) =>
      !asset.deletedAt &&
      !asset.sequence &&
      asset.availability === "available" &&
      asset.mediaType === "image",
  );
  if (eligible.length < 3) return null;
  const byPath = new Map(
    eligible.map((asset) => [asset.relativeFilePath, asset]),
  );
  const candidates = detectImageSequences(
    eligible.map((asset) => asset.relativeFilePath),
  );
  const frameIndex = indexImageSequenceFramesByValue(candidates);
  const offerSequences: ImageSequenceImportOffer["sequences"] = [];
  const sequences: PostImportSequencePlan["sequences"][number][] = [];
  for (const candidate of candidates) {
    if (offerSequences.length >= 64) break;
    const mapped = candidate.frames
      .map((frame) => byPath.get(frame.value))
      .filter((asset): asset is AssetSummary => asset !== undefined);
    const frames = matchingSizeFrames(mapped);
    if (frames.length < 3) continue;
    const first = frames[0]!;
    const last = frames[frames.length - 1]!;
    const firstFrame = frameIndex.get(first.relativeFilePath)?.frame.frameNumber;
    const lastFrame = frameIndex.get(last.relativeFilePath)?.frame.frameNumber;
    if (firstFrame === undefined || lastFrame === undefined) continue;
    offerSequences.push({
      displayName: formatImageSequenceDisplayName({
        firstFrame,
        lastFrame,
        numberStyle: candidate.numberStyle,
        numericWidth: candidate.numericWidth,
        prefix: candidate.prefix,
      }),
      extension: candidate.extension,
      firstFrame,
      frameCount: frames.length,
      height: first.height,
      lastFrame,
      numberStyle: candidate.numberStyle,
      numericWidth: candidate.numericWidth,
      prefix: candidate.prefix,
      width: first.width,
    });
    sequences.push({
      frameAssetIds: frames.map((frame) => frame.assetId),
      frameNumbers: frames.map((frame) => {
        const number = frameIndex.get(frame.relativeFilePath)?.frame.frameNumber;
        return number ?? 0;
      }),
      frameRevisionIds: frames.map((frame) => frame.currentRevisionId),
    });
  }
  if (offerSequences.length === 0) return null;
  return {
    offer: {
      defaultFps: DEFAULT_IMAGE_SEQUENCE_FPS,
      libraryId,
      offerId: `${POST_IMPORT_SEQUENCE_OFFER_PREFIX}${libraryId}`,
      sequences: offerSequences,
    },
    sequences,
  };
}

export function postImportFrameGroupsForAction(input: {
  action: "import-sequence" | "import-selected";
  applyToRest: boolean;
  firstFrame: number;
  lastFrame: number;
  sequenceIndex: number;
  plan: PostImportSequencePlan;
}): { groups: string[][]; nextSequenceIndex: number | null } {
  const nextIndex = input.sequenceIndex + 1;
  const nextSequenceIndex =
    !input.applyToRest && nextIndex < input.plan.sequences.length
      ? nextIndex
      : null;
  if (input.action === "import-selected") {
    return { groups: [], nextSequenceIndex };
  }
  const indexes = input.applyToRest
    ? input.plan.sequences.map((_, index) => index).filter(
        (index) => index >= input.sequenceIndex,
      )
    : [input.sequenceIndex];
  const groups: string[][] = [];
  for (const index of indexes) {
    const sequence = input.plan.sequences[index];
    if (!sequence) continue;
    const first =
      index === input.sequenceIndex
        ? input.firstFrame
        : (input.plan.offer.sequences[index]?.firstFrame ?? input.firstFrame);
    const last =
      index === input.sequenceIndex
        ? input.lastFrame
        : (input.plan.offer.sequences[index]?.lastFrame ?? input.lastFrame);
    const ids = sequence.frameAssetIds.filter((_, frameIndex) => {
      const frameNumber = sequence.frameNumbers[frameIndex];
      return frameNumber !== undefined && frameNumber >= first && frameNumber <= last;
    });
    if (ids.length >= 3) groups.push(ids);
  }
  return { groups, nextSequenceIndex };
}
