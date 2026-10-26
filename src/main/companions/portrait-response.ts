import { companionIdSchema } from '../../shared/companions';
import type { CompanionOwnerImage } from './public-profiles';

/** This route accepts owner identity and a role, never a caller-supplied path. */
export async function companionPortraitResponse(request: Request, read: (ownerId: string, role: 'avatar' | 'orthographic') => Promise<CompanionOwnerImage | undefined>): Promise<Response> {
  try {
    const url = new URL(request.url), parts = url.pathname.split('/');
    if (url.protocol !== 'worldlinebox-companion:' || url.hostname !== 'portrait' || url.username || url.password || url.port || url.hash || parts.length !== 3
      || !['GET', 'HEAD'].includes(request.method) || [...url.searchParams.keys()].sort().join(',') !== 'r,v') return new Response(null, { status: 404 });
    const owner = companionIdSchema.parse(decodeURIComponent(parts[1]!)), role = parts[2];
    const hash = url.searchParams.get('v'), revision = url.searchParams.get('r');
    if ((role !== 'avatar' && role !== 'orthographic') || !hash || !revision || !/^[a-f0-9]{64}$/u.test(hash) || !/^[a-f0-9]{64}$/u.test(revision)) return new Response(null, { status: 404 });
    const image = await read(owner, role);
    if (!image || image.sha256 !== hash || image.fileRevision !== revision) return new Response(null, { status: 404 });
    return new Response(request.method === 'HEAD' ? null : new Uint8Array(image.bytes), { headers: { 'Content-Type': image.mime,
      'Content-Length': String(image.bytes.length), 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "default-src 'none'; sandbox" } });
  } catch { return new Response(null, { status: 404 }); }
}
