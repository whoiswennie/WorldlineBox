/** DeepSeek v4 vision-token accounting. */

const PATCH_SIZE = 14
const DOWNSAMPLE_RATIO = 3
const MAX_IMAGE_TOKENS = 384
const COMPRESS_PAD_TO = 4
const MAX_WIDTH_HEIGHT_RATIO = 8
const MIN_PIXELS = 384 * 384

const intDiv = (value: number, divisor: number): number => Math.floor(value / divisor)
const ceilDiv = (value: number, divisor: number): number => Math.floor((value + divisor - 1) / divisor)

interface GridResize {
  readonly gridHeight: number
  readonly gridWidth: number
  readonly bestHeight: number
  readonly bestWidth: number
  readonly numTokens: number
}

function gridTokens(gridHeight: number, gridWidth: number): number {
  let tokens = gridHeight * (gridWidth + 1) + 2
  if (gridHeight % 2 === 1) tokens += gridWidth + 1
  tokens += (ceilDiv(gridHeight, 2) * (gridWidth + 1) % 2) * 2
  return tokens
}

function solveResizeRatio(height: number, width: number, budget: number): GridResize {
  const aspect = height / width
  const idealGridWidth = Math.sqrt((budget - 2) / aspect + 0.25) - 0.5
  const idealGridHeight = idealGridWidth * aspect
  let bestHeight: number
  let bestWidth: number
  if (idealGridWidth < 1) {
    const solvedGridWidth = 1
    let solvedGridHeight = intDiv(budget - 2, solvedGridWidth + 1)
    if (solvedGridHeight % 2 === 1) solvedGridHeight -= 1
    bestWidth = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestHeight = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else if (idealGridHeight < 2) {
    const solvedGridHeight = 2
    const solvedGridWidth = intDiv(budget - 2, solvedGridHeight) - 1
    if (!(solvedGridWidth > 1)) {
      throw new Error('deepseek image tokens: no grid fits the token budget')
    }
    bestWidth = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO
    bestHeight = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO
  } else {
    const solvedGridWidth = Math.trunc(idealGridWidth)
    let solvedGridHeight = Math.trunc(idealGridHeight)
    if (solvedGridHeight % 2 === 1) solvedGridHeight -= 1
    const widthScale = solvedGridWidth * PATCH_SIZE * DOWNSAMPLE_RATIO / width
    const heightScale = solvedGridHeight * PATCH_SIZE * DOWNSAMPLE_RATIO / height
    const scale = Math.min(widthScale, heightScale)
    bestWidth = Math.trunc(width * scale / PATCH_SIZE) * PATCH_SIZE
    bestHeight = Math.trunc(height * scale / PATCH_SIZE) * PATCH_SIZE
  }
  const gridHeight = ceilDiv(intDiv(bestHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const gridWidth = ceilDiv(intDiv(bestWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  return { gridHeight, gridWidth, bestHeight, bestWidth, numTokens: gridTokens(gridHeight, gridWidth) }
}

function safeResize(height: number, width: number, paddedHeight: number, paddedWidth: number): GridResize {
  const gridHeight = ceilDiv(intDiv(paddedHeight, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const gridWidth = ceilDiv(intDiv(paddedWidth, PATCH_SIZE), DOWNSAMPLE_RATIO)
  const budget = MAX_IMAGE_TOKENS - (COMPRESS_PAD_TO - 1)
  let result: GridResize = {
    gridHeight,
    gridWidth,
    bestHeight: paddedHeight,
    bestWidth: paddedWidth,
    numTokens: gridTokens(gridHeight, gridWidth),
  }
  if (result.numTokens > budget) result = solveResizeRatio(height, width, budget)
  return { ...result, numTokens: result.numTokens + COMPRESS_PAD_TO - 1 }
}

function resizeOnce(width: number, height: number): GridResize {
  let clampedWidth = width
  let clampedHeight = height
  if (clampedWidth > clampedHeight * MAX_WIDTH_HEIGHT_RATIO) {
    clampedWidth = clampedHeight * MAX_WIDTH_HEIGHT_RATIO
  }
  const pixels = clampedWidth * clampedHeight
  if (pixels < MIN_PIXELS && pixels > 0) {
    const scale = Math.sqrt(MIN_PIXELS / pixels)
    clampedWidth = Math.trunc(clampedWidth * scale)
    clampedHeight = Math.trunc(clampedHeight * scale)
  }
  const paddedWidth = ceilDiv(clampedWidth, PATCH_SIZE) * PATCH_SIZE
  const paddedHeight = ceilDiv(clampedHeight, PATCH_SIZE) * PATCH_SIZE
  return safeResize(clampedHeight, clampedWidth, paddedHeight, paddedWidth)
}

function sameResize(a: GridResize, b: GridResize): boolean {
  return a.gridHeight === b.gridHeight
    && a.gridWidth === b.gridWidth
    && a.bestHeight === b.bestHeight
    && a.bestWidth === b.bestWidth
    && a.numTokens === b.numTokens
}

/**
* Vision tokens DeepSeek v4 charges for one request image of the given
* dimensions, at the worst-case alignment pad.
* @param width - positive integer request-image width in pixels.
* @param height - positive integer request-image height in pixels.
* @returns the provider vision-token price, at most 384.
*/
export function deepSeekImageTokens(width: number, height: number): number {
  let result = resizeOnce(width, height)
  for (let iteration = 1; iteration < 10; iteration += 1) {
    const next = resizeOnce(result.bestWidth, result.bestHeight)
    if (sameResize(next, result)) return result.numTokens
    result = next
  }
  throw new Error(`deepseek image tokens: resize did not converge for ${width}x${height}`)
}
