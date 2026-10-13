import { memo, useMemo, useState } from 'react';
import highlight from 'highlight.js/lib/common';

export const MessageCodeBlock = memo(function MessageCodeBlock({ code, language = 'text' }: { code: string; language?: string }) {
  const [copied, setCopied] = useState(false);
  const html = useMemo(() => highlight.getLanguage(language) && code.length <= 65536 ? highlight.highlight(code, { language, ignoreIllegals: true }).value : undefined, [code, language]);
  return <figure className="companions-code-block"><figcaption><span>{language}</span><button type="button" aria-label="复制代码" onClick={() => {
    void navigator.clipboard.writeText(code).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => setCopied(false));
  }}>{copied ? '已复制' : '复制'}</button></figcaption><pre>{html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : <code>{code}</code>}</pre></figure>;
});
