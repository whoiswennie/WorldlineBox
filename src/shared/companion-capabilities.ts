/** Bounded host facts; native plugin descriptions are fetched only on demand. */
export interface BotCapabilityState {
  mode: 'shared' | 'private';
  configured: boolean;
  instanceId?: string;
  runtimeVersion?: string;
  status?: string;
  revision: string;
  keepAlive?: boolean;
}
