type Clause = { start: number; end: number; punctuation: string };
const pairs: Readonly<Record<string, string>> = { '“': '”', '‘': '’', '「': '」', '『': '』', '《': '》',
  '（': '）', '(': ')', '[': ']', '【': '】', '{': '}' };
const closing = new Set(Object.values(pairs));
const separators = new Set([',', '，', ';', '；', '.', '。', '!', '！', '?', '？', '\n', '\r']);
const sentenceEnd = /[.。!！?？]/u;
const future = '(?:等(?:一)?会儿?|待会儿?|一会儿?|稍后|过一会儿?|晚点|之后|接下来|明天|今晚|下次)';
const quoted = new Set([...Object.keys(pairs), ...Object.values(pairs), '"', "'", '`']);
const hasQuoteOrBracket = (value: string) => [...value].some(character => quoted.has(character));
const extraClaim = /(?:已经|已然|刚刚|刚才|成功|收到|答应|同意|愿意|报名|保证|肯定|必定|一定|文件|附件|附上|播放|听懂|理解|发送|发出|了|过)/u;
const reporting = /(?:说|问|表示|写|转述|转达|告诉|转告|回复|留言|原话|原文|引用|转发|提到|声称|宣称|表述|(?:意思|原意|计划|安排|承诺|口信)(?:是|为)?\s*$|[:：]\s*$)/u;
const escape = (text: string) => [...text].map(character => '\\^$.*+?()[]{}|'.includes(character) ? '\\' + character : character).join('');

/** Only complete, unquoted self-intent clauses enter this small grammar.
 * Unknown syntax remains reviewable; this is not a general semantic classifier. */
function selfContactIntent(text: string, names: readonly string[]): boolean {
  const value = text.trim();
  const semanticBody = value.replace(new RegExp(`^(?:${future})`, 'u'), '').replace(new RegExp(`^我(?:${future})`, 'u'), '我');
  if (!value || value.length > 160 || hasQuoteOrBracket(value) || extraClaim.test(semanticBody)) return false;
  const targets = ['她们', '他们', '你们', '对方', '她', '他', '你', ...names.filter(name => name.length > 0 && name.length <= 40 && !separators.has(name)
    && !hasQuoteOrBracket(name) && !/[,，;；.。!！?？\n\r]/u.test(name))];
  const target = '(?:' + [...new Set(targets)].sort((a, b) => b.length - a.length).map(escape).join('|') + ')';
  const contact = `(?:(?:跟|和|向|给|找)${target}(?:说一声|说一下|说几句|聊聊|聊天|沟通|问问|问一下|打个招呼|打声招呼|确认一下)|(?:联系|问问|询问|回复|答复|告诉|通知|找)${target}(?:一下|一声|聊聊|说一声)?)`;
  const action = '(?:先|再|去){0,2}' + contact + '(?:吧|呢|呀|啊|哦|噢)?[~～]?';
  // An explicit future time may precede or follow "我". Without one, only
  // explicit intent/modal syntax is supported; third-party promises never fit.
  return new RegExp(`^(?:(?:${future})我(?:也|还)?(?:(?:想|打算|准备|计划|会|要|得))?|我(?:${future})(?:也|还)?(?:(?:想|打算|准备|计划|会|要|得))?|我(?:也|还)?(?:想|打算|准备|计划|会|要|得))${action}$`, 'u').test(value);
}

/** Remove only narrowly proven future self-intents before the social-effect
 * reviewer sees them. Every other original clause remains in the payload,
 * including completed effects elsewhere in the same sentence or draft. */
export function companionSocialReviewableText(text: string, names: readonly string[] = []): string {
  const clauses: Clause[] = [], stack: Array<{ close: string; literal: boolean; ticks?: number }> = [];
  let start = 0;
  for (let index = 0; index < text.length; ++index) {
    const current = text[index]!, top = stack.at(-1);
    if (top?.literal && current === '\\') { ++index; continue; }
    if (current === '`' && (!top || top.ticks)) {
      let count = 1; while (text[index + count] === '`') ++count;
      if (top?.ticks === count) stack.pop(); else if (!top) stack.push({ close: '`', literal: true, ticks: count });
      index += count - 1; continue;
    }
    if (top?.ticks) continue;
    if (top?.literal) { if (current === top.close) stack.pop(); continue; }
    if (current === '"' || current === "'") { stack.push({ close: current, literal: true }); continue; }
    if (pairs[current]) { stack.push({ close: pairs[current]!, literal: false }); continue; }
    if (closing.has(current)) { if (top?.close !== current) return text; stack.pop(); continue; }
    if (!stack.length && separators.has(current)) { clauses.push({ start, end: index, punctuation: current }); start = index + 1; }
  }
  if (stack.length) return text;
  clauses.push({ start, end: text.length, punctuation: '' });
  let reportedSpeech = false, changed = false;
  const remaining: string[] = [];
  for (const clause of clauses) {
    const original = text.slice(clause.start, clause.end);
    if (!reportedSpeech && selfContactIntent(original, names)) changed = true;
    else { remaining.push(original, clause.punctuation); if (reporting.test(original)) reportedSpeech = true; }
    if (sentenceEnd.test(clause.punctuation)) reportedSpeech = false;
  }
  return changed ? remaining.join('') : text;
}
