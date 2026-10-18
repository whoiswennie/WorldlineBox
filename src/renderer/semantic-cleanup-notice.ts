export function appendSemanticCleanupNotice(
  message: string,
  pending: boolean,
  cleanupNotice: string,
): string {
  return pending ? `${message}${cleanupNotice}` : message;
}
