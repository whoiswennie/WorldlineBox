import { isDeepseekOfficialEndpoint } from './llm';
/** A wire format alone does not prove that a custom model supports pixels. */
export function modelVisionCapability(config: { model: string; baseUrl?: string }): 'supported' | 'unsupported' | 'unknown' {
  const name = config.model.trim().toLowerCase();
  if (isDeepseekOfficialEndpoint(config.baseUrl ?? '')) return name === 'deepseek-flash' ? 'supported' : name === 'deepseek-v4-pro' ? 'unsupported' : 'unknown';
  if (name === 'deepseek-flash') return 'supported';
  if (name === 'deepseek-v4-pro') return 'unsupported';
  if (/^gemini-/u.test(name) || /^claude-(?:[3-9](?:[.-]|$)|(?:opus|sonnet|haiku|fable)-[4-9](?:[.-]|$))/u.test(name) || /^qwen[^/]*(?:vl|omni)/u.test(name) || /^qvq(?:-|$)/u.test(name)
    || /^gpt-(?:4o(?:-|$)|4\.1(?:-|$)|4\.5(?:-|$)|5(?:[.-]|$)|6(?:[.-]|$))/u.test(name)
    || /^(?:o1(?:-(?!mini|preview)|$)|o3(?:-(?!mini)|$)|o4-mini(?:-|$))/u.test(name)) return 'supported';
  return 'unknown';
}
/** Narrow provider rejection classifier; never interpret ordinary bad JSON as missing vision. */
export function isUnsupportedVisionResponse(value: string): boolean {
  return /unsupported_image(?:_input)?|image_not_supported|model_not_support_image|(?:does not|doesn't|cannot|can't|not).*support.{0,30}(?:image|vision)|(?:image|vision).{0,30}(?:not supported|unsupported|only supported by certain models)|unsupported\s+(?:image|vision)\s+(?:input|content|modality)|不支持.{0,12}(?:图片|图像|视觉)/iu.test(value.slice(0, 8192));
}
