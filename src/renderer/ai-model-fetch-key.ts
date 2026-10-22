import type { AiApiFormat } from "../shared/ai-endpoints";

export function buildAiModelsFetchKey(input: {
  profileId: string | null;
  apiFormat: AiApiFormat;
  baseUrl: string;
  apiKey: string;
  hasStoredKey: boolean;
}): string {
  const credential = input.apiKey.trim()
    ? ["typed", input.apiKey.trim()]
    : input.hasStoredKey
      ? ["stored"]
      : ["none"];

  return JSON.stringify([
    input.profileId,
    input.apiFormat,
    input.baseUrl.trim(),
    credential,
  ]);
}
