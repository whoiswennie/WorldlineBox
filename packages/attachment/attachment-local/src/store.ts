/** Content-addressed, owner-private local attachment storage. */

import { createHash, randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { chmod, link, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { dirname, join, parse, resolve } from 'node:path'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type {
  ImageAttachmentLimits,
  ImageAttachmentRef,
  SaveImageAttachment,
  StoredImageAttachment,
} from '@deepseek-ai/dsh-attachment'
import { normalizeImage } from './normalization.ts'
import type { NormalizationPolicy } from './normalization.ts'
import { detectImage, probeImage } from './image.ts'
import type { DetectedImage } from './image.ts'

const ID_PATTERN = /^sha256:([a-f0-9]{64})$/
const durableHomes = new Set<string>()

function digest(data: Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

function displayName(value: string | undefined): string | undefined {
  if (value === undefined) return undefined
  const leaf = value.slice(Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\')) + 1)
  const clean = leaf.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 255)
  return clean === '' ? undefined : clean
}

function ensureReference(ref: ImageAttachmentRef): string {
  const match = ID_PATTERN.exec(String(ref.attachmentId))
  if (match?.[1] === undefined) {
    throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF')
  }
  return match[1]
}

/**
* Derive the absolute immutable-object path for one normalized attachment.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param ref - durable normalized attachment reference.
* @returns provider-local path without reading the object.
*/
export function normalizedImagePath(root: string, ref: ImageAttachmentRef): string {
  const sha256 = ensureReference(ref)
  return join(root, 'objects', sha256.slice(0, 2), sha256)
}

async function inspectMetadata(
  data: Uint8Array,
  declaredMediaType: ImageAttachmentRef['mediaType'],
  limits: ImageAttachmentLimits,
): Promise<DetectedImage> {
  if (data.byteLength === 0) throw new AttachmentError('Image is empty.', 'INVALID_IMAGE')
  const detected = await detectImage(data, {
    maxPixels: limits.maxImagePixels,
    maxDimension: limits.maxImageDimension,
  })
  if (detected.mediaType !== declaredMediaType) {
    throw new AttachmentError('Declared image type does not match its bytes.', 'IMAGE_TYPE_MISMATCH')
  }
  return detected
}

/** Fully prepared normalized object, verified before any batch member is persisted. */
export interface PreparedImageFile {
  data: Uint8Array
  ref: ImageAttachmentRef
}

/**
* Decode, normalize, and verify one submitted image without touching storage.
* @param input - submitted encoded bytes and declared media type.
* @param limits - source admission policy.
* @param policy - independent normalization policy.
* @returns immutable reference facts beside bytes ready for atomic publication.
*/
export async function prepareImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy?: NormalizationPolicy,
): Promise<PreparedImageFile> {
  if (input.data.byteLength > limits.maxImageBytes) {
    throw new AttachmentError('Image exceeds the configured byte limit.', 'IMAGE_TOO_LARGE')
  }
  const detected = await inspectMetadata(input.data, input.mediaType, limits)
  // Direct low-level callers from 0.2.1 retain byte-identical persistence
  // when they omit the new policy. LocalAttachmentStore always supplies its
  // explicit provider-independent normalization policy for new admissions.
  const normalized = policy === undefined
    ? {
      data: input.data,
      mediaType: detected.mediaType,
      width: detected.width,
      height: detected.height,
    }
    : await normalizeImage(input.data, detected, policy)
  const sha256 = digest(normalized.data)
  const name = displayName(input.name)
  const downscaled = detected.width !== normalized.width || detected.height !== normalized.height
  return {
    data: normalized.data,
    ref: {
      attachmentId: AttachmentId(`sha256:${sha256}`),
      mediaType: normalized.mediaType,
      width: normalized.width,
      height: normalized.height,
      bytes: normalized.data.byteLength,
      ...(name !== undefined ? { name } : {}),
      ...downscaled
        ? { originalDimensions: { width: detected.width, height: detected.height } }
        : {},
    },
  }
}

/**
* Run the full admission policy for one image without touching storage,
* including normalization: a batch whose members all validate cannot later
* be refused by the normalized image byte cap during publication.
* @param input - encoded bytes and declared metadata.
* @param limits - resolved source admission policy.
* @param policy - resolved normalization policy.
* @returns completion after the raster has been decoded and its normalized version proven to fit.
*/
export async function validateImageFile(
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy?: NormalizationPolicy,
): Promise<void> {
  await prepareImageFile(input, limits, policy)
}

async function syncDirectory(path: string): Promise<void> {
  /* v8 ignore next -- Windows cannot open directory handles. */
  if (process.platform === 'win32') return
  /* v8 ignore start */
  const handle = await open(path, constants.O_RDONLY)
  try {
    await handle.sync()
  } finally {
    await handle.close()
  }
  /* v8 ignore stop */
}

async function ensureDurableDirectory(path: string, boundary: string): Promise<void> {
  const target = resolve(path)
  const stop = resolve(boundary)
  await mkdir(target, { recursive: true, mode: 0o700 })
  await chmod(target, 0o700)
  let level = target
  while (level !== stop) {
    const parent = dirname(level)
    await syncDirectory(parent)
    /* v8 ignore next -- callers provide an ancestor boundary. */
    if (parent === level) return
    level = parent
  }
}

/** Prove that this process's WORLDLINE_HOME path is durably published. */
async function ensureDurableHome(path: string): Promise<string> {
  const home = resolve(path)
  if (!durableHomes.has(home)) {
    await ensureDurableDirectory(home, parse(home).root)
    durableHomes.add(home)
  }
  return home
}

/**
* Publish one already verified normalized image below a versioned attachment root.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param prepared - deterministic normalized bytes and reference.
* @returns durable content-addressed normalized image reference.
*/
export async function commitPreparedImageFile(
  root: string,
  prepared: PreparedImageFile,
): Promise<ImageAttachmentRef> {
  const normalized = prepared.data
  const sha256 = ensureReference(prepared.ref)
  if (digest(normalized) !== sha256 || normalized.byteLength !== prepared.ref.bytes) {
    throw new AttachmentError('Prepared attachment bytes do not match their reference.', 'ATTACHMENT_CORRUPT')
  }
  const bucket = join(root, 'objects', sha256.slice(0, 2))
  const staging = join(root, 'tmp')
  const boundary = await ensureDurableHome(dirname(dirname(resolve(root))))
  await ensureDurableDirectory(bucket, boundary)
  await ensureDurableDirectory(staging, boundary)
  const temporary = join(staging, randomUUID())
  const target = normalizedImagePath(root, prepared.ref)
  let handle
  try {
    handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600)
    await handle.writeFile(normalized)
    await handle.sync()
    await handle.close()
    handle = undefined
    try {
      await link(temporary, target)
    } catch (error) {
      /* v8 ignore next -- EEXIST is the expected content-addressed race. */
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      const existing = new Uint8Array(await readFile(target))
      if (digest(existing) !== sha256) {
        throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
      }
    }
    await unlink(temporary)
    await chmod(target, 0o400)
    await syncDirectory(bucket)
    await syncDirectory(join(root, 'objects'))
  } catch (error) {
    /* v8 ignore next */
    if (handle !== undefined) await handle.close().catch(() => {})
    await unlink(temporary).catch((cleanupError: unknown) => {
      /* v8 ignore next */
      if (!(cleanupError instanceof Error && 'code' in cleanupError && cleanupError.code === 'ENOENT')) {
        throw cleanupError
      }
    })
    if (error instanceof AttachmentError) throw error
    throw new AttachmentError('Unable to persist image attachment.', 'ATTACHMENT_WRITE_FAILED', {
      cause: error,
    })
  }
  return prepared.ref
}

/**
* Decode and normalize one image once, then publish the prepared object.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param input - submitted encoded bytes and declared media type.
* @param limits - resolved source admission policy.
* @param policy - resolved normalization policy.
* @returns durable content-addressed normalized image reference.
*/
export async function saveImageFile(
  root: string,
  input: SaveImageAttachment,
  limits: ImageAttachmentLimits,
  policy?: NormalizationPolicy,
): Promise<ImageAttachmentRef> {
  return commitPreparedImageFile(root, await prepareImageFile(input, limits, policy))
}

/**
* Read and verify one content-addressed image.
* @param root - absolute `DSH_HOME/attachments/v1` root.
* @param ref - reference recorded in the session log.
* @param signal - optional cancellation for filesystem and verification work.
* @returns verified bytes and reference.
* @throws the signal reason when aborted, or an AttachmentError when verification fails.
*/
export async function readImageFile(
  root: string,
  ref: ImageAttachmentRef,
  signal?: AbortSignal,
): Promise<StoredImageAttachment> {
  signal?.throwIfAborted()
  const sha256 = ensureReference(ref)
  let data: Uint8Array
  try {
    data = new Uint8Array(await readFile(normalizedImagePath(root, ref), { signal }))
  } catch (error) {
    signal?.throwIfAborted()
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new AttachmentError('Attachment object is missing.', 'ATTACHMENT_NOT_FOUND')
    }
    throw new AttachmentError('Unable to read image attachment.', 'ATTACHMENT_READ_FAILED', {
      cause: error,
    })
  }
  signal?.throwIfAborted()
  if (digest(data) !== sha256) {
    throw new AttachmentError('Stored attachment failed integrity verification.', 'ATTACHMENT_CORRUPT')
  }
  const metadata = await probeImage(data)
  signal?.throwIfAborted()
  if (metadata.mediaType !== ref.mediaType || data.byteLength !== ref.bytes
    || metadata.width !== ref.width || metadata.height !== ref.height) {
    throw new AttachmentError('Stored attachment metadata does not match its reference.', 'ATTACHMENT_CORRUPT')
  }
  return { ref, data }
}
