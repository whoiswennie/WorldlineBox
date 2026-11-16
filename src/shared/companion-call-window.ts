export const CALL_PET_WINDOW = 'worldlinebox-call-pet';
export const CALL_PET_COMMAND = 'companion-call:pet-command';
export const CALL_PET_CLOSED = 'companion-call:pet-closed';
export const CALL_PET_MAX_WIDTH = 470;
export const CALL_PET_MAX_HEIGHT = 630;
export function isCallPetWindowName(name: unknown): name is string {
  return typeof name === 'string' && name.startsWith(`${CALL_PET_WINDOW}:`)
    && /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(name.slice(CALL_PET_WINDOW.length + 1));
}
export interface CallPetRect { x: number; y: number; width: number; height: number }
export type CallPetCommand = 'return' | 'close' | 'drag-end'
  | { type: 'drag-start' | 'drag-move'; x: number; y: number }
  | { type: 'layout'; width: number; height: number; rects: CallPetRect[] };
export interface CallPetApi {
  supported: boolean;
  command(command: CallPetCommand): void;
  onClosed(listener: (name: string) => void): () => void;
}
