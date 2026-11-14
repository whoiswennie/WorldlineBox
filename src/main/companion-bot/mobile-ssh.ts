import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import path from 'node:path';
import { Server, utils, type Connection } from 'ssh2';
import { MOBILE_ACCESS_PORT, MOBILE_SSH_PORT } from '../../shared/mobile-access';
import type { MobileAccessSettings } from './mobile-access-settings';

async function hostKey(root: string): Promise<string> {
  const file = path.join(root, 'mobile-ssh-host.key');
  try { return await readFile(file, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const key = utils.generateKeyPairSync('ed25519').private;
  try { await writeFile(file, key, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') return readFile(file, 'utf8'); throw error; }
  return key;
}

export async function startMobileSsh(root: string, access: MobileAccessSettings, options?: { port?: number; targetPort?: number }) {
  const host = '127.0.0.1';
  const port = options?.port ?? MOBILE_SSH_PORT;
  const targetPort = options?.targetPort ?? MOBILE_ACCESS_PORT;
  const privateKey = await hostKey(root);
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error || Array.isArray(parsed)) throw new Error('无法读取移动服务的主机密钥。');
  const fingerprint = 'SHA256:' + createHash('sha256').update(parsed.getPublicSSH()).digest('base64').replace(/=+$/u, '');
  const clients = new Map<Connection, { device?: string; channels: number; authorized?: () => boolean }>();
  const server = new Server({ hostKeys: [privateKey], algorithms: { serverHostKey: ['ssh-ed25519'] } }, client => {
    client.on('error', () => undefined);
    if (clients.size >= 20) { client.end(); return; }
    const entry: { device?: string; channels: number; authorized?: () => boolean } = { channels: 0 };
    clients.set(client, entry);
    const handshake = setTimeout(() => client.end(), 20_000);
    client.once('close', () => { clearTimeout(handshake); clients.delete(client); });
    client.on('authentication', context => {
      if (context.method !== 'password') { context.reject(['password']); return; }
      const password = context.password;
      if (context.username === 'pair' && access.canPair(password)) {
        entry.authorized = () => access.canPair(password);
      } else if (context.username === 'mobile') {
        const token = `Bearer ${password}`;
        entry.device = access.authenticate(token);
        entry.authorized = entry.device ? () => !!access.authenticate(token) : undefined;
      }
      if (!entry.authorized) { context.reject(['password']); return; }
      context.accept();
    });
    client.once('ready', () => {
      clearTimeout(handshake);
      client.on('session', (_accept, reject) => reject());
      client.on('tcpip', (accept, reject, info) => {
        if (info.destIP !== host || info.destPort !== MOBILE_ACCESS_PORT || entry.channels >= 8 || !entry.authorized?.()) {
          reject(); return;
        }
        entry.channels++;
        const upstream = connect(targetPort, '127.0.0.1');
        let channel: ReturnType<typeof accept> | undefined;
        upstream.once('connect', () => {
          if (!entry.authorized?.()) { reject(); upstream.destroy(); return; }
          channel = accept();
          channel.on('error', () => upstream.destroy());
          channel.once('close', () => upstream.destroy());
          channel.pipe(upstream).pipe(channel);
        });
        upstream.once('error', () => { if (channel) channel.destroy(); else reject(); });
        upstream.once('close', () => { entry.channels--; channel?.end(); });
      });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', () => undefined);
  return { host, fingerprint, sshPort: (server.address() as { port: number }).port,
    close() { for (const client of clients.keys()) client.end(); server.close(); },
    disconnect(id: string) { for (const [client, entry] of clients) if (entry.device === id) client.end(); },
  };
}
