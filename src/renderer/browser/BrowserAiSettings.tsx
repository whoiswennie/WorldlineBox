import { useState } from 'react';
import type { BrowserAiConfig } from '../../shared/browser-ai';
import type { BrowserRequest, BrowserResponse } from '../../shared/browser';
import { Button, TextField } from '../ui';
import { useLocale } from '../i18n';
import { Icon } from '../Icons';

export function BrowserAiSettings({ config, run }: { config?: BrowserAiConfig; run(request: BrowserRequest): Promise<BrowserResponse | undefined> }) {
  const zh = useLocale().locale === 'zh-CN'; const [key, setKey] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const save = async (remove = false) => {
    setBusy(true); setNotice(''); try {
      const result = await run({ type: 'ai.key.save', key: remove ? '' : key.trim() });
      if (result?.ok) { setKey(''); setNotice(zh ? '密钥设置已保存。' : 'Key settings saved.'); }
    } finally { setBusy(false); }
  };
  return <section className="browser-ai-settings"><header><span><Icon name="sparkles" size={17} />{zh ? 'AI 搜索与浏览助手' : 'AI search & browser assistant'}</span>
    <small>{config?.hasSearchKey ? zh ? '搜索已就绪' : 'Search ready' : zh ? '待配置' : 'Setup needed'}</small></header>
    <p>{zh ? '搜索与抓取使用 DeepSeek；会话、工具规划和分析使用全局模型。两套配置独立。' : 'DeepSeek powers search/fetch. The global model powers chat, tool planning and analysis. Configure them independently.'}</p>
    <div className="browser-ai-provider"><span>DeepSeek Search / Fetch</span><strong>{config?.keySource === 'browser' ? zh ? '浏览器专用密钥' : 'Browser key' : config?.keySource === 'global' ? zh ? '使用全局 DeepSeek 密钥' : 'Global DeepSeek key' : zh ? '未配置密钥' : 'No key'}</strong></div>
    <TextField label={zh ? '浏览器专用 DeepSeek API Key' : 'Browser DeepSeek API key'} type="password" autoComplete="off" spellCheck={false} value={key} maxLength={8192}
      onChange={event => setKey(event.target.value)} placeholder={config?.keySource === 'browser' ? zh ? '已加密保存，输入可替换' : 'Encrypted key saved; type to replace' : 'sk-…'} />
    <div className="browser-actions"><Button size="sm" disabled={busy || !key.trim()} onClick={() => void save()}>{zh ? '保存密钥' : 'Save key'}</Button>
      <Button size="sm" variant="quiet" disabled={busy || !config?.hasSearchKey || !!key} onClick={() => { setBusy(true); setNotice(''); void run({ type: 'ai.key.test' }).then(result => { if (result?.ok) setNotice(zh ? '搜索接口连接正常。' : 'Search API connection verified.'); }).finally(() => setBusy(false)); }}>{zh ? '测试连接' : 'Test connection'}</Button>
      {config?.keySource === 'browser' ? <Button size="sm" variant="quiet" disabled={busy} onClick={() => void save(true)}>{zh ? '移除专用密钥' : 'Remove key'}</Button> : null}</div>
    <p className="browser-ai-setting-note">{zh ? '密钥使用系统加密存储，不会写入浏览历史或发给网页。搜索词和抓取 URL 会发送给 DeepSeek；主动阅读的网页内容会发送给全局模型。' : 'Keys use OS encryption. Search queries/URLs go to DeepSeek; page content you ask to analyze goes to the global model.'}</p>
    <div className="browser-ai-provider"><span>{zh ? '会话与分析模型' : 'Chat & analysis model'}</span><strong>{config?.hasModel ? config.model : zh ? '请在全局模型设置中配置' : 'Configure the global model'}</strong></div>
    <label className="browser-ai-context-setting">{zh ? '会话上下文预算' : 'Conversation context budget'}<select value={config?.contextTokens ?? 16000} onChange={event => void run({ type: 'ai.preferences', contextTokens: Number(event.target.value) })}>
      {[8192, 12000, 16000, 24000, 32768].map(value => <option key={value} value={value}>{value.toLocaleString()} tokens</option>)}</select></label>
    <p className="browser-ai-setting-note">{zh ? '包含工具说明、网页资料和对话。超出预算会压缩早期记录，并保留工具调用配对；请根据模型实际容量选择。' : 'Includes tools, page evidence and chat. Older turns are compacted in complete tool/result groups. Choose a budget supported by your model.'}</p>
    {notice ? <p role="status">{notice}</p> : null}{config?.error ? <p role="alert">{config.error}</p> : null}
  </section>;
}
