import { useEffect, useState } from 'react';
import type { MobileSettingsRequest, MobileSettingsResult, MobileSettingsState, WorldlineBoxMobileAccessApi } from '../shared/mobile-access';
import { Icon } from './Icons';
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
      if (active && result.state) { setState(result.state); setPairing(result.pairing); }
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
      setPairing(result.pairing);
      if (input.type === 'pair.cancel' || input.type === 'service' && !input.enabled) setPairing(undefined);
      if (input.type === 'device.remove') setRemoveId(undefined);
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : zh ? '操作失败。' : 'The operation failed.');
    } finally { setBusy(false); }
  }

  return <div className="mobile-access-settings">
    <section className="mobile-access-card">
      <div className="mobile-access-row">
        <div className="mobile-access-heading"><span className="mobile-access-symbol"><Icon name="link" size={22} /></span>
          <div><h3>{zh ? '手机连接' : 'Phone connection'}</h3>
          <p>{zh ? '同一局域网自动直连，外出时使用远程地址。' : 'Connect directly at home or use the remote address when away.'}</p></div></div>
        <button type="button" disabled={!api || !state || busy} onClick={() => void request({ type: 'service', enabled: !state?.enabled })}>
          {state?.enabled ? zh ? '关闭服务' : 'Stop service' : zh ? '开启服务' : 'Start service'}
        </button>
      </div>
      {state?.enabled && <div className="mobile-access-routes">
        <span data-ready={!!state.lanReady}>{zh ? '局域网' : 'Local network'} · {state.lanReady ? zh ? '可连接' : 'Ready' : zh ? '等待网络' : 'Waiting for network'}</span>
        <span data-ready={state.remoteStatus === 'ready'}>{zh ? '远程' : 'Remote'} · {state.remoteStatus === 'ready' ? zh ? '可连接' : 'Ready' : state.remoteStatus === 'connecting' ? zh ? '连接中' : 'Connecting' : zh ? '暂不可用' : 'Unavailable'}</span>
      </div>}
      {(error || state?.error) && <p role="alert" className="mobile-access-error">{error || state?.error}</p>}
      <div className="mobile-access-actions"><button className="mobile-access-scan" disabled={!state || busy} type="button" onClick={() => void request({ type: 'pair' })}>
        <Icon name="scan-qr-code" />{pairing ? zh ? '刷新二维码' : 'Refresh QR code' : zh ? '显示配对二维码' : 'Show pairing QR code'}
      </button>{pairing && <button type="button" disabled={busy} onClick={() => void request({ type: 'pair.cancel' })}>{zh ? '收起二维码' : 'Hide QR code'}</button>}</div>
      {pairing && <div className="mobile-access-pairing">
        <img alt={zh ? '手机配对二维码' : 'Phone pairing QR code'} src={pairing.image} width={288} height={288} />
        <div><strong>{zh ? '用手机 App 扫码' : 'Scan in the mobile app'}</strong>
          <p>{zh ? '二维码五分钟内有效。已配对的手机可以用它更新远程地址。' : 'Valid for five minutes. A paired phone can scan to update its remote address.'}</p>
          {state?.remoteStatus !== 'ready' && <p>{zh ? '当前二维码仅支持局域网，远程入口就绪后会自动更新。' : 'LAN only for now. This code updates when the remote address is ready.'}</p>}</div>
      </div>}
    </section>
    <section className="mobile-access-card">
      <h3>{zh ? '已配对设备' : 'Paired devices'}</h3>
      {!state?.devices.length && <p>{zh ? '暂无设备' : 'No paired devices'}</p>}
      {state?.devices.slice().sort((a, b) => Number(b.connected) - Number(a.connected) || b.createdAt.localeCompare(a.createdAt)).map(device => <div className="mobile-access-row mobile-access-device" key={device.id}>
        <div className="mobile-device-identity"><strong>{device.name}</strong>
          <span className="mobile-device-status" data-online={device.connected}>{device.paused ? zh ? '已暂停' : 'Paused' : device.connected ? zh ? '在线' : 'Online' : zh ? '离线' : 'Offline'}</span>
          <p>{device.lastSeen && !device.connected ? zh ? '上次在线' : 'Last seen' : zh ? '配对于' : 'Paired'} {new Date(device.lastSeen && !device.connected ? device.lastSeen : device.createdAt).toLocaleString(zh ? 'zh-CN' : 'en')} · {device.id.slice(0, 6)}</p></div>
        <div className="mobile-access-actions">
          <button type="button" role="switch" aria-checked={!!device.pushEnabled} className="mobile-push-toggle"
            disabled={busy || !device.pushEnabled && (!device.connected || !device.supportsPush || device.paused)}
            title={!device.connected ? zh ? '手机在线时可开启' : 'Connect the phone to enable' : !device.supportsPush ? zh ? '请更新手机端' : 'Update the mobile app' : undefined}
            onClick={() => void request({ type: 'device.push', id: device.id, enabled: !device.pushEnabled })}>
            <i aria-hidden="true" />{zh ? '信息推送' : 'Message alerts'}
          </button>
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
