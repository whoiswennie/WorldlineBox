import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { EmbeddingDeviceCapability } from '../shared/embedding/device-capability';
import type { LibraryApiResult } from '../shared/library-api';
import type { WorldGraphicsCapability } from '../shared/world-graphics-capability';
import { checkWorldGraphicsCapability, getWorldGraphicsCapability, subscribeWorldGraphicsCapability } from './device-capabilities/world-graphics-probe';
import { useLocale } from './i18n';
import { Icon, type IconName } from './Icons';
import { Button } from './ui/primitives';
import './device-capability-settings.css';

export interface DeviceCapabilitySettingsApi {
  embeddingDeviceStatus(): Promise<LibraryApiResult<EmbeddingDeviceCapability>>;
  embeddingDeviceTest(input?: { force?: boolean }): Promise<LibraryApiResult<EmbeddingDeviceCapability>>;
  embeddingDeviceCancel(): Promise<LibraryApiResult<EmbeddingDeviceCapability>>;
  deviceHardwareStatus(): Promise<LibraryApiResult<{ totalMemoryBytes: number; availableMemoryBytes: number }>>;
}

const stateLabels = {
  'zh-CN': { unchecked: '未检测', testing: '检测中', supported: '可以使用', unsupported: '设备受限', error: '检测未完成' },
  en: { unchecked: 'Not checked', testing: 'Checking', supported: 'Available', unsupported: 'Device limited', error: 'Check incomplete' },
};
const statusIcon = (state: string): IconName => state === 'testing' ? 'clock' : state === 'supported' ? 'check' : state === 'unchecked' ? 'info' : 'alert-circle';

function checkedTime(value: string | undefined, locale: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return '';
  return new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
}

function worldMessage(value: WorldGraphicsCapability | undefined, zh: boolean) {
  if (!value) return zh ? '检查当前图形环境，确认能否打开伙伴的 3D 世界。' : 'Check the graphics environment before opening the 3D world.';
  if (value.status === 'available') return zh ? '图形环境通过基础检查，进入世界时按需加载场景。' : 'Basic graphics checks passed. The scene loads when opened.';
  if (zh) return value.reason ?? '当前设备暂时无法打开 3D 画面。';
  if (value.reasonCode === 'memory_insufficient') return `The reported memory is below ${value.minimumMemoryGiB} GiB.`;
  if (value.reasonCode === 'context_lost') return 'The graphics context is unavailable. Please retry later.';
  if (value.reasonCode === 'probe_failed') return 'The graphics check could not finish. Please retry.';
  return 'WebGL 2 is unavailable. Check your graphics driver and hardware acceleration.';
}

function embeddingMessage(value: EmbeddingDeviceCapability | undefined, zh: boolean) {
  if (zh && value?.message) return value.message;
  if (value?.state === 'supported') return value.backend === 'gpu' ? 'The bundled model passed a short test on this GPU.' : 'The bundled model passed a short CPU test.';
  if (value?.state === 'testing') return 'Testing a few short texts and a small image. You can cancel.';
  if (value?.state === 'unsupported') return value.reason === 'memory_pressure' ? 'There is not enough available memory for this model.' : 'The current device did not meet the runtime budget.';
  if (value?.state === 'error') return 'The device test did not finish. You can retry.';
  return zh ? '文件就绪后仍需检测设备，确认本机能否稳定运行向量模型。' : 'Check the device to confirm it can run the bundled model reliably.';
}

/** Opening Settings only reads the cached result. Inference requires the explicit test action. */
export function DeviceCapabilitySettings({ api }: { api?: Partial<DeviceCapabilitySettingsApi> }) {
  const { locale } = useLocale();
  const zh = locale === 'zh-CN';
  const [snapshot, setSnapshot] = useState<{ api: typeof api; value: EmbeddingDeviceCapability }>();
  const [operation, setOperation] = useState<'test' | 'cancel' | null>(null);
  const [readError, setReadError] = useState('');
  const [worldChecking, setWorldChecking] = useState(false);
  const world = useSyncExternalStore(subscribeWorldGraphicsCapability, getWorldGraphicsCapability, getWorldGraphicsCapability);
  const requestVersion = useRef(0);
  const mounted = useRef(true);
  const capability = snapshot && snapshot.api === api ? snapshot.value : undefined;
  const state = capability?.state ?? 'unchecked';
  const testing = state === 'testing' || operation === 'test';

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!api?.embeddingDeviceStatus) return;
    let cancelled = false;
    const version = ++requestVersion.current;
    const read = async () => {
      try {
        const result = await api.embeddingDeviceStatus!();
        if (cancelled || version !== requestVersion.current) return;
        if (result.ok) { setSnapshot({ api, value: result.value }); setReadError(''); }
        else setReadError(zh ? '无法读取设备检测结果，请重新检测。' : 'Could not read the device result. Please retry.');
      } catch { if (!cancelled && version === requestVersion.current) setReadError(zh ? '无法读取设备检测结果，请重新检测。' : 'Could not read the device result. Please retry.'); }
    };
    void read();
    const timer = state === 'testing' ? setInterval(() => { void read(); }, 1_000) : undefined;
    return () => { cancelled = true; if (timer) clearInterval(timer); };
  }, [api, state, zh]);

  async function runEmbedding(action: 'test' | 'cancel') {
    if (operation || !api || (action === 'test' ? !api.embeddingDeviceTest : !api.embeddingDeviceCancel)) return;
    const version = ++requestVersion.current;
    setOperation(action); setReadError('');
    try {
      const result = action === 'test' ? await api.embeddingDeviceTest!({ force: true }) : await api.embeddingDeviceCancel!();
      if (!mounted.current || version !== requestVersion.current) return;
      if (result.ok) setSnapshot({ api, value: result.value });
      else setReadError(zh ? '设备检测未完成，请稍后重试。' : 'The device test could not finish. Please retry.');
    } catch { if (mounted.current && version === requestVersion.current) setReadError(zh ? '设备检测未完成，请稍后重试。' : 'The device test could not finish. Please retry.'); }
    finally { if (mounted.current && version === requestVersion.current) setOperation(null); }
  }

  async function runWorld() {
    if (worldChecking) return;
    setWorldChecking(true);
    let totalMemoryBytes: number | undefined;
    try { const result = await api?.deviceHardwareStatus?.(); if (result?.ok) totalMemoryBytes = result.value.totalMemoryBytes; } catch { /* WebGL can still be checked; unknown host memory is not zero. */ }
    if (mounted.current) { checkWorldGraphicsCapability({ totalMemoryBytes }); setWorldChecking(false); }
  }

  const worldState = worldChecking ? 'testing' : !world ? 'unchecked' : world.status === 'available' ? 'supported' : 'unsupported';
  const labels = stateLabels[zh ? 'zh-CN' : 'en'];
  const time = checkedTime(capability?.testedAt, locale);
  const worldTime = checkedTime(world?.checkedAt, locale);
  return <section className="device-capability-settings" aria-label={zh ? '设备能力' : 'Device capabilities'}>
    <div className="device-capability-settings__heading"><strong>{zh ? '设备能力' : 'Device capabilities'}</strong><span>{zh ? '分别检测，按需运行' : 'Independent checks · on demand'}</span></div>
    <article className="device-capability-settings__row" aria-label={zh ? '本地向量设备检测' : 'Local embedding device check'} aria-busy={testing}>
      <span className="device-capability-settings__icon" aria-hidden="true"><Icon name="layers" size={18} /></span>
      <div className="device-capability-settings__body">
        <div className="device-capability-settings__title"><strong>{zh ? '本地多模态向量' : 'Local multimodal embeddings'}</strong><span className="device-capability-settings__state" data-state={state} role="status"><Icon name={statusIcon(state)} size={12} />{labels[state]}</span></div>
        <p>{embeddingMessage(capability, zh)}</p>
        {state === 'testing' && capability?.stage && <p className="device-capability-settings__stage">{zh ? capability.stage : 'A short runtime check is in progress.'}</p>}
        {capability?.deviceName && <span className="device-capability-settings__detail">{capability.backend === 'gpu' ? 'GPU' : 'CPU'} · {capability.deviceName}</span>}
        {time && <span className="device-capability-settings__detail">{zh ? '检测于 ' : 'Checked '}{time}{capability?.cacheUsed ? (zh ? ' · 已保存的结果' : ' · Saved result') : ''}</span>}
        {(state === 'unsupported' || state === 'error') && <p className="device-capability-settings__limitation">{zh ? '向量功能暂不可用；普通资产全文搜索和已有文档查阅仍可使用。' : 'Vector features are unavailable. Full-text asset search and existing documents remain accessible.'}</p>}
        {readError && <p className="device-capability-settings__error" role="alert">{readError}</p>}
      </div>
      <div className="device-capability-settings__actions">{testing
        ? <Button size="sm" variant="quiet" disabled={!api?.embeddingDeviceCancel || operation !== null} loading={operation === 'cancel'} onClick={() => { void runEmbedding('cancel'); }}>{zh ? '取消' : 'Cancel'}</Button>
        : <Button size="sm" disabled={!api?.embeddingDeviceTest || operation !== null} onClick={() => { void runEmbedding('test'); }}>{capability?.testedAt ? (zh ? '重新检测' : 'Check again') : (zh ? '检测设备' : 'Check device')}</Button>}</div>
    </article>
    <article className="device-capability-settings__row" aria-label={zh ? '3D 世界设备检测' : '3D world device check'} aria-busy={worldChecking}>
      <span className="device-capability-settings__icon" aria-hidden="true"><Icon name="box" size={18} /></span>
      <div className="device-capability-settings__body">
        <div className="device-capability-settings__title"><strong>{zh ? '3D 世界画面' : '3D world graphics'}</strong><span className="device-capability-settings__state" data-state={worldState} role="status"><Icon name={statusIcon(worldState)} size={12} />{labels[worldState]}</span></div>
        <p>{worldMessage(world, zh)}</p>
        {worldTime && <span className="device-capability-settings__detail">{zh ? '检测于 ' : 'Checked '}{worldTime}{world?.memoryGiB !== undefined ? ` · ${world.memorySource === 'browser' ? (zh ? '约 ' : '~') : ''}${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(world.memoryGiB)} GiB` : ''}</span>}
        {worldState === 'unsupported' && <p className="device-capability-settings__limitation">{zh ? '3D 画面暂不可用；伙伴聊天与世界生活仍可继续。' : '3D graphics are unavailable. Companion chat and world life can continue.'}</p>}
      </div>
      <div className="device-capability-settings__actions"><Button size="sm" disabled={worldChecking} loading={worldChecking} onClick={() => { void runWorld(); }}>{world ? (zh ? '重新检测' : 'Check again') : (zh ? '检测设备' : 'Check device')}</Button></div>
    </article>
    <p className="device-capability-settings__hint"><Icon name="info" size={13} />{zh ? '向量检测会短暂运行内置模型；3D 只做基础图形检查。结果随设备环境变化可重新检测。' : 'Embedding checks briefly run the bundled model. 3D checks only inspect basic graphics support. Recheck after device changes.'}</p>
  </section>;
}
