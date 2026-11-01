import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { beginCompanionHostIncidentRepair, companionHostIncidentRepairManifestSchema, completeCompanionHostIncidentRepair,
  hostIncidentRepairFile, hostIncidentRepairSHA, planCompanionHostIncidentRepair } from '../../companions/host-incident-repair';
import { installCompanionRecoveryFileExact } from '../../companions/recovery-package';
import type { CompanionRecoverySelection } from '../../companions/recovery-fence';
import { applyCompanionHostQualitativeRepair, companionHostQualitativeRepairManifestSchema, planCompanionHostQualitativeRepair } from '../../companions/host-incident-qualitative-repair';

function directory(file: string): void {
  const stat = lstatSync(file);
  if (!stat.isDirectory() || stat.isSymbolicLink() || path.resolve(realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error('事故修复暂存或目标目录包含链接。');
}
function ownedDirectory(parent: string, name: string): string {
  directory(parent); const target = path.join(parent, name);
  try { mkdirSync(target); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  directory(target); return target;
}

/** A deliberately offline, explicit host maintenance driver. There is no IPC
 * registration. The normal application must have shut its producers down.
 * Default mode performs only readonly planning and never creates staging. */
type RepairOptions = {
  mode?: 'plan' | 'apply'; approvedManifestSHA?: string; validationBefore: Buffer; validationAfter: Buffer;
};
function validateMainReceipts(manifest: ReturnType<typeof companionHostIncidentRepairManifestSchema.parse>, options: RepairOptions): void {
  if (hostIncidentRepairSHA(options.validationBefore) !== manifest.validation.beforeRepairReceiptSHA
    || hostIncidentRepairSHA(options.validationAfter) !== manifest.validation.afterRepairReceiptSHA) throw new Error('事故修复完整 Main 核验凭据 SHA 不匹配。');
  for (const bytes of [options.validationBefore, options.validationAfter]) {
    const receipt = JSON.parse(bytes.toString('utf8')) as { schema?: string; eligibleMessageCount?: number;
      checks?: Array<{ kind: string; id: string; valid: boolean }>;
      results?: Array<{ id: string; readable: boolean; failedProofHashes: string[] }>;
      originalTombstones?: Array<{ key: string; value: string; valueSha256: string }>;
      newMarkers?: unknown[]; modelOrNetworkCalls?: number; currentAssetsFullStrictLoadAndFinal?: boolean; fullCanonicalGate?: boolean; publishedCertificateSkip?: boolean; originalLibraryWrites?: number };
    const messages = manifest.tombstones.filter(item => item.kind === 'message');
    if (receipt.schema !== 'incident-recovery-hypothesis-validation-v1' || receipt.eligibleMessageCount !== messages.length
      || receipt.results?.length !== messages.length || !messages.every(message => receipt.results?.some(result => result.id === message.id && result.readable && result.failedProofHashes.length === 0))
      || !receipt.checks?.length || receipt.checks.some(check => check.valid !== true)
      || !manifest.tombstones.every(item => receipt.checks?.some(check => check.kind === item.kind && check.id === item.id)
        && receipt.originalTombstones?.some(marker => marker.key === `execution-source-invalid/${item.kind}/${item.id}` && marker.valueSha256 === item.valueSHA && hostIncidentRepairSHA(marker.value) === item.valueSHA))
      || receipt.newMarkers?.length !== 0 || receipt.modelOrNetworkCalls !== 0 || receipt.currentAssetsFullStrictLoadAndFinal !== true || receipt.fullCanonicalGate !== true
      || receipt.publishedCertificateSkip !== false || receipt.originalLibraryWrites !== 0) throw new Error('事故修复材料不含成功的真实完整 Main 核验。');
  }
}
export function runCompanionHostIncidentRepair(selection: CompanionRecoverySelection, input: unknown, options: RepairOptions) {
  const manifest = companionHostIncidentRepairManifestSchema.parse(input), ownersRoot = path.join(selection.libraryPath, '伙伴记忆');
  validateMainReceipts(manifest, options);
  if (options.mode === 'apply') {
    // Reconcile only an explicitly approved operation, never a readonly plan.
    // A previously committed prepared/completed receipt selects its exact head.
    if (!options.approvedManifestSHA) throw new Error('事故修复需要准确批准。');
    beginCompanionHostIncidentRepair(selection, manifest, ownersRoot, options.approvedManifestSHA);
  }
  const plan = planCompanionHostIncidentRepair(selection, manifest, ownersRoot);
  const summary = { manifestSHA: plan.manifestSHA, state: plan.state, head: plan.head, notes: manifest.notes.length,
    archives: manifest.archives.length, tombstones: manifest.tombstones.length, files: plan.files.length, appliedToSelectedLibrary: false };
  if (options.mode !== 'apply') return summary;
  if (options.approvedManifestSHA !== plan.manifestSHA) throw new Error('应用事故修复必须明确批准同一份计划 SHA。');
  if (plan.state !== 'completed') {
    const dataRoot = path.join(selection.libraryPath, '.worldlinebox', 'companions');
    const stagingRoot = ownedDirectory(ownedDirectory(dataRoot, 'host-incident-repair'), manifest.operationId);
    const bodies = ownedDirectory(stagingRoot, 'verified-bodies'), installs = ownedDirectory(stagingRoot, 'atomic-install');
    for (const file of plan.files) {
      // Authorize every existing parent before allowing the atomic helper to
      // reconcile its own known two-link crash pair at the leaf.
      const target = path.join(ownersRoot, file.owner, ...file.relativePath.split('/'));
      if (existsSync(target) && lstatSync(target).nlink === 2) {
        // Only the atomic helper can validate its known crash pair. Recheck
        // all parents, but never accept this leaf as a normal source file.
        directory(ownersRoot); directory(path.join(ownersRoot, file.owner));
        const parents = file.relativePath.split('/').slice(0, -1);
        for (let index = 0; index < parents.length; ++index) directory(path.join(ownersRoot, file.owner, ...parents.slice(0, index + 1)));
      } else hostIncidentRepairFile(ownersRoot, file.owner, file.relativePath, true);
      directory(path.dirname(target));
      const source = path.join(bodies, file.sha256 + '.body');
      if (!existsSync(source)) {
        const fd = openSync(source, 'wx', 0o600);
        try { writeFileSync(fd, file.text, 'utf8'); fsyncSync(fd); } finally { closeSync(fd); }
      }
      const stat = lstatSync(source);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || hostIncidentRepairSHA(readFileSync(source)) !== file.sha256) throw new Error('事故修复暂存准确正文已变化。');
      installCompanionRecoveryFileExact(source, target, { hash: file.sha256, size: file.size }, installs);
    }
  }
  const head = completeCompanionHostIncidentRepair(selection, manifest, ownersRoot, plan.manifestSHA);
  return { ...summary, state: 'completed' as const, head, appliedToSelectedLibrary: true };
}

/** The second fixed manifest changes only ten active flags. It cannot supply
 * data, replay integration/effects or write the physical/runtime state. */
export function runCompanionHostQualitativeRepair(selection: CompanionRecoverySelection, input: unknown, parentInput: unknown, options: RepairOptions) {
  const manifest = companionHostQualitativeRepairManifestSchema.parse(input), parent = companionHostIncidentRepairManifestSchema.parse(parentInput);
  validateMainReceipts(parent, options);
  if (parent.operationId !== manifest.parentRepair.operationId || parent.libraryId !== manifest.libraryId
    || hostIncidentRepairSHA(JSON.stringify(parent)) !== manifest.parentRepair.manifestSHA) throw new Error('定性修复的原始正文 manifest 不匹配。');
  const ownersRoot = path.join(selection.libraryPath, '伙伴记忆');
  const result = options.mode === 'apply' ? applyCompanionHostQualitativeRepair(selection, manifest, ownersRoot, options.approvedManifestSHA ?? '')
    : planCompanionHostQualitativeRepair(selection, manifest, ownersRoot);
  return { ...result, appliedToSelectedLibrary: options.mode === 'apply', runtimeEffectsReplayed: false };
}
