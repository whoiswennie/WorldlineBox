import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { DshLauncherState, WorldlineBoxDshLauncherApi } from '../../shared/dsh-launcher';
import { useT } from '../i18n';
import { isImeKeyboardEvent } from '../ime-safe-dismiss';
import { Button, Select, TextField } from '../ui';
import type { LauncherRunRequest } from './DshLauncher';
import { connectTerminalOutput, retainTerminalViews, TerminalSurface, type TerminalSurfaceHandle } from './TerminalSurface';

export function LauncherTerminal(props: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly busy: boolean; readonly api?: WorldlineBoxDshLauncherApi; readonly visible?: boolean; readonly preparingCli?: string;
}) {
  return props.state.cli?.terminals ? <PtyLauncherTerminal {...props} /> : <LegacyLauncherTerminal {...props} />;
}

function PtyLauncherTerminal({ state, run, busy, api, visible = true, preparingCli }: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly busy: boolean; readonly api?: WorldlineBoxDshLauncherApi; readonly visible?: boolean; readonly preparingCli?: string;
}) {
  const t = useT();
  const cli = state.cli!; const sessions = cli.terminals ?? [];
  const active = sessions.find(session => session.id === cli.activeTerminalId) ?? sessions.at(-1);
  const directoryLabel = active?.cwd.split(/[\\/]/).filter(Boolean).slice(-2).join(' / ');
  const selected = state.instances.find(instance => instance.id === cli.selectedInstanceId);
  const handles = useRef(new Map<string, TerminalSurfaceHandle>());
  const inputQueue = useRef(Promise.resolve());
  const [following, setFollowing] = useState(true);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [found, setFound] = useState<boolean | undefined>();
  const [clipboardError, setClipboardError] = useState(false);
  const [opening, setOpening] = useState(false);
  const openingRef = useRef(false);
  const openTerminal = async () => {
    if (openingRef.current || preparingCli || !selected) return;
    openingRef.current = true; setOpening(true);
    try { await run({ type: 'terminal.open', instanceId: selected.id }); }
    finally { openingRef.current = false; setOpening(false); }
  };
  const [closing, setClosing] = useState<ReadonlySet<string>>(new Set());
  const closingIds = useRef(new Set<string>());
  const closeTab = async (session: (typeof sessions)[number]) => {
    if (closingIds.current.has(session.id)) return;
    closingIds.current.add(session.id); setClosing(new Set(closingIds.current));
    try {
      if (session.status === 'running') {
        const result = await run({ type: 'terminal.close', terminalId: session.id });
        if (!result.ok) return;
      }
      await run({ type: 'terminal.remove', terminalId: session.id });
    } finally { closingIds.current.delete(session.id); setClosing(new Set(closingIds.current)); }
  };
  useEffect(() => {
    if (!clipboardError) return;
    const timer = setTimeout(() => setClipboardError(false), 5_000);
    return () => clearTimeout(timer);
  }, [clipboardError]);
  const ids = sessions.map(session => session.id).join('\0');
  useLayoutEffect(() => { retainTerminalViews(ids ? ids.split('\0') : []); }, [ids]);
  useEffect(() => { if (api) connectTerminalOutput(api); }, [api]);
  const send = (terminalId: string, text: string) => {
    // Large bracketed pastes remain ordered and within the backend byte cap.
    for (let offset = 0; offset < text.length;) {
      let end = Math.min(text.length, offset + 16_000);
      if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1] ?? '')) end--;
      const piece = text.slice(offset, end); offset = end;
      inputQueue.current = inputQueue.current.then(async () => { await run({ type: 'terminal.input', terminalId, text: piece }); }).catch(() => undefined);
    }
  };
  const current = () => active ? handles.current.get(active.id) : undefined;
  const search = (backwards = false) => setFound(current()?.search(query, backwards));
  const copy = async () => {
    const view = current(); if (!view) return;
    try { await navigator.clipboard.writeText(view.selection() || view.text()); setClipboardError(false); }
    catch { setClipboardError(true); }
  };
  const paste = async () => {
    try { current()?.paste(await navigator.clipboard.readText()); setClipboardError(false); }
    catch { setClipboardError(true); }
  };
  const openLink = (url: string) => {
    const shell = (window as Window & { worldlinebox?: { shell?: { openExternalUrl(url: string): Promise<unknown> } } }).worldlinebox?.shell;
    if (shell) void shell.openExternalUrl(url);
  };
  return <div className="launcher-page launcher-terminal-page" data-dsh-terminal data-terminal-mode="conpty">
    <div className="launcher-page-heading"><div><h1>{t('launcher.terminal')}</h1><p>{t('launcher.terminalDescription')}</p></div><Button disabled={busy || !!preparingCli || opening || !selected || sessions.filter(session => session.status === 'running').length >= 8} loading={opening} iconName="plus" onClick={() => void openTerminal()} variant="primary">{t('launcher.newTerminal')}</Button></div>
    <section className="launcher-card launcher-cli-context launcher-terminal-context">
      <Select label={t('launcher.currentCli')} disabled={busy} onValueChange={value => { if (value) void run({ type: 'cli.select', instanceId: value }); }} options={[{ value: '', label: t('launcher.chooseCli') }, ...state.instances.map(instance => ({ value: instance.id, label: `${instance.name} · DSH ${state.runtimes.find(runtime => runtime.id === instance.runtimeId)?.version ?? instance.runtimeId}` }))]} value={preparingCli ?? cli.selectedInstanceId ?? ''} />
      <div className="launcher-terminal-context-detail"><p className="launcher-help">{t('launcher.terminalContextNote')}</p><Button disabled={busy || cli.pathEnabled || !selected} iconName="code" onClick={() => void run({ type: 'cli.install-command' })} size="sm" variant="quiet">{t(cli.pathEnabled ? 'launcher.cliEnabled' : 'launcher.enableCli')}</Button></div>
    </section>
    <section className="launcher-card launcher-terminal-card">
      <div aria-label={t('launcher.terminalSessions')} className="launcher-terminal-sessions" role="tablist">{sessions.map((session, index) => <div className="launcher-terminal-session-group" data-active={session.id === active?.id} key={session.id} role="presentation"><button aria-controls={`terminal-${session.id}`} aria-selected={session.id === active?.id} className="launcher-terminal-session" id={`terminal-tab-${session.id}`} onClick={() => { void run({ type: 'terminal.select', terminalId: session.id }); }} onKeyDown={event => {
        if (isImeKeyboardEvent(event)) return;
        const next = event.key === 'ArrowRight' ? (index + 1) % sessions.length : event.key === 'ArrowLeft' ? (index + sessions.length - 1) % sessions.length : event.key === 'Home' ? 0 : event.key === 'End' ? sessions.length - 1 : undefined;
        if (next === undefined) return;
        event.preventDefault(); const target = sessions[next]!;
        void run({ type: 'terminal.select', terminalId: target.id }); document.getElementById(`terminal-tab-${target.id}`)?.focus();
      }} role="tab" tabIndex={session.id === active?.id ? 0 : -1} type="button"><span aria-hidden className={`launcher-status-dot is-${session.status}`} /><span>{state.instances.find(instance => instance.id === session.instanceId)?.name ?? session.instanceId}</span></button><Button aria-label={t('launcher.closeNamedTerminal', { name: state.instances.find(instance => instance.id === session.instanceId)?.name ?? session.instanceId })} className="launcher-terminal-session-close" disabled={closing.has(session.id)} loading={closing.has(session.id)} iconName="close" onClick={() => void closeTab(session)} size="sm" variant="quiet" /></div>)}</div>
      {active ? <>
        <div className="launcher-terminal-toolbar"><div className="launcher-terminal-context-label"><span className="launcher-badge">{active.transport === 'conpty' ? 'PowerShell' : t('launcher.lineTerminal')}</span><span>DSH {active.runtimeVersion}</span><code title={active.cwd}>{directoryLabel ?? active.cwd}</code></div><div className="launcher-actions"><Button aria-pressed={searchOpen} iconName="search" onClick={() => setSearchOpen(value => !value)} size="sm" variant="quiet">{t('launcher.terminalSearch')}</Button><Button iconName="copy" onClick={() => void copy()} size="sm" variant="quiet">{t('launcher.terminalCopy')}</Button><Button disabled={active.status !== 'running'} onClick={() => void paste()} size="sm" variant="quiet">{t('launcher.terminalPaste')}</Button><Button iconName="download" onClick={() => void run({ type: 'terminal.export', terminalId: active.id })} size="sm" variant="quiet">{t('launcher.terminalExport')}</Button><Button disabled={busy} iconName="trash" onClick={() => void run({ type: 'terminal.clear', terminalId: active.id })} size="sm" variant="quiet">{t('launcher.clearTerminal')}</Button></div></div>
        {searchOpen ? <form className="launcher-terminal-search" onSubmit={event => { event.preventDefault(); search(); }}><TextField autoFocus aria-label={t('launcher.terminalSearch')} onChange={event => { setQuery(event.target.value); setFound(undefined); }} onKeyDown={event => { if (event.key === 'Escape' && !isImeKeyboardEvent(event)) setSearchOpen(false); }} placeholder={t('launcher.terminalSearchPlaceholder')} value={query} /><Button disabled={!query} onClick={() => search(true)} size="sm">{t('launcher.previousMatch')}</Button><Button disabled={!query} size="sm" type="submit">{t('launcher.nextMatch')}</Button>{found === false ? <span className="launcher-terminal-search-status">{t('launcher.noTerminalMatches')}</span> : null}<Button aria-label={t('launcher.close')} iconName="close" onClick={() => setSearchOpen(false)} size="sm" variant="quiet" /></form> : null}
        {sessions.map(session => <div aria-labelledby={`terminal-tab-${session.id}`} hidden={session.id !== active.id} id={`terminal-${session.id}`} key={session.id} role="tabpanel"><TerminalSurface active={visible && session.id === active.id} label={t('launcher.terminalOutput')} onFollowChange={value => { if (session.id === active.id) setFollowing(value); }} onInput={data => send(session.id, data)} onLink={openLink} onSearch={() => setSearchOpen(true)} onReady={view => { if (view) handles.current.set(session.id, view); else handles.current.delete(session.id); }} onResize={(cols, rows) => { if (session.status === 'running') void run({ type: 'terminal.resize', terminalId: session.id, cols: Math.min(400, Math.max(20, cols)), rows: Math.min(200, Math.max(5, rows)) }); }} readOnly={session.status !== 'running'} sessionId={session.id} snapshot={{ text: session.output, startOffset: session.outputOffset, revision: session.outputRevision }} /></div>)}
        <div className="launcher-terminal-footer"><span>{active.status === 'running' ? t('launcher.terminalReady') : t('launcher.terminalExit', { code: String(active.lastExitCode ?? '—') })} · <kbd>Ctrl+C</kbd> {t('launcher.terminalInterruptHint')} · <kbd>↑ ↓</kbd> {t('launcher.terminalHistoryHint')}</span><div className="launcher-actions">{!following ? <Button onClick={() => current()?.follow()} size="sm" variant="quiet">{t('launcher.followTerminal')}</Button> : null}<Button disabled={active.status !== 'running'} onClick={() => send(active.id, '\u0003')} size="sm" variant="quiet">{t('launcher.interruptTerminal')}</Button><Button disabled={closing.has(active.id)} loading={closing.has(active.id)} iconName="close" onClick={() => void closeTab(active)} size="sm" variant="quiet">{t(active.status === 'running' ? 'launcher.closeTerminal' : 'launcher.closeTerminalTab')}</Button></div></div>
        {clipboardError ? <span className="launcher-terminal-copy-status" role="status">{t('launcher.terminalClipboardFailed')}</span> : null}
      </> : <div className="launcher-terminal-welcome"><strong>{t('launcher.terminalWelcome')}</strong><p>{t('launcher.terminalPtyNote')}</p><code>dsh --help</code><code>dsh</code></div>}
    </section>
  </div>;
}

function LegacyLauncherTerminal({ state, run, busy }: {
  readonly state: DshLauncherState; readonly run: LauncherRunRequest; readonly busy: boolean;
}) {
  const t = useT();
  const cli = state.cli;
  const [input, setInput] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const output = useRef<HTMLPreElement>(null);
  const followOutput = useRef(true);
  const live = cli?.terminal?.status === 'running';
  const selected = state.instances.find(instance => instance.id === cli?.selectedInstanceId);
  useEffect(() => {
    const element = output.current;
    if (element && followOutput.current) element.scrollTop = element.scrollHeight;
  }, [cli?.output]);
  const send = async () => {
    if (!input.trim() || !live || busy) return;
    const command = input;
    const result = await run({ type: 'terminal.input', text: `${command}\n` });
    if (result.ok) { setHistory(previous => [...previous, command].slice(-50)); setHistoryIndex(-1); setInput(''); }
  };
  return <div className="launcher-page launcher-terminal-page" data-dsh-terminal>
    <div className="launcher-page-heading"><div><h1>{t('launcher.terminal')}</h1><p>{t('launcher.terminalDescription')}</p></div><div className="launcher-actions"><Button disabled={busy || !selected || Boolean(live)} iconName="code" onClick={() => void run({ type: 'terminal.open' })} variant="primary">{t('launcher.openTerminal')}</Button><Button disabled={busy || !live} iconName="stop" onClick={() => void run({ type: 'terminal.close' })}>{t('launcher.closeTerminal')}</Button></div></div>
    <section className="launcher-card launcher-cli-context">
      <Select label={t('launcher.currentCli')} disabled={busy || Boolean(live)} onValueChange={value => { if (value) void run({ type: 'cli.select', instanceId: value }); }} options={[{ value: '', label: t('launcher.chooseCli') }, ...state.instances.map(instance => ({ value: instance.id, label: `${instance.name} · DSH ${state.runtimes.find(runtime => runtime.id === instance.runtimeId)?.version ?? instance.runtimeId}` }))]} value={cli?.selectedInstanceId ?? ''} />
      <p className="launcher-help">{t(live ? 'launcher.terminalSwitchNote' : 'launcher.cliSelectionNote')}</p>
      {cli ? <div className="launcher-cli-command"><code>{cli.commandPath}</code><Button disabled={busy || cli.pathEnabled || !selected} iconName="code" onClick={() => void run({ type: 'cli.install-command' })}>{t(cli.pathEnabled ? 'launcher.cliEnabled' : 'launcher.enableCli')}</Button></div> : null}
    </section>
    <section className="launcher-card launcher-terminal-card"><div className="launcher-card-heading"><div><h2>{live ? t('launcher.terminalRunning') : t('launcher.terminalStopped')}</h2><p>{cli?.terminal?.cwd ?? state.sharedData?.workspacePath ?? ''}</p></div><Button disabled={busy || !cli?.output} iconName="trash" onClick={() => void run({ type: 'terminal.clear' })} variant="quiet">{t('launcher.clearTerminal')}</Button></div><pre aria-label={t('launcher.terminalOutput')} aria-live="off" className="launcher-terminal-output" data-dsh-terminal-output onScroll={() => { const element = output.current; if (element) followOutput.current = element.scrollHeight - element.scrollTop - element.clientHeight < 64; }} ref={output} role="log">{cli?.output || t('launcher.terminalEmpty')}</pre><form className="launcher-terminal-input" onSubmit={event => { event.preventDefault(); void send(); }}><TextField autoComplete="off" disabled={!live || busy} label={t('launcher.terminalInput')} onChange={event => setInput(event.target.value)} onKeyDown={event => {
      if (isImeKeyboardEvent(event) || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
      event.preventDefault(); const next = event.key === 'ArrowUp' ? (historyIndex < 0 ? history.length - 1 : Math.max(0, historyIndex - 1)) : (historyIndex < 0 || historyIndex >= history.length - 1 ? -1 : historyIndex + 1);
      setHistoryIndex(next); setInput(next < 0 ? '' : history[next] ?? '');
    }} placeholder={t('launcher.terminalPlaceholder')} value={input} /><Button disabled={!live || busy || !input.trim()} iconName="chevron-right" type="submit" variant="primary">{t('launcher.sendTerminal')}</Button></form><p className="launcher-help">{t('launcher.terminalModeNote')}</p></section>
  </div>;
}
