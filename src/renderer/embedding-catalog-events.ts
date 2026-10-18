const catalogListeners = new Set<() => void>();
const installListeners = new Set<(active: boolean) => void>();

export function notifyEmbeddingCatalogChanged(): void {
  for (const listener of catalogListeners) listener();
}

export function subscribeEmbeddingCatalog(listener: () => void): () => void {
  catalogListeners.add(listener);
  return () => catalogListeners.delete(listener);
}

export function setEmbeddingInstallActive(active: boolean): void {
  for (const listener of installListeners) listener(active);
}

export function subscribeEmbeddingInstallActivity(listener: (active: boolean) => void): () => void {
  installListeners.add(listener);
  return () => installListeners.delete(listener);
}
