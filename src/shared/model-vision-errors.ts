/** Classify a provider rejection without persisting or exposing its response body. */
export function unsupportedImageError(body: unknown): boolean {
  const record = body && typeof body === 'object' ? body as Record<string, unknown> : {};
  const error = record.error && typeof record.error === 'object' ? record.error as Record<string, unknown> : record;
  const code = typeof error.code === 'string' ? error.code.toLowerCase() : '';
  if (['unsupported_image', 'unsupported_image_input', 'image_not_supported', 'model_not_support_image'].includes(code)) return true;
  const message = typeof error.message === 'string' ? error.message.slice(0, 4000) : '';
  return /(?:does not|doesn't|cannot|can't|not).*support.{0,30}(?:image|vision)|(?:image|vision).{0,30}(?:not supported|unsupported|only supported by certain models)|unsupported\s+(?:image|vision)\s+(?:input|content|modality)|不支持.{0,12}(?:图片|图像|视觉)/iu.test(message);
}
