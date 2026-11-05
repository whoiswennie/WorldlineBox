import type { ParameterMapRule } from "./ModelProfile";
export type ResponseCurve = "linear" | "easeIn" | "easeOut" | "easeInOut" | "smoothstep";
/**
 * Map a FACS/custom-channel value through one profile rule.
 * Legacy rules intentionally keep the historical compose math byte-for-byte in shape.
 * v2 outputRange remaps the post-mode normalized value, then scale/offset still apply;
 * adapters remain responsible for final min/max clamping.
 */
export declare function transformRuleValue(value: number, rule: ParameterMapRule): number;
