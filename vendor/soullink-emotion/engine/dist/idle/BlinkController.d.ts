export interface BlinkState {
    eyeBlinkL: number;
    eyeBlinkR: number;
}
export declare class BlinkController {
    private random;
    private nextBlinkAt;
    private blinkStartedAt;
    private doubleBlinkQueued;
    private rate;
    constructor(seed?: number, rate?: number);
    defer(timeSeconds: number, duration: number): void;
    update(timeSeconds: number, focusLevel: number): BlinkState;
    private scheduleNext;
}
