import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsSettings, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Button, Select, TextField } from '../ui';
import { useCaptureWords } from './messages';
import './capture-tools.css';

const tasks = ['screenshot', 'recording', 'ocr', 'translate', 'long-screenshot', 'selection'] as const;
export function getCaptureToolsApi() {
  return (window as unknown as { worldlinebox?: { captureTools?: WorldlineBoxCaptureToolsApi } }).worldlinebox?.captureTools;
}

export function CaptureToolsSettingsPage({ api = getCaptureToolsApi() }: { api?: WorldlineBoxCaptureToolsApi }) {
  const words = useCaptureWords();
  const [state, setState] = useState<CaptureToolsState>();
  const [settings, setSettings] = useState<CaptureToolsSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const accept = useCallback((next: CaptureToolsState) => setState(previous => previous && previous.revision > next.revision ? previous : next), []);
  useEffect(() => {
    if (!api) return;
    let current = true;
    void api.request({ type: 'state' }).then(result => {
      if (!current) return;
      if (result.ok && result.state) { accept(result.state); setSettings(result.state.settings); }
      else { setFailed(true); setMessage(result.ok ? words.unavailable : result.error); }
    }).catch(() => { if (current) { setFailed(true); setMessage(words.failed); } });
    const unsubscribe = api.onChanged(next => { if (current) accept(next); });
    return () => { current = false; unsubscribe(); };
  }, [api, accept, words]);
  async function save() {
    if (!api || !settings) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.request({ type: 'settings.save', settings });
      setFailed(!result.ok);
      setMessage(result.ok ? words.saved : result.error);
      if (result.ok && result.state) { accept(result.state); setSettings(result.state.settings); }
    } catch { setFailed(true); setMessage(words.failed); }
    finally { setBusy(false); }
  }
  return <section className="capture-tools-settings" aria-label={words.settingsTitle} data-capture-tools-settings>
    <p className="capture-tools-muted">{words.settingsHint}</p>
    {!api ? <p role="alert">{words.unavailable}</p> : !settings ? <p role="status">{message || words.loading}</p> : <>
      <fieldset disabled={busy}><legend>{words.shortcuts}</legend>{tasks.map(task => {
        const registration = state?.shortcuts.find(item => item.task === task);
        const edited = settings.shortcuts[task] !== state?.settings.shortcuts[task];
        return <div className="capture-shortcut-row" key={task}><TextField label={words[task]} placeholder={DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts[task]} maxLength={100} value={settings.shortcuts[task]} onChange={event => setSettings({ ...settings, shortcuts: { ...settings.shortcuts, [task]: event.target.value } })} />
          {!edited && registration ? <small className={registration.error ? 'is-error' : ''}>{registration.error || (registration.registered ? words.enabled : settings.shortcuts[task] ? words.shortcutFailed : words.disabled)}</small> : null}</div>;
      })}</fieldset>
      <fieldset disabled={busy}><legend>{words.defaults}</legend><label className="capture-option"><input type="checkbox" checked={settings.hideApp} onChange={event => setSettings({ ...settings, hideApp: event.target.checked })} />{words.hideApp}</label><label className="capture-option"><input type="checkbox" checked={settings.systemAudio} onChange={event => setSettings({ ...settings, systemAudio: event.target.checked })} />{words.systemAudio}</label><label className="capture-option"><input type="checkbox" checked={settings.microphone} onChange={event => setSettings({ ...settings, microphone: event.target.checked })} />{words.microphone}</label><Select label={words.format} value={settings.format} options={['mp4', 'webm', 'gif'].map(value => ({ value, label: value.toUpperCase() }))} onValueChange={value => setSettings({ ...settings, format: value as CaptureToolsSettings['format'] })} /></fieldset>
      {state?.downloadPath ? <div className="capture-tools-location"><strong>{words.location}</strong><span title={state.downloadPath}>{state.downloadPath}</span><Button size="sm" variant="quiet" iconName="folder" onClick={() => void api.request({ type: 'reveal', path: state.downloadPath })}>{words.openFolder}</Button></div> : null}
      {message ? <p className={failed ? 'capture-tools-error' : 'capture-tools-muted'} role={failed ? 'alert' : 'status'}>{message}</p> : null}
      <div className="capture-tools-actions"><Button variant="quiet" disabled={busy} onClick={() => setSettings(structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS))}>{words.reset}</Button><Button disabled={busy} loading={busy} onClick={() => void save()}>{words.saveSettings}</Button></div>
    </>}
  </section>;
}
