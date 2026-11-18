import { createHash } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { getResponder } from '@homebridge/ciao';
import type { startMobilePublicTunnel } from './mobile-public-tunnel';

function interfaces() {
  return Object.values(networkInterfaces()).flatMap(entries =>
    (entries ?? []).filter(entry => entry.family === 'IPv4' && !entry.internal));
}

export function localAddresses() {
  const addresses = [...new Set(interfaces().map(entry => entry.address))];
  return addresses.sort((a, b) => Number(a.startsWith('169.254.')) - Number(b.startsWith('169.254.')));
}

export function isLocalPeer(ip: string) {
  if (ip === '127.0.0.1') return true;
  const bytes = ip.split('.').map(Number);
  return bytes.length === 4 && interfaces().some(({ address, netmask }) => {
    if (netmask === '0.0.0.0') return false;
    const mask = netmask.split('.').map(Number);
    return address.split('.').every((part, i) => (Number(part) & mask[i]!) === (bytes[i]! & mask[i]!));
  });
}

// Discovery provides a location hint. SSH verifies the full pinned host key.
export function advertiseMobileSsh(fingerprint: string, port: number) {
  const responder = getResponder();
  const id = createHash('sha256').update(fingerprint).digest('hex').slice(0, 24);
  const service = responder.createService({ name: 'wlb-' + id, type: 'worldlinebox', port, disabledIpv6: true });
  void service.advertise().catch(() => undefined);
  return () => { void service.destroy().finally(() => responder.shutdown()).catch(() => undefined); };
}

// Keep a failing or restarting public tunnel independent of the LAN listener.
export function maintainPublicTunnel(start: (signal: AbortSignal) => ReturnType<typeof startMobilePublicTunnel>) {
  const controller = new AbortController();
  let tunnel: Awaited<ReturnType<typeof startMobilePublicTunnel>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let retry = 5_000;
  let failed = false;
  async function check() {
    if (!tunnel?.alive()) {
      tunnel?.close();
      tunnel = undefined;
      try {
        const opened = await start(controller.signal);
        if (controller.signal.aborted) { opened.close(); return; }
        tunnel = opened;
        failed = false;
        retry = 5_000;
      } catch { failed = true; }
    }
    if (controller.signal.aborted) return;
    timer = setTimeout(() => void check(), retry);
    timer.unref();
    if (!tunnel) retry = Math.min(retry * 2, 60_000);
  }
  void check();
  return {
    get current() { return tunnel?.alive() ? tunnel : undefined; },
    get status() { return this.current ? 'ready' as const : failed ? 'unavailable' as const : 'connecting' as const; },
    close() { controller.abort(); clearTimeout(timer); tunnel?.close(); },
  };
}
