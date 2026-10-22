import { useEffect, useState } from 'react';
import type { CompanionWorkspaceLibrary } from '../../shared/companion-workspace';
import { Icon } from '../Icons';
import { DialogShell } from '../ui/patterns';
import { useDialogFocusTrap } from '../use-dialog-focus-trap';

export function CompanionLibraryDialog({ libraries, selectedId, busy, error, createdName, onCreate, onChoose, onClose }: {
  libraries: CompanionWorkspaceLibrary[];
  selectedId?: string;
  busy: boolean;
  error: string;
  createdName?: string;
  onCreate(name: string): void;
  onChoose(libraryId?: string): void;
  onClose(): void;
}) {
  const [name, setName] = useState(createdName ?? '伙伴资产库');
  const [existing, setExisting] = useState(false);
  const title = existing ? '使用已有资产库' : '创建伙伴资产库';
  useDialogFocusTrap(true, title + ':' + busy);
  useEffect(() => {
    if (busy) document.getElementById('companion-library-dialog')?.focus();
  }, [busy]);

  return <div className="dialog-backdrop companion-library-backdrop" role="presentation">
    <DialogShell className="create-dialog companion-library-dialog" dialogId="companion-library-dialog" aria-busy={busy} tabIndex={-1}
      title={title} description={existing ? '选择一个资产库，保存所有伙伴的记忆与生活记录。' : '给伙伴的日记、资料和共同经历，一个长久保存的地方。'}
      onRequestClose={() => { if (!busy) onClose(); }}
      headerActions={<button className="dialog-close" type="button" disabled={busy} aria-label="关闭伙伴资产库设置" onClick={onClose}><Icon name="close" size={16} /></button>}>
      <div className="companion-library-content">
        {existing ? <>
          <div className="companion-library-list" aria-label="可用的已有资产库">
            {libraries.map(library => <button className="companion-library-option" type="button" key={library.libraryId} disabled={busy}
              onClick={() => onChoose(library.libraryId)} aria-label={'使用资产库 ' + library.displayName}>
              <span className="companion-library-folder"><Icon name="folder" size={19} /></span>
              <span className="companion-library-option-text"><strong>{library.displayName}</strong><small title={library.libraryPath}>{library.libraryPath}</small></span>
              {library.libraryId === selectedId ? <span className="companion-library-current">当前</span> : <Icon name="chevron-right" size={15} />}
            </button>)}
          </div>
          <button className="secondary-button companion-library-open" type="button" disabled={busy} onClick={() => onChoose()}><Icon name="folder" size={16} />打开其他资产库…</button>
          <p className="companion-library-help">请选择已经创建的 WorldlineBox 资产库文件夹。</p>
        </> : <form onSubmit={event => { event.preventDefault(); if (name.trim() && !busy) onCreate(name.trim()); }}>
          <div className="companion-library-summary" aria-hidden="true"><span><Icon name="users" size={23} /></span><div><strong>一个资产库，陪伴每一位伙伴</strong><p>各自的记忆，整理在各自的文件夹里</p></div></div>
          <label className="field-label" htmlFor="companion-library-name">资产库名称</label>
          <input className="text-field" id="companion-library-name" data-dialog-initial-focus="true" maxLength={255} value={name} disabled={busy || !!createdName} onChange={event => setName(event.target.value)} />
          <p className="companion-library-help" id="companion-library-location-help">下一步选择保存位置，日记、聊天与生活记录都会保存在那里。</p>
          {createdName && <p className="companion-library-help" role="status">“{createdName}”已创建，重试即可进入伙伴。</p>}
          <button className="primary-button companion-library-create" type="submit" disabled={busy || !name.trim()} aria-describedby="companion-library-location-help">
            {!busy && <Icon name={createdName ? 'chevron-right' : 'plus'} size={16} />}{busy ? '正在打开伙伴资产库…' : createdName ? '重试进入伙伴' : '选择位置并创建'}
          </button>
        </form>}
        {error && <p className="companion-library-error" role="alert">{error}</p>}
        <div className="companion-library-alternative"><button type="button" disabled={busy} onClick={() => setExisting(!existing)}>
          {existing ? <><Icon name="plus" size={14} />创建新的伙伴资产库</> : <>已有资产库？<span>使用已有资产库<Icon name="chevron-right" size={14} /></span></>}
        </button></div>
      </div>
    </DialogShell>
  </div>;
}
