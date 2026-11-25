import { afterEach, expect, it, vi } from 'vitest';
import { tmpdir } from 'node:os';

const { sources, display } = vi.hoisted(() => ({ sources: vi.fn(), display: vi.fn() }));
vi.mock('electron', () => ({
  app: { getPath: () => tmpdir() },
  desktopCapturer: { getSources: sources },
  screen: { getPrimaryDisplay: display },
}));

import { createBotDesktopCapture } from '../../src/main/companion-bot/desktop-capture';

afterEach(() => vi.clearAllMocks());

it('captures the primary display for a user turn with no chat renderer or call window', async () => {
  const bytes = Buffer.from('test image');
  display.mockReturnValue({ id: 4, size: { width: 1920, height: 1080 }, scaleFactor: 1 });
  sources.mockResolvedValue([{ display_id: '4', thumbnail: { isEmpty: () => false, toPNG: () => bytes } }]);
  const activity = vi.fn();
  const capture = createBotDesktopCapture(() => { throw Error('Unexpected audio request'); }, () => undefined, activity);
  try {
    const result = await capture.runForAgent(undefined, 'mobile-chat', false, { operation: 'screen' }, new AbortController().signal);
    expect(result).toEqual({ ok: true, image: bytes });
    expect(display).toHaveBeenCalledOnce();
    expect(activity.mock.calls.map(([state]) => state)).toEqual(['screenshot', 'captured']);
  } finally {
    capture.stopPresence();
  }
});

it('discards a pending screenshot if the originating turn is stopped', async () => {
  const controller = new AbortController();
  display.mockReturnValue({ id: 2, size: { width: 1920, height: 1080 }, scaleFactor: 1 });
  sources.mockImplementation(async () => {
    controller.abort();
    return [{ display_id: '2', thumbnail: { toPNG: () => { throw Error('Cancelled frame read'); } } }];
  });
  const capture = createBotDesktopCapture(() => { throw Error('Unexpected audio request'); }, () => undefined);
  try {
    await expect(capture.runForAgent(undefined, 'room', false, { operation: 'screen' }, controller.signal))
      .resolves.toEqual({ ok: true, cancelled: true });
  } finally {
    capture.stopPresence();
  }
});
