import { useCallback, useEffect, useRef, useState } from 'react';
import { parseElectronAccelerator } from '../../shared/plugin-accelerator';
import type { ShortcutChord, ShortcutPlatform } from '../../shared/shortcut-catalog';
import { chordFromKeyboardEvent, formatElectronAccelerator, formatShortcutChord, validateShortcutChord } from '../../shared/shortcut-resolution';
import type { CaptureToolsSettings, WorldlineBoxCaptureToolsApi } from '../../shared/capture-tools';
import { Icon, type IconName } from '../Icons';

type CaptureTask = keyof CaptureToolsSettings['shortcuts'];
type CaptureState = { task?: CaptureTask; ready: boolean; error?: { task: CaptureTask; message: string } };
type CaptureLabels = { preparing: string; recording: string; change: string; clear: string; reset: string; disabled: string; modifier: string; reserved: string; invalid: string; failed: string; shortcutSuffix: string };
// A closing page can still await Main's reply. Its release must precede the
// next page's acquisition, even after React creates a new hook instance.
const nativeCaptureQueues = new WeakMap<WorldlineBoxCaptureToolsApi, Promise<void>>();

/** One queue owns native suspension for the whole page, including focus transfers. */
export function useCaptureShortcutRecorder(api: WorldlineBoxCaptureToolsApi | undefined, failed: string) {
  const [state, setState] = useState<CaptureState>({ ready: false });
  const current = useRef<{ task: CaptureTask } | undefined>(undefined);
  const alive = useRef(true);
  const attempted = useRef(false);
  const run = useCallback((operation: () => Promise<void>) => {
    const previous = api ? nativeCaptureQueues.get(api) : undefined;
    const next = (previous ?? Promise.resolve()).catch(() => undefined).then(operation).catch(() => undefined);
    if (api) nativeCaptureQueues.set(api, next);
  }, [api]);
  const release = useCallback(async () => {
    if (!api) return false;
    for (let retry = 0; retry < 3; retry++) {
      try { const response = await api.request({ type: 'shortcuts.capture', active: false }); if (response.ok) return true; }
      catch { /* Retry an ambiguous delivery so global shortcuts are restored. */ }
    }
    return false;
  }, [api]);
  const end = useCallback((task?: CaptureTask) => {
    if (!current.current || (task && task !== current.current.task)) return;
    const previousTask = current.current.task;
    current.current = undefined;
    if (alive.current) setState(previous => ({ ready: false, error: previous.error }));
    run(async () => {
      const restored = await release();
      if (!restored && alive.current && !current.current) setState({ ready: false, error: { task: previousTask, message: failed } });
    });
  }, [failed, release, run]);
  const begin = useCallback((task: CaptureTask) => {
    if (!api || current.current?.task === task) return;
    const next = { task };
    current.current = next; attempted.current = true; setState({ task, ready: false });
    run(async () => {
      try {
        const response = await api.request({ type: 'shortcuts.capture', active: true });
        if (!response.ok) throw Error(response.error);
        if (alive.current && current.current === next) setState({ task, ready: true });
      } catch (cause) {
        await release();
        if (alive.current && current.current === next) {
          current.current = undefined;
          setState({ ready: false, error: { task, message: cause instanceof Error && cause.message ? cause.message : failed } });
        }
      }
    });
  }, [api, failed, release, run]);
  useEffect(() => {
    alive.current = true;
    const blur = () => end();
    window.addEventListener('blur', blur);
    return () => {
      alive.current = false; current.current = undefined;
      window.removeEventListener('blur', blur);
      if (attempted.current) run(async () => { await release(); });
    };
  }, [end, release, run]);
  return { ...state, begin, end };
}

export function captureShortcutProblem(value: string, platform: ShortcutPlatform): 'modifier' | 'reserved' | 'invalid' | undefined {
  if (!value.trim()) return undefined;
  const chord = parseElectronAccelerator(value, platform);
  if (!chord) return 'invalid';
  if (!chord.ctrlKey && !chord.altKey && !chord.metaKey) return 'modifier';
  const problem = validateShortcutChord(chord, platform, ['app']);
  return problem === 'system' ? 'reserved' : problem ? 'invalid' : undefined;
}

export function captureShortcutKey(value: string, platform: ShortcutPlatform): string {
  const chord = parseElectronAccelerator(value, platform);
  return chord ? formatElectronAccelerator(chord, platform)?.toLowerCase() ?? value.toLowerCase() : value.toLowerCase();
}

function keycaps(chord: ShortcutChord, platform: ShortcutPlatform): string[] {
  return [
    chord.ctrlKey ? platform === 'mac' ? '⌃' : 'Ctrl' : '',
    chord.altKey ? platform === 'mac' ? '⌥' : 'Alt' : '',
    chord.metaKey ? platform === 'mac' ? '⌘' : 'Win' : '',
    chord.shiftKey ? platform === 'mac' ? '⇧' : 'Shift' : '',
    formatShortcutChord({ key: chord.key, code: chord.code }, platform),
  ].filter(Boolean);
}

export function CaptureShortcutField({ task, icon, label, value, defaultValue, platform, recorder, labels, disabled, onChange }: {
  task: CaptureTask; icon: IconName; label: string; value: string; defaultValue: string; platform: ShortcutPlatform;
  recorder: ReturnType<typeof useCaptureShortcutRecorder>; labels: CaptureLabels; disabled?: boolean; onChange(value: string): void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const candidate = useRef<ShortcutChord | undefined>(undefined);
  const [preview, setPreview] = useState<ShortcutChord>();
  const [error, setError] = useState('');
  const recording = recorder.task === task;
  const ready = recording && recorder.ready;
  const parsed = parseElectronAccelerator(value, platform);
  const displayed = recording ? preview ?? parsed : parsed;
  const caps = displayed ? keycaps(displayed, platform) : [];
  const issue = error || (recorder.error?.task === task ? recorder.error.message : '');
  function finish(value?: string) {
    candidate.current = undefined; setPreview(undefined); setError('');
    if (value !== undefined) onChange(value);
    recorder.end(task); input.current?.blur();
  }
  return <div className={'capture-key-field' + (recording ? ' is-recording' : '') + (issue ? ' has-error' : '')}>
    <label htmlFor={'capture-key-' + task} className="capture-key-label"><span><Icon name={icon} size={17} /></span><strong>{label}</strong></label>
    <div className="capture-key-editor">
      <div className="capture-key-trigger">
        <input ref={input} id={'capture-key-' + task} type="text" readOnly autoComplete="off" spellCheck={false} disabled={disabled} aria-label={label + labels.shortcutSuffix}
          value={recording ? ready ? labels.recording : labels.preparing : parsed ? formatShortcutChord(parsed, platform) : value ? labels.invalid : labels.disabled}
          title={labels.change} onFocus={() => { candidate.current = undefined; setPreview(undefined); setError(''); recorder.begin(task); }} onClick={() => { if (!recording) { candidate.current = undefined; setPreview(undefined); recorder.begin(task); } }} onBlur={() => { recorder.end(task); candidate.current = undefined; setPreview(undefined); }}
          onKeyDown={event => {
            if (event.key === 'Tab') { recorder.end(task); return; }
            event.preventDefault(); event.stopPropagation();
            if (event.key === 'Escape') { finish(); return; }
            if (!ready || event.repeat) return;
            if (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey && ['Backspace', 'Delete'].includes(event.key)) { finish(''); return; }
            const chord = chordFromKeyboardEvent(event);
            if (!chord) { setPreview({ key: '…', ctrlKey: event.ctrlKey, altKey: event.altKey, metaKey: event.metaKey, shiftKey: event.shiftKey }); return; }
            const accelerator = formatElectronAccelerator(chord, platform);
            const problem = accelerator ? captureShortcutProblem(accelerator, platform) : 'invalid';
            if (problem) { candidate.current = undefined; setPreview(chord); setError(labels[problem]); return; }
            candidate.current = chord; setPreview(chord); setError('');
          }} onKeyUp={event => {
            if (!recording) return;
            event.preventDefault(); event.stopPropagation();
            const chord = candidate.current;
            if (!ready || !chord) return;
            if ((chord.code && event.code === chord.code) || event.key.toLowerCase() === chord.key.toLowerCase() || (!event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey)) {
              const accelerator = formatElectronAccelerator(chord, platform);
              if (accelerator) finish(accelerator);
            }
          }} />
        <div className="capture-key-caps" aria-hidden="true">{recording && !preview ? <span className="capture-key-placeholder">{ready ? labels.recording : labels.preparing}</span> : caps.length ? caps.map((key, index) => <kbd key={index}>{key}</kbd>) : <span className="capture-key-placeholder">{value ? labels.invalid : labels.disabled}</span>}</div>
      </div>
      <button type="button" className="capture-key-action" disabled={disabled || !value} aria-label={labels.clear + label} title={labels.clear} onClick={() => finish('')}><Icon name="close" size={14} /></button>
      <button type="button" className="capture-key-action" disabled={disabled || value === defaultValue} aria-label={labels.reset + label} title={labels.reset} onClick={() => finish(defaultValue)}><Icon name="undo" size={14} /></button>
    </div>
    {issue ? <p className="capture-key-error" role="alert">{issue}</p> : null}
  </div>;
}
