import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';

export interface CognitionFixtureFinalization {
  root: string;
  receiptFile: string;
  verifiedSuccess: boolean;
  primaryFailure?: unknown;
  knownExit?: { code?: number | null; signal?: string | null; childPid?: number };
  preserveLedger(): Promise<void>;
  cleanup(root: string): Promise<void>;
}
export interface CognitionFixtureFinalizationResult {
  retained: boolean;
  reason: 'unverified_or_failed' | 'ledger_preservation_failed' | 'cleanup_failed' | 'verified_success';
  root: string;
  receiptFile?: string;
  receiptError?: string;
}
const describe = (error: unknown) => error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : error === undefined ? undefined : { message: String(error) };

/** QA ownership boundary only. A failed run's canonical SQLite/WAL, raw
 * ledger and frozen bytes remain in place; a finally error cannot erase them
 * or replace the original business/gate exception. No process is stopped. */
export async function finalizeCognitionFixture(input: CognitionFixtureFinalization): Promise<CognitionFixtureFinalizationResult> {
  const root = path.resolve(input.root), receiptFile = path.resolve(input.receiptFile);
  const relative = path.relative(root, receiptFile);
  if (!path.isAbsolute(input.root) || !path.isAbsolute(input.receiptFile) || !relative || !relative.startsWith('..') && !path.isAbsolute(relative))
    throw new Error('A fixture retention pointer must be absolute and outside its cleanup root.');
  let preservationError: unknown;
  try { await input.preserveLedger(); } catch (error) { preservationError = error; }
  let cleanupError: unknown;
  if (input.verifiedSuccess && !preservationError) {
    try { await input.cleanup(root); return { retained: false, reason: 'verified_success', root }; }
    catch (error) { cleanupError = error; }
  }
  const reason = cleanupError ? 'cleanup_failed' : preservationError ? 'ledger_preservation_failed' : 'unverified_or_failed';
  const result: CognitionFixtureFinalizationResult = { retained: true, reason, root, receiptFile };
  const receipt = { schema: 'worldlinebox.cognition-retained-fixture-v1', retainedAt: new Date().toISOString(), root,
    verifiedSuccess: input.verifiedSuccess, reason, knownExit: input.knownExit,
    primaryFailure: describe(input.primaryFailure), ledgerPreservationError: describe(preservationError), cleanupError: describe(cleanupError),
    cleanupSkipped: !cleanupError, noProcessKill: true, noAutomaticRetry: true,
    note: cleanupError ? 'Verified run reached cleanup, which failed; only the remaining directory is retained. This is a QA cleanup error.'
      : 'The failed/unverified fixture root was not passed to cleanup. Preserve raw SQLite/WAL and audit these originals before any manual removal.' };
  let handle;
  try {
    await mkdir(path.dirname(receiptFile), { recursive: true });
    handle = await open(receiptFile, 'wx'); await handle.writeFile(JSON.stringify(receipt, null, 2)); await handle.sync();
  } catch (error) { result.receiptError = error instanceof Error ? error.message : String(error); }
  finally { await handle?.close().catch(() => undefined); }
  // The catch/throw already in flight remains authoritative. Successful
  // business verification must not hide a separate QA preservation failure.
  if (input.verifiedSuccess) throw cleanupError ?? preservationError ?? new Error('Verified fixture finalization did not complete.');
  return result;
}
