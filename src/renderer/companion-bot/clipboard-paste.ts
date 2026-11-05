interface ClipboardContents {
  files: Pick<FileList,'length'>;
  items: ArrayLike<Pick<DataTransferItem,'kind'>>;
  types: ArrayLike<string>;
  getData(type:string):string;
}

/** Native file formats can survive without browser File items on Explorer/Finder. */
export function isBotFilePaste(data: ClipboardContents, hasNativeFiles: () => boolean = () => false): boolean {
  if (data.files.length || Array.from(data.items ?? []).some(item => item.kind === 'file')) return true;
  const types = Array.from(data.types, type => type.toLowerCase());
  if (types.some(type => type === 'files' || type.startsWith('image/') || /(?:cf_hdrop|filenamew|public\.file-url|nsfilenamespboardtype)/u.test(type))) return true;
  // This probe reads only native file-list metadata. Ordinary text remains in
  // the textarea's normal paste/undo path, even when it looks like a file path.
  try { if (hasNativeFiles()) return true; } catch { /* Unavailable native metadata must not block text paste. */ }
  const uri = data.getData('text/uri-list').split(/\r?\n/u).filter(line => line.trim() && !line.startsWith('#'));
  if (uri.length && uri.every(line => line.startsWith('file://'))) return true;
  // Some native file/image pastes expose no browser formats at all. There is
  // no text to suppress in that case; Main resolves the actual clipboard.
  return !data.getData('text/plain') && !data.getData('text/html') && !data.getData('text/uri-list');
}
