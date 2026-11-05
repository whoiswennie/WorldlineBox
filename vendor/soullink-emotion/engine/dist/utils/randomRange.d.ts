import type { RandomSource } from "./seededRandom";
export type NumberRange = [number, number];
export declare function randomRange(range: NumberRange, random: RandomSource): number;
export declare function pickOne<T>(items: T[], random: RandomSource): T;
