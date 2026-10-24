const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** Explicit input/context rejections only. Never infer a model window from its
 * name, HTTP status, output truncation or an account quota. */
export function companionProviderContextCapacity(body: unknown): boolean {
  const root = record(body), error = record(root.error);
  const codes = [root.code, error.code, error.type].filter(value => typeof value === 'string');
  if (codes.some(code => /^(?:context_length_exceeded|context_window_exceeded|prompt_too_long|input_too_long)$/iu.test(String(code)))) return true;
  const messages = [root.message, error.message].filter(value => typeof value === 'string').join('\n');
  return /(?:maximum context (?:length|window)|context (?:length|window) (?:has been )?exceeded|prompt is too long|input token count[\s\S]{0,160}exceeds[\s\S]{0,120}maximum|input[\s\S]{0,60}(?:exceeds|exceed)[\s\S]{0,80}(?:context|token) limit)/iu.test(messages);
}
