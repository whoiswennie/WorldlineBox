/** Host-resolved public character settings. Paths are real local files, never provider image URLs. */
export interface CompanionPublicImage {
  absolutePath: string;
  mime: string;
  sha256?: string;
  available: boolean;
}
export interface CompanionPublicProfile {
  id: string;
  name: string;
  kind: 'human_player' | 'companion';
  description: string;
  revision?: number;
  avatar?: CompanionPublicImage;
  orthographic?: CompanionPublicImage;
}
/** Ephemeral pixels for one inference. Never store them in messages or loop checkpoints. */
export interface CompanionVisualInput {
  personId: string;
  role: 'avatar' | 'orthographic';
  mime: 'image/jpeg' | 'image/png' | 'image/webp';
  base64: string;
  sha256: string;
}
export interface CompanionProfileInput {
  publicProfiles: readonly CompanionPublicProfile[];
  visualInputs: readonly CompanionVisualInput[];
}
