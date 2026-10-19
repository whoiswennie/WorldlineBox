import type { CaptureAnswerUpdate } from '../../../shared/capture-answer';
import type { CaptureImageSource } from '../../../shared/capture-tools';
import type { Rect } from './model';

export type ScreenshotMessage = { role: 'user' | 'assistant'; content: string };
/** Reasoning is transient presentation state and is never sent as conversation history. */
export type ScreenshotConversationMessage = ScreenshotMessage & { reasoning?: string };
export type ScreenshotAIState = { configured: boolean; model: string; visionSupported: boolean | null; reason?: string };
export type ScreenshotAsk = { dataUrl: string; messages: ScreenshotMessage[]; signal: AbortSignal; onUpdate?(update: CaptureAnswerUpdate): void };
export type ScreenshotEditorProps = {
  source: CaptureImageSource;
  onClose(): void;
  onSave(dataUrl: string, filename: string): Promise<void>;
  onSaveFile?(dataUrl: string, filename: string): Promise<void>;
  onCopy(dataUrl: string): Promise<void>;
  ai: ScreenshotAIState;
  onAsk(request: ScreenshotAsk): Promise<string>;
  onOpenLink?(url: string): Promise<void> | void;
  initialTask?: 'screenshot' | 'ocr' | 'translate';
  onLongCapture?(rect: Rect): Promise<void>;
};
