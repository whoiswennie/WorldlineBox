import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_CAPTURE_TOOLS_SETTINGS, type CaptureToolsSettings, type CaptureToolsState, type WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Icon, type IconName } from '../Icons';
import { useLocale } from '../i18n';
import { getShortcutRuntimePlatform } from '../shortcut-runtime';
import { Button, Select } from '../ui';
import { CaptureShortcutField, captureShortcutKey, captureShortcutProblem, useCaptureShortcutRecorder } from './CaptureShortcutField';
import { useCaptureWords } from './messages';
import './capture-tools.css';
import './capture-tools-settings.css';

const tasks = ['screenshot', 'recording', 'ocr', 'translate', 'long-screenshot', 'selection'] as const;
const icons: Record<typeof tasks[number], IconName> = { screenshot: 'camera', recording: 'video', ocr: 'scan-text', translate: 'languages', 'long-screenshot': 'crop', selection: 'sparkles' };
export function getCaptureToolsApi() {
  return (window as unknown as { worldlinebox?: { captureTools?: WorldlineBoxCaptureToolsApi } }).worldlinebox?.captureTools;
}

export function CaptureToolsSettingsPage({ api = getCaptureToolsApi() }: { api?: WorldlineBoxCaptureToolsApi }) {
  const words = useCaptureWords();
  const { locale } = useLocale();
  const platform = getShortcutRuntimePlatform();
  const labels = locale === 'zh-CN' ? {
    hint: '在任意应用中快速使用。点击按键区域，直接按下新的组合键；保存后生效。', preparing: '正在准备…', recording: '请按下组合键…', change: '点击录入快捷键，Esc 取消',
    clear: '清除', reset: '重置', disabled: '未设置', shortcutSuffix: '快捷键', modifier: '请使用 Ctrl、Alt 或 Command 加一个按键。', reserved: '这是系统保留组合键，请换一个。', invalid: '无法使用这组快捷键，请重新录入。',
    changed: '待保存', duplicate: '与以下功能重复：', escape: '松开按键完成录入，Esc 取消。',
    hideHint: '先隐藏主窗口，再选择屏幕区域。', soundHint: '录制电脑正在播放的声音。', microphoneHint: '默认关闭，需要时再开启。',
    choices: '录制画面', globalHint: '应用运行时，快捷键在整个电脑中可用。',
  } : {
    hint: 'Available in any app. Click a key area, press a new combination, then save to apply.', preparing: 'Preparing…', recording: 'Press a combination…', change: 'Click to record a shortcut; Esc cancels',
    clear: 'Clear ', reset: 'Reset ', disabled: 'Not set', shortcutSuffix: ' shortcut', modifier: 'Use Ctrl, Alt or Command together with a key.', reserved: 'This combination is reserved by the system. Choose another.', invalid: 'This shortcut is not supported. Record another.',
    changed: 'Unsaved', duplicate: 'Also used by: ', escape: 'Release the keys to finish; Esc cancels.',
    hideHint: 'Hide the main window before selecting a screen region.', soundHint: 'Include sound playing on your computer.', microphoneHint: 'Off by default. Turn on when needed.',
    choices: 'Recording picture', globalHint: 'Shortcuts work across your computer while the app is running.',
  };
  const [state, setState] = useState<CaptureToolsState>();
  const [settings, setSettings] = useState<CaptureToolsSettings>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const recorder = useCaptureShortcutRecorder(api, words.failed);
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
  const issues = new Map<typeof tasks[number], string>();
  if (settings) for (const task of tasks) {
    const value = settings.shortcuts[task];
    const problem = captureShortcutProblem(value, platform);
    if (problem) issues.set(task, labels[problem]);
    else if (value.trim()) {
      const duplicate = tasks.filter(other => other !== task && settings.shortcuts[other].trim() && captureShortcutKey(settings.shortcuts[other], platform) === captureShortcutKey(value, platform));
      if (duplicate.length) issues.set(task, labels.duplicate + duplicate.map(other => words[other]).join('、'));
    }
  }
  async function save() {
    if (!api || !settings || issues.size || recorder.task) return;
    setBusy(true); setMessage('');
    try {
      const result = await api.request({ type: 'settings.save', settings });
      setFailed(!result.ok);
      setMessage(result.ok ? words.saved : result.error);
      if (result.ok && result.state) { accept(result.state); setSettings(result.state.settings); }
    } catch { setFailed(true); setMessage(words.failed); }
    finally { setBusy(false); }
  }
  return <section className="capture-tools-settings capture-settings-redesign" aria-label={words.settingsTitle} data-capture-tools-settings>
    <p className="capture-settings-intro">{labels.hint}</p>
    {!api ? <p role="alert">{words.unavailable}</p> : !settings ? <p role="status">{message || words.loading}</p> : <>
      <fieldset disabled={busy} className="capture-settings-shortcuts"><legend>{words.shortcuts}<span>{labels.globalHint}</span></legend>{tasks.map(task => {
        const registration = state?.shortcuts.find(item => item.task === task);
        const edited = settings.shortcuts[task] !== state?.settings.shortcuts[task];
        const issue = issues.get(task);
        const registrationError = !edited ? registration?.error : undefined;
        return <div className={'capture-setting-shortcut' + (issue || registrationError ? ' has-error' : '')} key={task}>
          <CaptureShortcutField task={task} icon={icons[task]} label={words[task]} value={settings.shortcuts[task]} defaultValue={DEFAULT_CAPTURE_TOOLS_SETTINGS.shortcuts[task]} platform={platform} recorder={recorder} labels={{ ...labels, failed: words.failed }} disabled={busy}
            onChange={value => { setMessage(''); setSettings({ ...settings, shortcuts: { ...settings.shortcuts, [task]: value } }); }} />
          <div className="capture-key-status">{issue || registrationError ? <span className="is-error" role="alert"><Icon name="alert-circle" size={11} />{issue || registrationError}</span> : <span className={edited ? 'is-edited' : registration?.registered ? 'is-enabled' : ''}><i />{edited ? labels.changed : registration?.registered ? words.enabled : settings.shortcuts[task] ? registration ? words.shortcutFailed : words.ready : words.disabled}</span>}</div>
        </div>;
      })}<p className="capture-settings-key-hint">{labels.escape}</p></fieldset>
      <fieldset disabled={busy} className="capture-settings-defaults"><legend>{words.defaults}</legend><div className="capture-settings-switches">{([
        ['hideApp', 'eye-off', words.hideApp, labels.hideHint], ['systemAudio', 'volume', words.systemAudio, labels.soundHint], ['microphone', 'microphone', words.microphone, labels.microphoneHint],
      ] as const).map(([key, icon, title, hint]) => <label className="capture-settings-switch" key={key}><span className="capture-setting-icon"><Icon name={icon} size={17} /></span><span><strong>{title}</strong><small>{hint}</small></span><input type="checkbox" role="switch" checked={settings[key]} onChange={event => setSettings({ ...settings, [key]: event.target.checked })} /></label>)}</div>
        <div className="capture-settings-selects"><Select label={words.format} value={settings.format} options={['mp4', 'webm', 'gif'].map(value => ({ value, label: value.toUpperCase() }))} onValueChange={value => setSettings({ ...settings, format: value as CaptureToolsSettings['format'] })} />
          <Select label={words.quality} value={settings.quality} options={[{ value: 'original', label: words.qualityOriginal }, { value: '1080p', label: words.quality1080 }, { value: '720p', label: words.quality720 }]} onValueChange={value => setSettings({ ...settings, quality: value as CaptureToolsSettings['quality'] })} /></div>
      </fieldset>
      {state?.downloadPath ? <div className="capture-settings-location"><span className="capture-setting-icon"><Icon name="folder" size={18} /></span><div><strong>{words.location}</strong><span title={state.downloadPath}>{state.downloadPath}</span></div><Button size="sm" variant="quiet" iconName="folder" onClick={() => void api.request({ type: 'reveal', path: state.downloadPath })}>{words.openFolder}</Button></div> : null}
      {message ? <p className={failed ? 'capture-tools-error' : 'capture-tools-muted'} role={failed ? 'alert' : 'status'}>{message}</p> : null}
      <div className="capture-tools-actions capture-settings-actions"><Button variant="quiet" disabled={busy || Boolean(recorder.task)} onClick={() => { setMessage(''); setSettings(structuredClone(DEFAULT_CAPTURE_TOOLS_SETTINGS)); }}>{words.reset}</Button><Button disabled={busy || issues.size > 0 || Boolean(recorder.task)} loading={busy} onClick={() => void save()}>{words.saveSettings}</Button></div>
    </>}
  </section>;
}
