import type { AiApiFormat } from './ai-endpoints';

/** The user-level provider connection shared by browser and capture tools. */
export interface AiConnectionConfig {
  apiFormat: AiApiFormat;
  model: string;
  baseUrl?: string;
  apiKey: string;
}
