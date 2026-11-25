import { z } from 'zod';

export const MOBILE_ACCESS_CHANNEL = 'mobile-access:settings';
export const MOBILE_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;
export const MOBILE_UPLOAD_CHUNK_BYTES = 1024 ** 2;
export const MOBILE_ACCESS_PORT = 47831;
export const MOBILE_SSH_PORT = 47832;
export const MOBILE_TUNNEL_ORIGIN_PORT = 47833;
export const mobileToken = z.string().regex(/^[a-f0-9]{64}$/u);
export const mobileDeviceName = z.string().trim().min(1).max(80).regex(/^[^\x00-\x1f\x7f]+$/u);

export const mobileSettingsRequest = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('state') }),
  z.strictObject({ type: z.literal('remote'), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('host.rename'), name: mobileDeviceName }),
  z.strictObject({ type: z.literal('pair') }),
  z.strictObject({ type: z.literal('pair.cancel') }),
  z.strictObject({ type: z.literal('device.cleanup') }),
  z.strictObject({ type: z.literal('device.push'), id: z.string().uuid(), enabled: z.boolean() }),
  z.strictObject({ type: z.literal('device.pause'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('device.resume'), id: z.string().uuid() }),
  z.strictObject({ type: z.literal('device.remove'), id: z.string().uuid() }),
]);

export type MobileSettingsRequest = z.infer<typeof mobileSettingsRequest>;
export interface MobileDeviceView { released?: boolean; staleAddress?: boolean; id: string; name: string; createdAt: string; lastSeen?: string; paused: boolean; connected: boolean; pushEnabled?: boolean; supportsPush?: boolean }
export type MobileEndpointMode = 'temporary' | 'fixed';
export interface MobileSettingsState { hostName?: string; remoteEnabled?: boolean; enabled: boolean; running: boolean; devices: MobileDeviceView[]; lanReady?: boolean; remoteStatus?: 'connecting' | 'ready' | 'unavailable'; endpointMode?: MobileEndpointMode; error?: string }
export interface MobileSettingsResult { cleaned?: number; ok: boolean; state?: MobileSettingsState; pairing?: { image: string; expiresAt: string }; error?: string }
export interface WorldlineBoxMobileAccessApi { request(input: MobileSettingsRequest): Promise<MobileSettingsResult> }
