import { useEffect, useState } from 'react';
import type { MobileSettingsRequest, MobileSettingsResult, MobileSettingsState, WorldlineBoxMobileAccessApi } from '../shared/mobile-access';
import { useLocale } from './i18n';
import './mobile-access-settings.css';

export function MobileAccessSettingsPage({ api }: { api?: WorldlineBoxMobileAccessApi }) {
  const zh = useLocale().locale === 'zh-CN';
  const [state, setState] = useState<MobileSettingsState>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pairing, setPairing] = useState<MobileSettingsResult['pairing']>();
  const [removeId, setRemoveId] = useState<string>();

  useEffect(() => {
    if (!api) return;
    let active = true;
    const refresh = () => { void api.request({ type: 'state' }).then(result => {
      if (active && result.state) setState(result.state);
    }).catch(() => { if (active) setError(zh ? '无法读取连接状态。' : 'Could not read connection status.'); }); };
    refresh();
    const timer = window.setInterval(refresh, 2500);
    return () => { active = false; window.clearInterval(timer); };
  }, [api, zh]);

  async function request(input: MobileSettingsRequest) {
    if (!api) return;
    setBusy(true); setError('');
    try {
      const result = await api.request(input);
      if (!result.ok) throw new Error(result.error);
      if (result.state) setState(result.state);
      if (result.pairing) setPairing(result.pairing)
      if (input.type === 'pair.cancel' || input.type === 'service' && !input.enabled) setPairing(undefined);
      if (input.type === 'device.remove') setRemoveId(undefined);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : zh ? '操作失败。' : 'The operation failed.');
    } finally { setBusy(false); }
  }

  return <div className="mobile-access-settings">
    <section className="mobile-access-card">
      <div className="mobile-access-row">
        <div><h3>{zh ? '远程连接' : 'Remote access'}</h3><p>{state?.running ? zh ? '运行中' : 'Running' : zh ? '移动服务已停止' : 'Mobile service is stopped'}</p></div>
        <button type="button" disabled={!api || !state || busy} onClick={() => void request({ type: 'service', enabled: !state?.running })}>
          {state?.running ? zh ? '关闭服务' : 'Stop service' : zh ? '开启服务' : 'Start service'}
        </button>
      </div>
      <p>{zh ? '用世界线盒子手机 App 扫码连接。' : 'Scan with the WorldlineBox mobile app.'}</p>
      {state?.endpointMode === 'temporary' && <p>{zh ? '当前使用测试入口，重启远程服务后需要重新扫码。' : 'This test endpoint requires pairing again after a service restart.'}</p>}
      {(error || state?.error) && <p role="alert" className="mobile-access-error">{error || state?.error}</p>}
    </section>
    <section className="mobile-access-card">
      <h3>{zh ? '配对手机' : 'Pair a phone'}</h3>
      <div className="mobile-access-actions"><button disabled={!state || busy} type="button" onClick={() => void request({ type: 'pair' })}>
        {zh ? '显示配对二维码' : 'Show pairing QR code'}
      </button>{pairing && <button type="button" disabled={busy} onClick={() => void request({ type: 'pair.cancel' })}>{zh ? '取消配对' : 'Cancel pairing'}</button>}</div>
      {pairing && <div className="mobile-access-pairing">
        <img alt={zh ? '手机配对二维码' : 'Phone pairing QR code'} src={pairing.image} width={244} height={244} />
        <p>{zh ? '打开手机 App 扫码。二维码五分钟内有效，可配对一台设备。' : 'Scan in the mobile app. This code pairs one device and expires after five minutes.'}</p>
      </div>}
    </section>
    <section className="mobile-access-card">
      <h3>{zh ? '已配对设备' : 'Paired devices'}</h3>
      {!state?.devices.length && <p>{zh ? '暂无设备' : 'No paired devices'}</p>}
      {state?.devices.map(device => <div className="mobile-access-row mobile-access-device" key={device.id}>
        <div><strong>{device.name}</strong><p>{device.paused ? zh ? '已断开' : 'Disconnected' : device.connected ? zh ? '会话已连接' : 'Session connected' : zh ? '当前无会话' : 'No active session'}</p></div>
        <div className="mobile-access-actions">
          <button type="button" disabled={busy} onClick={() => void request({ type: device.paused ? 'device.resume' : 'device.pause', id: device.id })}>
            {device.paused ? zh ? '允许重连' : 'Allow reconnect' : zh ? '断开连接' : 'Disconnect'}
          </button>
          {removeId === device.id ? <><button type="button" disabled={busy} onClick={() => void request({ type: 'device.remove', id: device.id })}>{zh ? '确认删除' : 'Confirm removal'}</button><button type="button" onClick={() => setRemoveId(undefined)}>{zh ? '取消' : 'Cancel'}</button></>
            : <button type="button" disabled={busy} onClick={() => setRemoveId(device.id)}>{zh ? '删除设备' : 'Remove device'}</button>}
        </div>
      </div>)}
    </section>
  </div>;
}
