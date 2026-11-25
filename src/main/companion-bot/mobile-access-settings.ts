import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import QRCode from 'qrcode';
import { MOBILE_ACCESS_PORT, mobileDeviceName, mobileToken, type MobileEndpointMode, type MobileSettingsRequest, type MobileSettingsResult } from '../../shared/mobile-access';

const deviceSchema = z.object({ id: z.string().uuid(), name: mobileDeviceName, createdAt: z.string(), hash: mobileToken, paused: z.boolean(), released: z.boolean().optional(), remoteAddress: z.string().optional(), lastSeen: z.string().optional(), pushAfter: z.number().int().nonnegative().optional() });
const storageSchema = z.object({ enabled: z.boolean(), remoteEnabled: z.boolean().optional(), hostName: mobileDeviceName.optional(), devices: z.array(deviceSchema).max(32) });
type StoredState = z.infer<typeof storageSchema>;
type Listener = { rename?(name: string): void; setRemote?(enabled: boolean): void; host: string; sshPort: number; fingerprint: string; transport?: 'wss'; lan?: { hosts: string[]; port: number }; remoteStatus?: 'connecting' | 'unavailable' | 'ready'; endpointMode?: MobileEndpointMode; alive?(): boolean; close(): void; disconnect(id: string): void; connected(id: string): boolean; supportsPush?(id: string): boolean; pushChanged?(id: string): void; publicationHead?(): Promise<number> };
const sha = (value: string | Buffer) => createHash('sha256').update(value);
const retryInterval = 5_000;

export class MobileAccessSettings {
  private state: StoredState = { enabled: true, remoteEnabled: false, devices: [] };
  private pending?: { code?: string; payload?: string; image?: string; hash: Buffer; expires: number; redeemedToken?: string };
  private listener?: Listener;
  private error?: string;
  private readonly lastCheckpoint = new Map<string, number>();
  private readonly lastSeen = new Map<string, string>();
  private queue: Promise<unknown> = Promise.resolve();
  private monitor?: ReturnType<typeof setTimeout>;
  private closed = false;
  private readonly file: string;

  constructor(root: string, private readonly start: (access: MobileAccessSettings) => Promise<Listener>,
    private readonly renderQr = (text: string) => QRCode.toDataURL(text, { errorCorrectionLevel: 'M', width: 320, margin: 4 }),
    private readonly fixedEndpoint = false) {
    this.file = path.join(root, 'mobile-devices.json');
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work);
    this.queue = result.catch(() => undefined);
    return result;
  }

  initialize() {
    return this.serialize(async () => {
      try {
        this.state = storageSchema.parse(JSON.parse(await readFile(this.file, 'utf8')));
        this.state.remoteEnabled ??= this.state.enabled;
        this.state.enabled = true;
        for (const device of this.state.devices) if (device.lastSeen) this.lastSeen.set(device.id, device.lastSeen);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          this.error = '无法读取已配对设备配置。';
          throw error;
        }
      }
      if (this.state.enabled) {
        await this.listen();
        this.scheduleMonitor();
      }
    });
  }

  private async listen() {
    if (this.listener?.alive && !this.listener.alive()) {
      this.listener.close();
      this.listener = undefined;
      this.pending = undefined;
    }
    if (this.listener || this.closed) return this.listener;
    try {
      const listener = await this.start(this);
      if (this.closed) listener.close();
      else this.listener = listener;
      this.error = undefined;
      return this.listener;
    } catch (error) {
      this.error = error instanceof Error && /^(跨网|公网|远程|无法自动)/u.test(error.message) ? error.message : '移动服务无法启动，请检查本机端口是否被占用。';
    }
  }

  private scheduleMonitor(delay = retryInterval) {
    if (this.monitor || this.closed || !this.state.enabled || (this.listener && !this.listener.alive)) return;
    this.monitor = setTimeout(() => {
      this.monitor = undefined;
      void this.serialize(async () => {
        if (!this.state.enabled || this.closed) return;
        await this.listen();
        this.scheduleMonitor(this.listener ? retryInterval : Math.min(delay * 2, 60_000));
      });
    }, delay);
    this.monitor.unref();
  }

  private stopMonitoring() {
    clearTimeout(this.monitor);
    this.monitor = undefined;
  }

  private async save(state: StoredState) {
    const file = this.file + '.' + randomUUID() + '.tmp';
    try {
      await writeFile(file, JSON.stringify(state), { mode: 0o600, flag: 'wx' });
      await rename(file, this.file);
      this.state = state;
    } finally {
      await rm(file, { force: true });
    }
  }

  get hostName() { return this.state.hostName ?? hostname(); }
  get remoteEnabled() { return this.state.remoteEnabled ?? false; }

  remoteHost() {
    return this.listener?.transport === 'wss' ? this.listener.host : undefined;
  }

  private async currentPairing() {
    const pending = this.pending;
    const listener = this.listener;
    if (pending && pending.expires <= Date.now()) { this.pending = undefined; return undefined; }
    if (!pending?.code || !listener) return undefined;
    const { host, sshPort, fingerprint, transport, lan } = listener;
    if (lan && !lan.hosts.length && !transport) return undefined;
    const payload = JSON.stringify({ protocol: 2, host, sshPort, fingerprint, apiPort: MOBILE_ACCESS_PORT, code: pending.code, transport, lan });
    if (!pending.image || pending.payload !== payload) {
      pending.image = await this.renderQr(payload);
      pending.payload = payload;
    }
    return { image: pending.image, expiresAt: new Date(pending.expires).toISOString() };
  }

  private staleAddress(device: StoredState['devices'][number]) {
    const current = this.remoteHost();
    return !!current && !!device.remoteAddress && device.remoteAddress !== current;
  }

  private snapshot() {
    return { hostName: this.hostName, remoteEnabled: this.remoteEnabled, enabled: this.state.enabled, running: !!this.listener && (this.listener.alive?.() ?? true),
      lanReady: !!this.listener?.lan?.hosts.length, remoteStatus: this.listener?.remoteStatus,
      endpointMode: this.listener?.endpointMode ?? (this.fixedEndpoint ? 'fixed' as const : undefined), error: this.error,
      devices: this.state.devices.map(device => { const { id, name, createdAt, paused, pushAfter, released } = device; return { id, name, createdAt, paused, released, staleAddress: this.staleAddress(device),
        pushEnabled: pushAfter !== undefined, supportsPush: this.listener?.supportsPush?.(id) ?? false,
        connected: this.online(id), lastSeen: this.lastSeen.get(id) }; }) };
  }

  private online(id: string) {
    const last = this.lastSeen.get(id);
    return !!this.listener?.connected(id) && !!last && Date.now() - Date.parse(last) < 55_000;
  }

  pushAfter(id: string) { return this.state.devices.find(device => device.id === id)?.pushAfter; }

  request(input: MobileSettingsRequest): Promise<MobileSettingsResult> {
    return this.serialize(async () => {
      if (this.closed) throw new Error('移动服务正在关闭。');
      let cleaned: number | undefined;
      if (input.type === 'device.cleanup') {
        cleaned = this.state.devices.filter(device => device.released || this.staleAddress(device)).length;
        if (cleaned) {
          const removed = this.state.devices.filter(device => device.released);
          await this.save({ ...this.state, devices: this.state.devices.filter(device => !device.released)
            .map(device => this.staleAddress(device) ? { ...device, remoteAddress: undefined } : device) });
          for (const device of removed) { this.lastSeen.delete(device.id); this.lastCheckpoint.delete(device.id); }
        }
      }
      if (input.type === 'remote') {
        await this.save({ ...this.state, remoteEnabled: input.enabled });
        this.listener?.setRemote?.(input.enabled);
      }
      if (input.type === 'host.rename') {
        await this.save({ ...this.state, hostName: mobileDeviceName.parse(input.name) });
        this.listener?.rename?.(this.hostName);
      }
      if (input.type === 'pair.cancel') this.pending = undefined;
      if (input.type === 'pair') {
        const listener = await this.listen();
        if (!listener) throw new Error(this.error ?? '移动服务未开启。');
        const code = randomBytes(32).toString('hex');
        const expires = Date.now() + 5 * 60_000;
        this.pending = { code, hash: sha(code).digest(), expires };
      }
      if (input.type === 'device.push') {
        const device = this.state.devices.find(item => item.id === input.id);
        if (!device) throw new Error('设备不存在。');
        if (input.enabled && device.pushAfter === undefined) {
          if (device.paused || !this.online(device.id) || !this.listener?.supportsPush?.(device.id) || !this.listener.publicationHead) throw new Error('请先在手机上打开支持信息推送的 App，并连接这台电脑。');
          const pushAfter = await this.listener.publicationHead();
          await this.save({ ...this.state, devices: this.state.devices.map(item => item.id === device.id ? { ...item, pushAfter } : item) });
        } else if (!input.enabled) {
          await this.save({ ...this.state, devices: this.state.devices.map(item => item.id === device.id ? { ...item, pushAfter: undefined } : item) });
        }
        this.listener?.pushChanged?.(device.id);
      } else if (input.type.startsWith('device.') && 'id' in input) {
        const device = this.state.devices.find(item => item.id === input.id);
        if (!device) throw new Error('设备不存在。');
        const devices = input.type === 'device.remove' ? this.state.devices.filter(item => item.id !== input.id)
          : this.state.devices.map(item => item.id === input.id ? { ...item, paused: input.type === 'device.pause' } : item);
        await this.save({ ...this.state, devices });
        if (input.type !== 'device.resume') this.listener?.disconnect(input.id);
        if (input.type === 'device.remove') { this.lastSeen.delete(input.id); this.lastCheckpoint.delete(input.id); }
      }
      return { ok: true, cleaned, state: this.snapshot(), pairing: await this.currentPairing() };
    });
  }

  redeem(code: string, token: string, name: string): Promise<boolean> {
    return this.serialize(async () => {
      const hash = sha(token).digest('hex');
      if (this.closed || !this.listener || !this.state.enabled) return false;
      if (!this.pending || this.pending.expires <= Date.now() || !timingSafeEqual(this.pending.hash, sha(code).digest())) return false;
      if (this.pending.redeemedToken) return this.pending.redeemedToken === hash && this.state.devices.some(item => item.hash === hash && !item.paused && !item.released);
      if (!await this.addDevice(hash, name)) return false;
      if (this.pending) this.pending = { hash: this.pending.hash, expires: this.pending.expires, redeemedToken: hash };
      return true;
    });
  }

  private async addDevice(hash: string, name: string) {
    if (this.closed || !this.listener || this.state.devices.length >= 32 || this.state.devices.some(item => item.hash === hash)) return false;
    await this.save({ ...this.state, devices: [...this.state.devices, { id: randomUUID(), name, createdAt: new Date().toISOString(), hash, paused: false, remoteAddress: this.remoteHost() }] });
    return true;
  }

  enrollApprovedPhone(token: string, name: string, signal: AbortSignal) {
    return this.serialize(async () => !signal.aborted && mobileToken.safeParse(token).success &&
      mobileDeviceName.safeParse(name).success && await this.addDevice(sha(token).digest('hex'), name));
  }

  canPair(code: string): boolean {
    return !!this.pending && this.state.enabled && !this.closed && this.pending.expires > Date.now() &&
      mobileToken.safeParse(code).success && timingSafeEqual(this.pending.hash, sha(code).digest());
  }

  authenticate(header: string | undefined): string | undefined {
    if (this.closed || !this.state.enabled || !header?.startsWith('Bearer ') || !mobileToken.safeParse(header.slice(7)).success) return;
    const digest = sha(header.slice(7)).digest();
    const device = this.state.devices.find(item => timingSafeEqual(Buffer.from(item.hash, 'hex'), digest));
    if (!device || device.paused || device.released) return;
    const now = Date.now(), lastSeen = new Date(now).toISOString();
    this.lastSeen.set(device.id, lastSeen);
    if (now - (this.lastCheckpoint.get(device.id) ?? 0) > 5 * 60_000) {
      this.lastCheckpoint.set(device.id, now);
      void this.serialize(async () => {
        if (this.closed || !this.state.devices.some(item => item.id === device.id)) return;
        await this.save({ ...this.state, devices: this.state.devices.map(item => item.id === device.id ? { ...item, lastSeen } : item) });
      }).catch(() => this.lastCheckpoint.delete(device.id));
    }
    return device.id;
  }

  // Positive proof for a pinned phone. Paused devices still own a valid pairing.
  confirmsUnpaired(token: string) {
    if (!this.state.enabled || this.closed || !mobileToken.safeParse(token).success) return false;
    const hash = sha(token).digest('hex');
    return !this.state.devices.some(device => !device.released && device.hash === hash);
  }

  async advertisedRemote(id: string) {
    const address = this.remoteHost();
    if (address && this.state.devices.some(device => device.id === id && device.remoteAddress !== address)) {
      await this.serialize(async () => {
        if (this.closed) return;
        await this.save({ ...this.state, devices: this.state.devices.map(device => device.id === id ? { ...device, remoteAddress: address } : device) });
      });
    }
    return address;
  }

  releaseDevice(id: string) {
    return this.serialize(async () => {
      await this.save({ ...this.state, devices: this.state.devices.map(device =>
        device.id === id ? { ...device, released: true, pushAfter: undefined } : device) });
    });
  }

  deviceName(id: string) {
    return this.state.devices.find(device => device.id === id)?.name;
  }

  renameDevice(id: string, name: string) {
    return this.serialize(async () => {
      const devices = this.state.devices.map(device => device.id === id ? { ...device, name } : device);
      await this.save({ ...this.state, devices });
    });
  }

  close() {
    this.closed = true;
    this.stopMonitoring();
    this.pending = undefined;
    this.listener?.close();
    this.listener = undefined;
  }
}
