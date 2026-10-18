import {
  browserCaptureContentRequestSchema,
  type BrowserCaptureContentRequest,
} from '../src/shared/browser-capture';

type RuntimeListener = Parameters<WorldlineBoxChromeApi['runtime']['onMessage']['addListener']>[0];
type StorageListener = Parameters<WorldlineBoxChromeApi['storage']['onChanged']['addListener']>[0];
type ContentChrome = {
  runtime: Pick<WorldlineBoxChromeApi['runtime'], 'lastError' | 'onMessage' | 'sendMessage'>;
  storage: WorldlineBoxChromeApi['storage'];
};

export interface BuiltinContentTransport {
  request(request: BrowserCaptureContentRequest): Promise<unknown>;
  subscribe(listener: (event: unknown) => void): () => void;
}

const STORAGE_KEYS = [
  'worldlineboxNotificationsEnabled',
  'worldlineboxFocusAppAfterSave',
  'worldlineboxRevealInLibraryAfterSave',
  'worldlineboxDragRadialMenuEnabled',
  'recentFolderIds',
] as const;
const storageKeys = new Set<string>(STORAGE_KEYS);

export function supportsBuiltinContentUrl(url: string): boolean {
  // Native browser tabs accept web URLs only. Blank/srcdoc/data/error documents
  // and file previews must not initialize the privileged capture transport.
  // The standalone Chrome extension retains its separate opt-in file access.
  try { return ['http:', 'https:'].includes(new URL(url).protocol); }
  catch { return false; }
}

/** Only the APIs used by the real content script, installed in its isolated world. */
export function createBuiltinContentChrome(transport: BuiltinContentTransport, documentUrl: string): {
  chrome: ContentChrome;
  dispose(): void;
} {
  const runtimeListeners = new Set<RuntimeListener>();
  const storageListeners = new Set<StorageListener>();
  const enabled = supportsBuiltinContentUrl(documentUrl);
  let disposed = false;
  const runtime: ContentChrome['runtime'] = {
    onMessage: { addListener(listener) { runtimeListeners.add(listener); } },
    sendMessage(message, callback) {
      deliver({ type: 'runtime.message', message }, callback);
    },
  };

  function complete(callback: ((value: unknown) => void) | undefined, value: unknown, error?: unknown): void {
    if (!callback || disposed) return;
    const previous = runtime.lastError;
    if (error !== undefined) runtime.lastError = { message: error instanceof Error ? error.message : String(error) };
    else delete runtime.lastError;
    try { callback(value); }
    finally {
      if (previous) runtime.lastError = previous;
      else delete runtime.lastError;
    }
  }

  function deliver(request: unknown, callback?: (value: unknown) => void, fallback?: unknown): void {
    void Promise.resolve().then(() => {
      if (disposed || !enabled) throw new Error('Browser capture is unavailable for this document.');
      const parsed = browserCaptureContentRequestSchema.safeParse(request);
      if (!parsed.success) throw new Error('Unsupported browser capture request.');
      return transport.request(parsed.data);
    }).then(
      value => complete(callback, value),
      error => complete(callback, fallback, error),
    );
  }

  function area(name: 'local' | 'sync'): WorldlineBoxChromeApi['storage']['sync'] {
    return {
      get(keys, callback) {
        deliver({ type: 'storage.get', area: name, keys: keys === null ? [...STORAGE_KEYS] : Array.isArray(keys) ? keys : [keys] },
          value => callback(value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}), {});
      },
      set(values, callback) { deliver({ type: 'storage.set', area: name, values }, callback); },
    };
  }

  const unsubscribe = transport.subscribe(event => {
    if (disposed || !enabled || !event || typeof event !== 'object') return;
    const type = Reflect.get(event, 'type');
    if (type === 'runtime.message') {
      const message: unknown = Reflect.get(event, 'message');
      if (!message || typeof message !== 'object'
        || !['worldlinebox-save-feedback', 'worldlinebox-local-context-save-request'].includes(Reflect.get(message, 'type'))) return;
      for (const listener of runtimeListeners) listener(message, {}, () => undefined);
    } else if (type === 'storage.changed') {
      const areaName: unknown = Reflect.get(event, 'area');
      const source: unknown = Reflect.get(event, 'changes');
      if ((areaName !== 'sync' && areaName !== 'local') || !source || typeof source !== 'object' || Array.isArray(source)) return;
      const changes: Record<string, { newValue?: unknown; oldValue?: unknown }> = {};
      for (const [key, change] of Object.entries(source)) {
        if (!storageKeys.has(key) || !change || typeof change !== 'object') continue;
        changes[key] = {
          ...(Object.hasOwn(change, 'oldValue') ? { oldValue: Reflect.get(change, 'oldValue') } : {}),
          ...(Object.hasOwn(change, 'newValue') ? { newValue: Reflect.get(change, 'newValue') } : {}),
        };
      }
      if (Object.keys(changes).length) for (const listener of storageListeners) listener(changes, areaName);
    }
  });

  return {
    chrome: { runtime, storage: { local: area('local'), sync: area('sync'), onChanged: { addListener(listener) { storageListeners.add(listener); } } } },
    dispose() { disposed = true; unsubscribe(); runtimeListeners.clear(); storageListeners.clear(); },
  };
}
