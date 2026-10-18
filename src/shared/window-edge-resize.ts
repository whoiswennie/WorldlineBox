import { z } from "zod";

/**
 * Frameless Linux shell: client-side edge/corner resize hit targets.
 * Main prefers `_NET_WM_MOVERESIZE`; setBounds is the JS fallback.
 */

export const WINDOW_RESIZE_EDGES = [
  "n",
  "s",
  "e",
  "w",
  "ne",
  "nw",
  "se",
  "sw",
] as const;

export type WindowResizeEdge = (typeof WINDOW_RESIZE_EDGES)[number];

const windowResizeEdgeSchema = z.enum(WINDOW_RESIZE_EDGES);

export const windowEdgeResizeRequestSchema = z.object({
  edge: windowResizeEdgeSchema,
});

export type WindowEdgeResizeRequest = z.infer<typeof windowEdgeResizeRequestSchema>;

export type WindowEdgeResizeResult =
  | { ok: true; mode: "native" | "fallback" }
  | { ok: false; code: "unsupported_platform" | "no_window" | "maximized" | "malformed_request" };

export const windowBoundsSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  width: z.number().positive().finite(),
  height: z.number().positive().finite(),
});

export const windowSetBoundsRequestSchema = z.object({
  edge: windowResizeEdgeSchema,
  startBounds: windowBoundsSchema,
  dx: z.number().finite(),
  dy: z.number().finite(),
});

export type WindowSetBoundsRequest = z.infer<typeof windowSetBoundsRequestSchema>;

export type WindowSetBoundsResult =
  | { ok: true }
  | { ok: false; code: "unsupported_platform" | "no_window" | "maximized" | "malformed_request" };

export const windowGetBoundsResultSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    bounds: windowBoundsSchema,
  }),
  z.object({
    ok: z.literal(false),
    code: z.enum(["unsupported_platform", "no_window"]),
  }),
]);

export type WindowGetBoundsResult = z.infer<typeof windowGetBoundsResultSchema>;

export function parseWindowResizeEdge(input: unknown): WindowResizeEdge | null {
  const parsed = windowResizeEdgeSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseWindowEdgeResizeRequest(
  input: unknown,
): WindowEdgeResizeRequest | null {
  const parsed = windowEdgeResizeRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

export function parseWindowSetBoundsRequest(
  input: unknown,
): WindowSetBoundsRequest | null {
  const parsed = windowSetBoundsRequestSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}
