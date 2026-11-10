import type { CaptureToolTask } from './capture-tools';
export const CAPTURE_TOOL_MENU_TASKS: readonly CaptureToolTask[] = ['screenshot', 'recording', 'long-screenshot', 'ocr', 'translate', 'selection'];
export const CAPTURE_TOOL_MENU_LABELS = {
  'zh-CN': { screenshot: '截图', recording: '录屏', 'long-screenshot': '滚动长截图', ocr: '提取文字', translate: '屏幕翻译', selection: '划词助手', more: '全局工具' },
  en: { screenshot: 'Screenshot', recording: 'Record screen', 'long-screenshot': 'Scrolling screenshot', ocr: 'Extract text', translate: 'Translate screen', selection: 'Selection assistant', more: 'Global tools' },
} as const;
