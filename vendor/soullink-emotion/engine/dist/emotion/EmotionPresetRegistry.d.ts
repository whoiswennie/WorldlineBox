import type { VADVector } from "./VADState";
export declare const neutralVAD: VADVector;
export declare const emotionVADPresets: Record<string, VADVector>;
export declare function getVADPreset(emotion: string, variant?: string): VADVector;
