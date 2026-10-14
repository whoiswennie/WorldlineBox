import artData from './companion-world-art-data.json';
import { COMPANION_WORLD_ART_ACTIONS, type CompanionWorldArtAction } from './companion-world-actions';

export const WORLD_ART_ACTIONS = COMPANION_WORLD_ART_ACTIONS;
export type WorldArtAction = CompanionWorldArtAction;
export interface WorldArtPoint { x: number; y: number }
export interface WorldArtFrame {
  bounds: WorldArtPoint & { width: number; height: number };
  contacts: { posture: 'standing' | 'sitting' | 'lying' | 'transition'; origin: WorldArtPoint;
    foot: WorldArtPoint | null; seat: WorldArtPoint | null; pelvis: WorldArtPoint | null;
    back: WorldArtPoint | null; bed: WorldArtPoint | null; headwear?: WorldArtPoint | null };
}
export interface WorldArtSheet {
  url: string; frameCount: 3; frameWidth: number; frameHeight: number;
  durationMs: number; playback: 'loop' | 'transition'; sha256: string;
  defaultOrigin?: WorldArtPoint; neutralHeightPixels?: number;
  frames: [WorldArtFrame, WorldArtFrame, WorldArtFrame];
}
export interface WorldCharacterArt {
  id: string; cell: { width: number; height: number }; heightTiles: number;
  neutralHeightPixels: number; defaultOrigin: WorldArtPoint;
  actions: Partial<Record<WorldArtAction, WorldArtSheet>>;
}
const characters = artData as unknown as Record<string, WorldCharacterArt>;

/** A replacement retains its action's file and metadata; no mixed-action atlas is loaded. */
export function worldCharacterArt(avatar: string): WorldCharacterArt | undefined {
  return characters[avatar];
}
export const WORLD_ART_CHARACTER_IDS = Object.keys(characters);
