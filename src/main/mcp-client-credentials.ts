import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

import { z } from 'zod';

import type { McpClientCredentialSummary } from '../shared/mcp';
import { readAtomicJsonFile, writeAtomicJsonFile } from './atomic-json-file';

const credentialRecordSchema = z.strictObject({
  credentialId: z.string().uuid(),
  tokenHash: z.string().regex(/^[a-f0-9]{64}$/u),
  tokenCiphertext: z.string().min(1).optional(),
  label: z.string().min(1).max(255),
  createdAt: z.string().datetime(),
  lastUsedAt: z.string().datetime().nullable(),
  revokedAt: z.string().datetime().nullable(),
});
type CredentialRecord = z.infer<typeof credentialRecordSchema>;

const credentialFileSchema = z.strictObject({
  version: z.literal(1),
  credentials: z.array(credentialRecordSchema).max(256),
});

const TOKEN_PEPPER_BYTES = 32;
const TOKEN_CIPHER_ALGORITHM = 'aes-256-gcm';
const TOKEN_CIPHER_IV_BYTES = 12;

export type IssuedMcpClientCredential = {
  credentialId: string;
  token: string;
  summary: McpClientCredentialSummary;
};

export type McpCredentialAuthenticationState = 'valid' | 'unknown' | 'revoked';

export type McpCredentialStoreErrorCode =
  | 'MCP_CREDENTIAL_ACCESS_DENIED'
  | 'MCP_CREDENTIAL_INVALID'
  | 'MCP_CREDENTIAL_READ_FAILED'
  | 'MCP_CREDENTIAL_CREATE_FAILED'
  | 'MCP_CREDENTIAL_ACL_FAILED';

export class McpCredentialStoreError extends Error {
  public readonly code: McpCredentialStoreErrorCode;
  public readonly filePath: string;
  public readonly systemCode?: string;
  public readonly recoveryCode?: string;

  constructor(input: {
    code: McpCredentialStoreErrorCode;
    filePath: string;
    systemCode?: string;
    recoveryCode?: string;
    message: string;
    cause?: unknown;
  }) {
    super(input.message, { cause: input.cause });
    this.name = 'McpCredentialStoreError';
    this.code = input.code;
    this.filePath = input.filePath;
    this.systemCode = input.systemCode;
    this.recoveryCode = input.recoveryCode;
  }
}

type PepperReadDependencies = {
  platform: NodeJS.Platform;
  readFile(filename: string): Buffer;
  repairAccess(filename: string): void;
};

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : undefined;
}

function credentialFileError(
  code: McpCredentialStoreErrorCode,
  filename: string,
  error: unknown,
  message: string,
  recoveryError?: unknown,
): McpCredentialStoreError {
  return new McpCredentialStoreError({
    code,
    filePath: filename,
    systemCode: errorCode(error),
    ...(recoveryError === undefined ? {} : { recoveryCode: errorCode(recoveryError) ?? 'ACL_REPAIR_FAILED' }),
    message,
    cause: recoveryError === undefined ? error : new AggregateError([error, recoveryError]),
  });
}

export function parseCurrentUserSid(output: string): string {
  const sid = output.match(/\bS-1-(?:\d+-)*\d+\b/u)?.[0];
  if (sid === undefined) throw new Error('Could not determine the current Windows user SID.');
  return sid;
}

function currentWindowsUserSid(): string {
  const result = spawnSync('whoami.exe', ['/user', '/fo', 'csv', '/nh'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) throw new Error('whoami.exe could not identify the current Windows user.');
  return parseCurrentUserSid(result.stdout);
}

/** ACL for a newly created pepper: remove inherited grants and allow this user. */
export function buildPepperFileAclArgs(filename: string, userSid: string): string[] {
  return [filename, '/inheritance:r', '/grant:r', `*${userSid}:F`];
}

/** Preserve existing ACL entries and add access for the user now running WorldlineBox. */
export function buildPepperFileAccessRepairArgs(filename: string, userSid: string): string[] {
  return [filename, '/grant:r', `*${userSid}:F`];
}

function runIcacls(args: string[]): void {
  const result = spawnSync('icacls.exe', args, {
    stdio: 'ignore',
    windowsHide: true,
  });
  if (result.error !== undefined) throw result.error;
  if (result.status !== 0) {
    const error = new Error(`icacls.exe failed with exit status ${String(result.status)}.`) as Error & { code?: string };
    error.code = result.status === null ? 'ICACLS_FAILED' : String(result.status);
    throw error;
  }
}

function repairPepperFileAccess(filename: string): void {
  const userSid = currentWindowsUserSid();
  runIcacls(buildPepperFileAccessRepairArgs(filename, userSid));
}

function restrictNewPepperFile(filename: string): void {
  const userSid = currentWindowsUserSid();
  runIcacls(buildPepperFileAclArgs(filename, userSid));
}

const defaultPepperReadDependencies: PepperReadDependencies = {
  platform: process.platform,
  readFile: (filename) => readFileSync(filename),
  repairAccess: repairPepperFileAccess,
};

export function readExistingPepper(
  filename: string,
  dependencies: PepperReadDependencies = defaultPepperReadDependencies,
): Buffer | undefined {
  let contents: Buffer;
  try {
    contents = dependencies.readFile(filename);
  } catch (readError) {
    const readCode = errorCode(readError);
    if (readCode === 'ENOENT') return undefined;
    if (readCode !== 'EACCES' && readCode !== 'EPERM') {
      throw credentialFileError(
        'MCP_CREDENTIAL_READ_FAILED',
        filename,
        readError,
        'Could not read the MCP credential key file.',
      );
    }

    if (dependencies.platform !== 'win32') {
      throw credentialFileError(
        'MCP_CREDENTIAL_ACCESS_DENIED',
        filename,
        readError,
        'Access to the MCP credential key file was denied.',
      );
    }

    try {
      dependencies.repairAccess(filename);
      contents = dependencies.readFile(filename);
    } catch (repairError) {
      if (errorCode(repairError) === 'ENOENT') return undefined;
      throw credentialFileError(
        'MCP_CREDENTIAL_ACCESS_DENIED',
        filename,
        readError,
        'Could not restore access to the MCP credential key file. The existing key was not changed.',
        repairError,
      );
    }
  }

  if (contents.byteLength !== TOKEN_PEPPER_BYTES) {
    throw new McpCredentialStoreError({
      code: 'MCP_CREDENTIAL_INVALID',
      filePath: filename,
      message: 'The MCP credential key file has an invalid length; the existing key was not changed.',
    });
  }
  return contents;
}

export function readOrCreatePepper(
  filename: string,
  createDirectory: (directory: string) => void = (directory) => mkdirSync(directory, { recursive: true }),
): Buffer {
  const existing = readExistingPepper(filename);
  if (existing !== undefined) return existing;

  const pepper = randomBytes(TOKEN_PEPPER_BYTES);
  try {
    createDirectory(path.dirname(filename));
  } catch (error) {
    throw credentialFileError(
      'MCP_CREDENTIAL_CREATE_FAILED',
      filename,
      error,
      'Could not create the MCP credential key directory.',
    );
  }
  try {
    writeFileSync(filename, pepper, { mode: 0o600, flag: 'wx', flush: true });
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      const raced = readExistingPepper(filename);
      if (raced !== undefined) return raced;
    }
    throw credentialFileError(
      'MCP_CREDENTIAL_CREATE_FAILED',
      filename,
      error,
      'Could not create the MCP credential key file.',
    );
  }

  try {
    chmodSync(filename, 0o600);
    // POSIX mode bits do not secure a Windows file. Keep a newly created key
    // readable only by the current SID before allowing the server to use it.
    if (process.platform === 'win32') restrictNewPepperFile(filename);
  } catch (error) {
    let cleanupError: unknown;
    try {
      unlinkSync(filename);
    } catch (failedCleanup) {
      cleanupError = failedCleanup;
    }
    throw credentialFileError(
      process.platform === 'win32' ? 'MCP_CREDENTIAL_ACL_FAILED' : 'MCP_CREDENTIAL_CREATE_FAILED',
      filename,
      error,
      cleanupError === undefined
        ? 'Could not secure the new MCP credential key file; the incomplete file was removed.'
        : 'Could not secure or remove the new MCP credential key file.',
      cleanupError,
    );
  }
  return pepper;
}

function hashToken(token: string, pepper: Buffer): string {
  return createHash('sha256').update(pepper).update(token, 'utf8').digest('hex');
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(TOKEN_CIPHER_IV_BYTES);
  const cipher = createCipheriv(TOKEN_CIPHER_ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((part) => part.toString('base64url')).join('.');
}

function decryptToken(encoded: string, key: Buffer): string | undefined {
  const [ivEncoded, tagEncoded, ciphertextEncoded] = encoded.split('.');
  if (!ivEncoded || !tagEncoded || !ciphertextEncoded) return undefined;
  try {
    const iv = Buffer.from(ivEncoded, 'base64url');
    const tag = Buffer.from(tagEncoded, 'base64url');
    const ciphertext = Buffer.from(ciphertextEncoded, 'base64url');
    if (iv.byteLength !== TOKEN_CIPHER_IV_BYTES || tag.byteLength !== 16 || ciphertext.byteLength === 0) {
      return undefined;
    }
    const decipher = createDecipheriv(TOKEN_CIPHER_ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return undefined;
  }
}


function summary(record: CredentialRecord): McpClientCredentialSummary {
  return {
    credentialId: record.credentialId,
    label: record.label,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
  };
}

export class McpClientCredentialStore {
  readonly #filePath: string;
  readonly #pepper: Buffer;
  #records: CredentialRecord[] = [];
  #persistTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(userDataPath: string) {
    this.#filePath = path.join(userDataPath, 'mcp-client-credentials.json');
    this.#pepper = readOrCreatePepper(path.join(userDataPath, 'mcp-client-credential-pepper'));
    this.load();
  }

  list(): McpClientCredentialSummary[] {
    return this.#records.map(summary);
  }

  issue(label = 'MCP client'): IssuedMcpClientCredential {
    if (this.#records.length >= 256) {
      throw new Error('The MCP client credential limit of 256 has been reached; revoke an old credential first.');
    }
    const now = new Date().toISOString();
    const token = randomBytes(32).toString('base64url');
    const record: CredentialRecord = {
      credentialId: randomUUID(),
      tokenHash: hashToken(token, this.#pepper),
      tokenCiphertext: encryptToken(token, this.#pepper),
      label: label.trim() || 'MCP client',
      createdAt: now,
      lastUsedAt: null,
      revokedAt: null,
    };
    this.#records = [...this.#records, record].slice(-256);
    this.persist();
    return { credentialId: record.credentialId, token, summary: summary(record) };
  }

  /** Return the stable token for a live credential so it can be copied again. */
  tokenFor(credentialId: string): string | undefined {
    const record = this.#records.find((candidate) => candidate.credentialId === credentialId);
    if (record === undefined || record.revokedAt !== null) return undefined;
    if (record.tokenCiphertext === undefined) {
      return undefined;
    }
    const token = decryptToken(record.tokenCiphertext, this.#pepper);
    if (token === undefined || hashToken(token, this.#pepper) !== record.tokenHash) return undefined;
    return token;
  }

  authenticate(token: string): CredentialRecord | undefined {
    const record = this.findByToken(token);
    if (record === undefined || record.revokedAt !== null) return undefined;
    record.lastUsedAt = new Date().toISOString();
    // WorldlineBox review: a chatty agent would otherwise rewrite the whole file
    // on every request; coalesce lastUsedAt updates into one write.
    if (this.#persistTimer === undefined) {
      this.#persistTimer = setTimeout(() => {
        this.#persistTimer = undefined;
        this.persist();
      }, 5_000);
      this.#persistTimer.unref();
    }
    return { ...record };
  }

  authenticationState(token: string): McpCredentialAuthenticationState {
    const record = this.findByToken(token);
    if (record === undefined) return 'unknown';
    return record.revokedAt === null ? 'valid' : 'revoked';
  }

  revoke(credentialId: string): boolean {
    const record = this.#records.find((candidate) => candidate.credentialId === credentialId);
    if (record === undefined || record.revokedAt !== null) return false;
    record.revokedAt = new Date().toISOString();
    this.persist();
    return true;
  }

  /** Rename a live credential's display label. */
  rename(credentialId: string, label: string): boolean {
    const record = this.#records.find((candidate) => candidate.credentialId === credentialId);
    if (record === undefined || record.revokedAt !== null) return false;
    const trimmed = label.trim();
    if (trimmed.length === 0 || trimmed.length > 255) return false;
    record.label = trimmed;
    this.persist();
    return true;
  }

  private load(): void {
    try {
      const contents = readAtomicJsonFile(this.#filePath);
      if (contents === undefined) return;
      const parsed = credentialFileSchema.safeParse(JSON.parse(contents));
      if (parsed.success) this.#records = parsed.data.credentials;
    } catch {
      this.#records = [];
    }
  }

  private findByToken(token: string): CredentialRecord | undefined {
    const candidateHash = Buffer.from(hashToken(token, this.#pepper), 'hex');
    return this.#records.find((candidate) => {
      const storedHash = Buffer.from(candidate.tokenHash, 'hex');
      return storedHash.byteLength === candidateHash.byteLength
        && timingSafeEqual(storedHash, candidateHash);
    });
  }

  private persist(): void {
    if (this.#persistTimer !== undefined) {
      clearTimeout(this.#persistTimer);
      this.#persistTimer = undefined;
    }
    writeAtomicJsonFile(
      this.#filePath,
      JSON.stringify({ version: 1, credentials: this.#records }, null, 2),
    );
  }
}
