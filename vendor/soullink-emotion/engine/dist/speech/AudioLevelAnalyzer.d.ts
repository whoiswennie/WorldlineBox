export interface AudioLevelAnalyzer {
    getLevel(): number;
    /** Optional instantaneous peak, normalized to 0..1. */
    getPeak?(): number;
    /** Optional availability signal for sources that can temporarily lose audio. */
    isAvailable?(): boolean;
    /** Alias accepted by lightweight adapters that expose availability directly. */
    available?(): boolean;
    /** Clear source-side smoothing/buffering when speech ends. */
    reset?(): void;
}
export declare class NullAudioLevelAnalyzer implements AudioLevelAnalyzer {
    getLevel(): number;
    getPeak(): number;
    isAvailable(): boolean;
    available(): boolean;
    reset(): void;
}
