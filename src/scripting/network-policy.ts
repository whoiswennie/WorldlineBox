import { applyNodeNetworkEnvironment, networkEnvironmentMessageSchema } from '../shared/network-environment';

/** Only the owning Main process can send this control envelope over parentPort. */
export function receiveRuntimeNetworkPolicy(message: unknown): boolean {
  const update = networkEnvironmentMessageSchema.safeParse(message);
  if (!update.success) return false;
  applyNodeNetworkEnvironment(update.data.environment);
  return true;
}
