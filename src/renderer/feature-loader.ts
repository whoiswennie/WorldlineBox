/** Share the import started by navigation intent with React.lazy. Loading code
 * never mounts the view, opens a library or starts its background effects. */
export function featureLoader<T>(load: () => Promise<T>) {
  let pending: Promise<T> | undefined;
  const read = () => pending ??= load().catch(error => { pending = undefined; throw error; });
  return { load: read, preload: () => { void read().catch(() => undefined); } };
}
