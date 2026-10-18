import { useState } from 'react';
import { createPortal } from 'react-dom';

import type { DshInstance, DshLauncherRequest, DshPack, DshRuntime, DshSnapshot } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { Button, DialogShell, Select, TextField } from '../ui';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';
import type { LauncherRunRequest } from './DshLauncher';

export type LauncherDialogState =
  | { kind: 'cleanup-runtimes' }
  | { kind: 'create'; name: string; runtimeId: string }
  | { kind: 'rename'; instance: DshInstance }
  | { kind: 'clone' | 'upgrade'; instance: DshInstance; name: string; runtimeId: string }
  | { kind: 'snapshot'; instance: DshInstance; name: string }
  | { kind: 'restore'; snapshot: DshSnapshot; name: string }
  | { kind: 'import'; name: string }
  | { kind: 'export' | 'delete-instance'; instance: DshInstance }
  | { kind: 'delete-runtime'; runtime: DshRuntime }
  | { kind: 'delete-snapshot'; snapshot: DshSnapshot }
  | { kind: 'pack-create'; instance: DshInstance; name: string }
  | { kind: 'pack-install'; pack: DshPack; name: string }
  | { kind: 'delete-pack'; pack: DshPack };

export function LauncherDialog({ dialog, runtimes, busy, onClose, onSubmit }: {
  readonly dialog: LauncherDialogState;
  readonly runtimes: readonly DshRuntime[];
  readonly busy: boolean;
  readonly onClose: () => void;
  readonly onSubmit: LauncherRunRequest;
}) {
  const t = useT();
  const [name, setName] = useState('name' in dialog ? dialog.name : dialog.kind === 'rename' ? dialog.instance.name : '');
  const [runtimeId, setRuntimeId] = useState('runtimeId' in dialog ? dialog.runtimeId : runtimes[0]?.id ?? '');
  const [error, setError] = useState<string | null>(null);
  const [version, setVersion] = useState('1.0.0');
  useDialogFocusTrap(true);
  const naming = ['create', 'rename', 'clone', 'upgrade', 'snapshot', 'restore', 'import', 'pack-create', 'pack-install'].includes(dialog.kind);
  const runtimeSelection = dialog.kind === 'create' || dialog.kind === 'upgrade';
  const destructive = dialog.kind.startsWith('delete-') || dialog.kind === 'cleanup-runtimes';
  const title = (() => {
    switch (dialog.kind) {
      case 'cleanup-runtimes': return t('launcher.runtimeCleanup');
      case 'create': return t('launcher.create');
      case 'rename': return t('launcher.rename');
      case 'clone': return t('launcher.clone');
      case 'upgrade': return t('launcher.upgrade');
      case 'snapshot': return t('launcher.snapshotCreate');
      case 'restore': return t('launcher.snapshotRestore');
      case 'import': return t('launcher.importBackup');
      case 'export': return t('launcher.exportTitle');
      case 'delete-instance': return t('launcher.deleteInstanceTitle', { name: dialog.instance.name });
      case 'delete-runtime': return t('launcher.deleteRuntimeTitle', { version: dialog.runtime.version });
      case 'delete-snapshot': return t('launcher.deleteSnapshotTitle', { name: dialog.snapshot.name });
      case 'pack-create': return t('launcher.packCreate');
      case 'pack-install': return t('launcher.packInstall');
      case 'delete-pack': return t('launcher.packDeleteTitle', { name: dialog.pack.name });
    }
  })();
  const description = (() => {
    switch (dialog.kind) {
      case 'cleanup-runtimes': return t('launcher.runtimeCleanupDescription');
      case 'create': return t('launcher.createDescription');
      case 'clone': return t('launcher.cloneDescription');
      case 'upgrade': return t('launcher.upgradeDescription');
      case 'snapshot': return t('launcher.snapshotNote');
      case 'restore': return t('launcher.restoreDescription');
      case 'import': return t('launcher.importDescription');
      case 'export': return t('launcher.exportDescription');
      case 'delete-instance': return t('launcher.deleteInstanceDescription');
      case 'delete-runtime': return t('launcher.deleteRuntimeDescription');
      case 'delete-snapshot': return t('launcher.deleteSnapshotDescription');
      case 'pack-create': return t('launcher.packCreateDescription');
      case 'pack-install': return t('launcher.packInstallDescription');
      case 'delete-pack': return t('launcher.packDeleteDescription');
      case 'rename': return undefined;
    }
  })();
  const submit = async () => {
    let request: DshLauncherRequest;
    const cleanName = name.trim();
    switch (dialog.kind) {
      case 'cleanup-runtimes': request = { type: 'runtime.cleanup' }; break;
      case 'create': request = { type: 'instance.create', name: cleanName, runtimeId }; break;
      case 'rename': request = { type: 'instance.rename', instanceId: dialog.instance.id, name: cleanName }; break;
      case 'clone': request = { type: 'instance.clone', instanceId: dialog.instance.id, name: cleanName }; break;
      case 'upgrade': request = { type: 'instance.clone', instanceId: dialog.instance.id, name: cleanName, runtimeId }; break;
      case 'snapshot': request = { type: 'snapshot.create', instanceId: dialog.instance.id, name: cleanName }; break;
      case 'restore': request = { type: 'snapshot.restore', snapshotId: dialog.snapshot.id, name: cleanName }; break;
      case 'import': request = { type: 'backup.import', name: cleanName }; break;
      case 'export': request = { type: 'backup.export', instanceId: dialog.instance.id }; break;
      case 'delete-instance': request = { type: 'instance.delete', instanceId: dialog.instance.id }; break;
      case 'delete-runtime': request = { type: 'runtime.delete', runtimeId: dialog.runtime.id }; break;
      case 'delete-snapshot': request = { type: 'snapshot.delete', snapshotId: dialog.snapshot.id }; break;
      case 'pack-create': request = { type: 'pack.create', instanceId: dialog.instance.id, name: cleanName, version: version.trim() }; break;
      case 'pack-install': request = { type: 'pack.install', packId: dialog.pack.id, name: cleanName }; break;
      case 'delete-pack': request = { type: 'pack.delete', packId: dialog.pack.id }; break;
    }
    const result = await onSubmit(request);
    if (result.ok) onClose();
    else setError(result.error);
  };
  return createPortal(<div className="launcher-dialog-backdrop">
    <DialogShell className="launcher-dialog" description={description} dialogId="dsh-launcher-dialog" footer={<><Button disabled={busy} onClick={onClose}>{t('launcher.cancel')}</Button><Button data-dialog-default-action="true" disabled={busy || (naming && !name.trim()) || (runtimeSelection && !runtimeId) || (dialog.kind === 'pack-create' && !version.trim())} loading={busy} onClick={() => void submit()} variant={destructive ? 'danger' : 'primary'}>{t(dialog.kind === 'export' ? 'launcher.exportConfirm' : destructive ? 'launcher.confirm' : 'launcher.save')}</Button></>} onRequestClose={() => { if (!busy) onClose(); }} title={title}>
      {naming ? <TextField autoFocus data-dialog-initial-focus="true" label={t(dialog.kind === 'snapshot' ? 'launcher.snapshotName' : dialog.kind === 'pack-create' ? 'launcher.packName' : 'launcher.name')} maxLength={100} onChange={(event) => setName(event.target.value)} placeholder={t('launcher.namePlaceholder')} required value={name} /> : null}
      {dialog.kind === 'pack-create' ? <TextField label={t('launcher.packVersion')} maxLength={100} onChange={(event) => setVersion(event.target.value)} required value={version} /> : null}
      {runtimeSelection ? <Select label={t('launcher.chooseRuntime')} onValueChange={setRuntimeId} options={runtimes.map((runtime) => ({ value: runtime.id, label: `DSH ${runtime.version} · Node ${runtime.nodeVersion} · ${runtime.contentSha256.slice(0, 12)}` }))} required value={runtimeId} /> : null}
      {dialog.kind === 'create' ? <p className="launcher-help">{t('launcher.sharedDataScopeNote')}</p> : null}
      {error ? <p className="launcher-dialog-error" role="alert">{error}</p> : null}
    </DialogShell>
  </div>, document.body);
}
