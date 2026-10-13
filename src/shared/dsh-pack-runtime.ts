import { z } from 'zod';

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
export const dshPackRuntimeV1Schema = z.strictObject({ contentSha256: sha256, version: z.string().min(1).max(128),
  platform: z.literal('win32-x64'), adapter: z.enum(['desktop-cli-web-v1', 'node-cli-web-v1']) });
export const dshNodePackRuntimeLockSchema = dshPackRuntimeV1Schema.extend({ adapter: z.literal('node-cli-web-v1'),
  sourceSha256: sha256, npmIntegrity: z.string().regex(/^sha512-[A-Za-z0-9+/]{86}==$/), dependencyLockSha256: sha256,
  nodeVersion: z.string().regex(/^\d+\.\d+\.\d+$/), npmVersion: z.string().regex(/^\d+\.\d+\.\d+$/), nodeExecutableSha256: sha256, payloadSha256: sha256 });
export type DshNodePackRuntimeLock = z.infer<typeof dshNodePackRuntimeLockSchema>;
export type DshPackRuntimeV1 = z.infer<typeof dshPackRuntimeV1Schema>;
