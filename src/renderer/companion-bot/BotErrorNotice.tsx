import { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { redactCompanionDiagnostic as safeDetail } from '../../shared/companion-diagnostic';
import './bot-error-notice.css';

export const BotDiagnostics = createContext<{
  api?: WorldlineBoxDshLauncherApi;
  state?: DshLauncherState;
  openModelSettings?(): void;
  revealAppLog?(): Promise<{ ok: boolean }>;
}>({});

function diagnose(text: string, zh: boolean) {
  if (/insufficient[_ ]quota|insufficient[_ ](?:balance|credit)|exceeded your current quota|billing_hard_limit|余额不足|额度(?:不足|耗尽)|欠费|\b402\b/i.test(text))
    return { hint: zh ? '服务商的可用额度不足。请检查账户余额或切换模型服务。' : 'Check your provider balance or switch model providers.', settings: true };
  if (/context_length_exceeded|maximum context length|context window.*exceed|too many (?:input )?tokens|上下文.{0,10}(?:超限|过长|超出)/i.test(text))
    return { hint: zh ? '这次输入超过了模型的上下文长度。可以压缩当前话题，或分开发送附件。' : 'The input exceeds the model context window. Compact the topic or split the attachments.' };
  if (/invalid[_ ]api[_ ]key|unauthorized|\b401\b|(?:missing|no|invalid|expired)[ _-]+(?:api[ _-]?key|access[ _-]?token|token)|(?:api[ _-]?key|access token).{0,24}(?:required|missing|not configured)|(?:未配置|缺少|没有|未设置).{0,14}(?:密钥|api.?key|token)|(?:密钥|令牌|token).{0,4}(?:无效|过期)/i.test(text))
    return { hint: zh ? '模型服务未通过身份验证。请检查 API 密钥和服务地址。' : 'Model authentication failed. Check the API key and endpoint.', settings: true };
  if (/\b403\b|permission_denied|forbidden/i.test(text))
    return { hint: zh ? '服务拒绝了这次请求。请核对账号和模型的访问权限。' : 'Access was denied. Check the account and model permissions.', settings: true };
  if (/\b429\b|rate[_ -]?limit|请求过于频繁/i.test(text))
    return { hint: zh ? '服务暂时限制了请求频率，稍等片刻再试。' : 'The provider is rate limiting requests. Try again shortly.' };
  if (/(?:DSH|Host).*(?:启动超时|startup timed out|startup timeout)/i.test(text))
    return { hint: zh ? 'DSH 启动超时，伙伴尚未连上执行环境。可以查看本次启动的实例日志。' : 'DSH startup timed out. Check the instance log for the startup attempt.' };
  if (/UND_ERR_CONNECT_TIMEOUT|connect(?:ion)? (?:time(?:d out|out))|request (?:time(?:d out|out))/i.test(text))
    return { hint: zh ? '模型请求超时。请检查网络和服务地址后重试。' : 'The model request timed out. Check the network and service endpoint, then retry.' };
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|fetch failed|network error|请求超时|连接超时/i.test(text))
    return { hint: zh ? '服务连接失败，请检查网络和服务地址后重试。' : 'Connection failed. Check the network and service endpoint.' };
  return { hint: '' };
}

export function BotErrorNotice({ message, zh, toast = false }: { message: string; zh: boolean; toast?: boolean }) {
  const { api, state, openModelSettings, revealAppLog } = useContext(BotDiagnostics);
  const detail = safeDetail(message);
  const { hint, settings } = diagnose(detail, zh);
  const namedId = /[/\\]instances[/\\]([a-z0-9-]{1,80})[/\\]logs[/\\]host\.log\b/i.exec(message)?.[1];
  const instance = state?.instances.find(value => namedId ? value.id === namedId : value.isDefault);
  const [logInstance, setLogInstance] = useState<typeof instance>();
  const instanceId = logInstance?.id;
  const [tab, setTab] = useState<'detail' | 'log'>(), [revision, setRevision] = useState(0);
  const [log, setLog] = useState<string>(), [logError, setLogError] = useState(''), [feedback, setFeedback] = useState('');
  const modal = useRef<HTMLDialogElement>(null), title = useId();
  const open = (view: 'detail' | 'log') => { setLogInstance(instance); setFeedback(''); setLog(undefined); setLogError(''); setTab(view); };
  const visible = !!tab;
  useEffect(() => {
    if (!visible || !modal.current) return;
    const node = modal.current;
    node.showModal();
    return () => node.close();
  }, [visible]);
  useEffect(() => {
    if (tab !== 'log' || !api || !instanceId) return;
    let live = true;
    void api.request({ type: 'instance.logs', instanceId }).then(result => {
      if (!live) return;
      if (result.ok) setLog(safeDetail(result.text ?? '')); else setLogError(safeDetail(result.error));
    }).catch(reason => { if (live) setLogError(safeDetail(String(reason))); });
    return () => { live = false; };
  }, [api, instanceId, tab, revision]);
  const folder = async () => {
    try {
      const result = tab === 'log' && instanceId ? await api?.request({ type: 'instance.folder', instanceId, scope: 'logs' }) : await revealAppLog?.();
      if (!result?.ok) setFeedback(result && 'error' in result ? safeDetail(String(result.error)) : zh ? '日志文件暂时无法打开。' : 'The log file could not be opened.');
    } catch (cause) { setFeedback(safeDetail(String(cause))); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(tab === 'log' ? log ?? '' : detail); setFeedback(zh ? '已复制' : 'Copied'); }
    catch { setFeedback(zh ? '可以选中下方文字手动复制。' : 'Select the text below to copy it.'); }
  };
  const logLabel = namedId ? (zh ? '查看实例日志' : 'View instance log') : (zh ? '查看当前实例日志' : 'View current instance log');
  const unsentDsh = toast ? /^(.*DSH[^，\n]*)，本次消息未发送。/u.exec(detail)?.[1] : undefined;
  const summary = unsentDsh
    ? (zh ? `${unsentDsh}。请在启动器确认共享 DSH 已就绪后重试。` : 'Check the shared DSH instance in the launcher, then try again.')
    : hint || detail;
  return <div className="bot-error-notice">
    {toast && <strong className="bot-error-toast-title">{unsentDsh ? (zh ? '消息未发送' : 'Message not sent') : (zh ? '操作未完成' : 'Action incomplete')}</strong>}
    <p>{summary}</p>
    <div className="bot-diagnostic-actions">
      {api && instance && <button type="button" onClick={() => open('log')}>{logLabel}</button>}
      {settings && openModelSettings && <button type="button" onClick={event => {
        event.currentTarget.closest<HTMLDialogElement>('dialog.bot-presence-archive')?.requestClose();
        openModelSettings();
      }}>{zh ? '打开模型设置' : 'Model settings'}</button>}
      <button type="button" onClick={() => open('detail')}>{zh ? '错误详情' : 'Error details'}</button>
    </div>
    {tab && <dialog ref={modal} className="bot-diagnostic-dialog" aria-labelledby={title} onKeyDown={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); event.stopPropagation(); setTab(undefined); }}>
      <header><h3 id={title}>{tab === 'log' ? (zh ? '实例日志' : 'Instance log') : (zh ? '错误详情' : 'Error details')}</h3>
        <button type="button" aria-label={zh ? '关闭' : 'Close'} onClick={() => setTab(undefined)}>×</button></header>
      {tab === 'log' && <small>{logInstance?.name} · host.log</small>}
      {tab === 'log' && <details><summary>{zh ? '本次错误' : 'Reported error'}</summary><p>{detail}</p></details>}
      <pre tabIndex={0}>{tab === 'detail' ? detail : logError || (log === undefined ? (zh ? '正在读取…' : 'Loading…') : log || (zh ? '这个实例还没有写入日志。' : 'No log entries yet.'))}</pre>
      <footer><span role="status">{feedback}</span>
        {tab === 'log' && <button type="button" onClick={() => { setLog(undefined); setLogError(''); setRevision(n => n + 1); }}>{zh ? '刷新' : 'Refresh'}</button>}
        {(tab === 'log' || revealAppLog) && <button type="button" onClick={() => void folder()}>{tab === 'log' ? (zh ? '打开日志文件夹' : 'Open log folder') : (zh ? '定位应用日志' : 'Locate application log')}</button>}
        <button type="button" disabled={tab === 'log' && !log} onClick={() => void copy()}>{zh ? '复制' : 'Copy'}</button>
      </footer>
    </dialog>}
  </div>;
}
