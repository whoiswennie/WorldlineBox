import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import QRCode from 'qrcode';
import { MOBILE_ACCESS_PORT, mobileDeviceName, mobileToken, type MobileEndpointMode, type MobileSettingsRequest, type MobileSettingsResult } from '../../shared/mobile-access';

const deviceSchema = z.object({ id: z.string().uuid(), name: mobileDeviceName, createdAt: z.string(), hash: mobileToken, paused: z.boolean() });
const storageSchema = z.object({ enabled: z.boolean(), devices: z.array(deviceSchema).max(32) });
type StoredState = z.infer<typeof storageSchema>;
type Listener = { host: string; sshPort: number; fingerprint: string; transport?: 'wss'; endpointMode?: MobileEndpointMode; alive?(): boolean; close(): void; disconnect(id: string): void; connected(id: string): boolean };
const sha = (value: string | Buffer) => createHash('sha256').update(value);
const retryInterval = 5_000;

export class MobileAccessSettings {
  private state: StoredState = { enabled: false, devices: [] };
  private pending?: { hash: Buffer; expires: number; redeemedToken?: string };
  private listener?: Listener;
  private error?: string;
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
    if (this.monitor || this.closed || !this.state.enabled || !this.fixedEndpoint) return;
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

  private snapshot() {
    return { enabled: this.state.enabled, running: !!this.listener && (this.listener.alive?.() ?? true),
      endpointMode: this.listener?.endpointMode ?? (this.fixedEndpoint ? 'fixed' as const : undefined), error: this.error,
      devices: this.state.devices.map(({ id, name, createdAt, paused }) => ({ id, name, createdAt, paused,
        connected: this.listener?.connected(id) ?? false, lastSeen: this.lastSeen.get(id) })) };
  }

  request(input: MobileSettingsRequest): Promise<MobileSettingsResult> {
    return this.serialize(async () => {
      if (this.closed) throw new Error('移动服务正在关闭。');
      if (input.type === 'service') {
        await this.save({ ...this.state, enabled: input.enabled });
        if (input.enabled) {
          await this.listen();
          this.scheduleMonitor();
        }
        else { this.stopMonitoring(); this.listener?.close(); this.listener = undefined; this.pending = undefined; this.error = undefined; }
      }
      if (input.type === 'pair.cancel') this.pending = undefined;
      if (input.type === 'pair') {
        const listener = await this.listen();
        if (!listener) throw new Error(this.error ?? '移动服务未开启。');
        if (!this.state.enabled) {
          try { await this.save({ ...this.state, enabled: true }); }
          catch (error) { listener.close(); this.listener = undefined; throw error; }
          this.scheduleMonitor();
        }
        if (this.state.devices.length >= 32) throw new Error('已达到设备数量上限。');
        const code = randomBytes(32).toString('hex');
        const expires = Date.now() + 5 * 60_000;
        this.pending = { hash: sha(code).digest(), expires };
        const { host, sshPort, fingerprint, transport } = listener;
        const text = JSON.stringify({ protocol: 2, host, sshPort, fingerprint, apiPort: MOBILE_ACCESS_PORT, code, transport });
        const image = await this.renderQr(text);
        return { ok: true, state: this.snapshot(), pairing: { image, expiresAt: new Date(expires).toISOString() } };
      }
      if (input.type.startsWith('device.') && 'id' in input) {
        const device = this.state.devices.find(item => item.id === input.id);
        if (!device) throw new Error('设备不存在。');
        const devices = input.type === 'device.remove' ? this.state.devices.filter(item => item.id !== input.id)
          : this.state.devices.map(item => item.id === input.id ? { ...item, paused: input.type === 'device.pause' } : item);
        await this.save({ ...this.state, devices });
        if (input.type !== 'device.resume') this.listener?.disconnect(input.id);
        if (input.type === 'device.remove') this.lastSeen.delete(input.id);
      }
      return { ok: true, state: this.snapshot() };
    });
  }

  redeem(code: string, token: string, name: string): Promise<boolean> {
    return this.serialize(async () => {
      const hash = sha(token).digest('hex');
      if (this.closed || !this.listener || !this.state.enabled) return false;
      if (!this.pending || this.pending.expires <= Date.now() || !timingSafeEqual(this.pending.hash, sha(code).digest())) return false;
      if (this.pending.redeemedToken) return this.pending.redeemedToken === hash && this.state.devices.some(item => item.hash === hash && !item.paused);
      if (this.state.devices.length >= 32 || this.state.devices.some(item => item.hash === hash)) return false;
      await this.save({ ...this.state, devices: [...this.state.devices, { id: randomUUID(), name, createdAt: new Date().toISOString(), hash, paused: false }] });
      if (this.pending) this.pending.redeemedToken = hash;
      return true;
    });
  }

  canPair(code: string): boolean {
    return !!this.pending && this.state.enabled && !this.closed && this.pending.expires > Date.now() &&
      mobileToken.safeParse(code).success && timingSafeEqual(this.pending.hash, sha(code).digest());
  }

  authenticate(header: string | undefined): string | undefined {
    if (this.closed || !this.state.enabled || !header?.startsWith('Bearer ') || !mobileToken.safeParse(header.slice(7)).success) return;
    const digest = sha(header.slice(7)).digest();
    const device = this.state.devices.find(item => timingSafeEqual(Buffer.from(item.hash, 'hex'), digest));
    if (!device || device.paused) return;
    this.lastSeen.set(device.id, new Date().toISOString());
    return device.id;
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
