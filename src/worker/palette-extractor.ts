import { hexToHsl } from '../shared/color-hsl';

export interface RepresentativeColor {
  hex: string;
  ratio: number;
}

export interface DominantColorMetrics {
  hue: number;
  saturation: number;
  lightness: number;
}

interface Cluster {
  count: number;
  red: number;
  green: number;
  blue: number;
}

/**
 * Four high bits per component keep the histogram bounded to 4096 bins no
 * matter how large the decoded frame is.
 */
const HISTOGRAM_BIN_COUNT = 4096;

function colorDistanceSquared(
  red: number,
  green: number,
  blue: number,
  cluster: Pick<Cluster, 'red' | 'green' | 'blue'>,
): number {
  const deltaRed = red - cluster.red;
  const deltaGreen = green - cluster.green;
  const deltaBlue = blue - cluster.blue;
  return deltaRed * deltaRed + deltaGreen * deltaGreen + deltaBlue * deltaBlue;
}

function byteHex(value: number): string {
  return Math.max(0, Math.min(255, Math.round(value)))
    .toString(16)
    .padStart(2, '0')
    .toUpperCase();
}

export function dominantColorMetrics(hex: string): DominantColorMetrics {
  return hexToHsl(hex);
}

/**
 * Deterministic, bounded representative-colour extraction for already decoded
 * sRGB pixels. Quantized histogram peaks seed a small weighted k-means pass;
 * no randomness means identical content always produces identical JSON.
 *
 * The histogram lives in flat typed arrays instead of a per-pixel `Map`
 * (WorldlineBox-3a9f1c). The previous shape paid one hash lookup plus a bucket
 * object per pixel, so extraction time tracked the decoded pixel count even
 * though only 4096 quantized bins can ever exist. Output is unchanged: the
 * same bins, the same count/key ordering and the same k-means updates, only
 * without the per-pixel allocation. When every occupied bin already fits the
 * requested colour count the k-means pass is a provable no-op and is skipped.
 */
export function extractRepresentativePalette(
  pixels: Uint8Array,
  channels: number,
  maxColors = 6,
): RepresentativeColor[] {
  if (!Number.isInteger(channels) || channels < 3 || channels > 4) {
    throw new Error('Palette pixels must contain RGB or RGBA channels.');
  }
  if (pixels.length === 0 || pixels.length % channels !== 0) {
    throw new Error('Palette pixel buffer is empty or misaligned.');
  }
  const colorLimit = Math.max(1, Math.min(12, Math.trunc(maxColors)));

  const binCounts = new Uint32Array(HISTOGRAM_BIN_COUNT);
  // Float64 keeps the per-bin channel sums exact for any realistic pixel count
  // (integers stay exact well past 2^53) while staying cheaper than BigInt.
  const binRed = new Float64Array(HISTOGRAM_BIN_COUNT);
  const binGreen = new Float64Array(HISTOGRAM_BIN_COUNT);
  const binBlue = new Float64Array(HISTOGRAM_BIN_COUNT);
  const skipTransparent = channels === 4;

  for (let offset = 0; offset < pixels.length; offset += channels) {
    if (skipTransparent && pixels[offset + 3]! < 16) continue;
    const red = pixels[offset]!;
    const green = pixels[offset + 1]!;
    const blue = pixels[offset + 2]!;
    const key = (red >> 4) << 8 | (green >> 4) << 4 | (blue >> 4);
    binCounts[key] = binCounts[key]! + 1;
    binRed[key] = binRed[key]! + red;
    binGreen[key] = binGreen[key]! + green;
    binBlue[key] = binBlue[key]! + blue;
  }

  const occupiedKeys: number[] = [];
  for (let key = 0; key < HISTOGRAM_BIN_COUNT; key += 1) {
    if (binCounts[key]! > 0) occupiedKeys.push(key);
  }
  if (occupiedKeys.length === 0) return [];

  // Pick the heaviest bins in one pass: a bounded insertion into a `colorLimit`
  // sized list is exactly "sort the histogram by count, then bin key, then take
  // the head", without sorting up to 4096 entries to keep at most 12.
  const seedKeys: number[] = [];
  const seedCounts: number[] = [];
  for (const key of occupiedKeys) {
    const count = binCounts[key]!;
    if (seedKeys.length === colorLimit) {
      if (count <= seedCounts[seedCounts.length - 1]!) continue;
      let position = seedKeys.length - 1;
      while (position > 0 && seedCounts[position - 1]! < count) {
        seedKeys[position] = seedKeys[position - 1]!;
        seedCounts[position] = seedCounts[position - 1]!;
        position -= 1;
      }
      seedKeys[position] = key;
      seedCounts[position] = count;
      continue;
    }
    let position = seedKeys.length;
    while (position > 0 && seedCounts[position - 1]! < count) {
      seedKeys[position] = seedKeys[position - 1]!;
      seedCounts[position] = seedCounts[position - 1]!;
      position -= 1;
    }
    seedKeys[position] = key;
    seedCounts[position] = count;
  }

  let clusters: Cluster[] = seedKeys.map((key, index) => {
    const count = seedCounts[index]!;
    return {
      count,
      red: binRed[key]! / count,
      green: binGreen[key]! / count,
      blue: binBlue[key]! / count,
    };
  });

  // Every occupied bin as its own cluster already: assigning each bin to its
  // nearest cluster would map it to itself (bin colours are distinct per bin),
  // so a few deterministic passes would return these exact clusters again.
  if (occupiedKeys.length > clusters.length) {
    const bucketTotal = occupiedKeys.length;
    const bucketWeight = new Float64Array(bucketTotal);
    const bucketMeanRed = new Float64Array(bucketTotal);
    const bucketMeanGreen = new Float64Array(bucketTotal);
    const bucketMeanBlue = new Float64Array(bucketTotal);
    const bucketSumRed = new Float64Array(bucketTotal);
    const bucketSumGreen = new Float64Array(bucketTotal);
    const bucketSumBlue = new Float64Array(bucketTotal);
    for (let index = 0; index < bucketTotal; index += 1) {
      const key = occupiedKeys[index]!;
      const count = binCounts[key]!;
      const red = binRed[key]!;
      const green = binGreen[key]!;
      const blue = binBlue[key]!;
      bucketWeight[index] = count;
      bucketSumRed[index] = red;
      bucketSumGreen[index] = green;
      bucketSumBlue[index] = blue;
      bucketMeanRed[index] = red / count;
      bucketMeanGreen[index] = green / count;
      bucketMeanBlue[index] = blue / count;
    }

    // A few deterministic passes merge the complete histogram into the seeds,
    // so the emitted ratios cover the whole visible image and sum to one.
    for (let iteration = 0; iteration < 4; iteration += 1) {
      const clusterTotal = clusters.length;
      const assignmentCount = new Float64Array(clusterTotal);
      const assignmentRed = new Float64Array(clusterTotal);
      const assignmentGreen = new Float64Array(clusterTotal);
      const assignmentBlue = new Float64Array(clusterTotal);
      for (let index = 0; index < bucketTotal; index += 1) {
        const red = bucketMeanRed[index]!;
        const green = bucketMeanGreen[index]!;
        const blue = bucketMeanBlue[index]!;
        let selected = 0;
        let selectedDistance = colorDistanceSquared(red, green, blue, clusters[0]!);
        for (let cluster = 1; cluster < clusterTotal; cluster += 1) {
          const distance = colorDistanceSquared(red, green, blue, clusters[cluster]!);
          if (distance < selectedDistance) {
            selected = cluster;
            selectedDistance = distance;
          }
        }
        // Accumulate the raw per-bin sums exactly as the histogram stored
        // them, so every cluster mean matches the previous implementation bit
        // for bit instead of round-tripping through a mean times a weight.
        assignmentCount[selected] = assignmentCount[selected]! + bucketWeight[index]!;
        assignmentRed[selected] = assignmentRed[selected]! + bucketSumRed[index]!;
        assignmentGreen[selected] = assignmentGreen[selected]! + bucketSumGreen[index]!;
        assignmentBlue[selected] = assignmentBlue[selected]! + bucketSumBlue[index]!;
      }
      const merged: Cluster[] = [];
      for (let cluster = 0; cluster < clusterTotal; cluster += 1) {
        const count = assignmentCount[cluster]!;
        if (count === 0) continue;
        merged.push({
          count,
          red: assignmentRed[cluster]! / count,
          green: assignmentGreen[cluster]! / count,
          blue: assignmentBlue[cluster]! / count,
        });
      }
      clusters = merged;
    }
  }

  const merged = new Map<string, number>();
  const total = clusters.reduce((sum, cluster) => sum + cluster.count, 0);
  for (const cluster of clusters) {
    const hex = `#${byteHex(cluster.red)}${byteHex(cluster.green)}${byteHex(cluster.blue)}`;
    merged.set(hex, (merged.get(hex) ?? 0) + cluster.count);
  }
  const result = [...merged.entries()]
    .map(([hex, count]) => ({ hex, ratio: count / total, count }))
    .sort((left, right) => right.count - left.count || left.hex.localeCompare(right.hex))
    .map(({ hex, ratio }) => ({ hex, ratio: Number(ratio.toFixed(6)) }));

  // Keep persisted ratios exactly normalized despite decimal rounding.
  const roundedTotal = result.reduce((sum, color) => sum + color.ratio, 0);
  if (result[0] && roundedTotal !== 1) {
    result[0].ratio = Number((result[0].ratio + 1 - roundedTotal).toFixed(6));
  }
  return result;
}
