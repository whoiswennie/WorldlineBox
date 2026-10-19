import { expect, type Page } from '@playwright/test';

/** Decode and play the saved file in the actual isolated capture window. */
export async function expectRecordingPlayback(page: Page) {
  const video = page.locator('.capture-result-stage > video');
  await expect(video).toBeVisible({ timeout: 20000 });
  await expect.poll(() => video.evaluate(element => {
    const video = element as HTMLVideoElement;
    return { ready: video.readyState >= 2, width: video.videoWidth > 0, duration: Number.isFinite(video.duration) && video.duration > 0, error: video.error?.message ?? '' };
  }), { timeout: 20000 }).toEqual({ ready: true, width: true, duration: true, error: '' });
  expect(await page.locator('.capture-source-preview, .capture-recording-options, .capture-source-heading').count()).toBe(0);
  const info = await video.evaluate(async element => {
    const video = element as HTMLVideoElement;
    await video.play();
    return { width: video.videoWidth, height: video.videoHeight, duration: video.duration, src: video.currentSrc, controls: video.controls };
  });
  expect(info.controls).toBe(true); expect(info.src).toMatch(/^worldlinebox-capture:\/\/recording\//u);
  await expect.poll(() => video.evaluate(element => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(.1);
  await video.evaluate(element => { (element as HTMLVideoElement).pause(); });
  const target = Math.min(info.duration * .65, info.duration - .1);
  await video.evaluate((element, target) => { (element as HTMLVideoElement).currentTime = target; }, target);
  await expect.poll(() => video.evaluate((element, target) => Math.abs((element as HTMLVideoElement).currentTime - target), target), { timeout: 10000 }).toBeLessThan(.1);
  await expect(page.locator('.capture-result-metadata')).toContainText(`${info.width} × ${info.height}`);
  await page.getByRole('button', { name: '按原始尺寸查看', exact: true }).click();
  await expect(page.locator('.capture-result-stage')).toHaveClass(/is-original-size/u);
  const displayed = await video.evaluate(element => ({ width: element.getBoundingClientRect().width * devicePixelRatio, height: element.getBoundingClientRect().height * devicePixelRatio }));
  expect(displayed.width).toBeCloseTo(info.width, 0); expect(displayed.height).toBeCloseTo(info.height, 0);
  await page.getByRole('button', { name: '适应窗口', exact: true }).click();
  // Actual fit rendering preserves the saved aspect and never stretches pixels.
  const fit = await video.evaluate(element => ({ style: getComputedStyle(element).objectFit, controls: (element as HTMLVideoElement).controls }));
  expect(fit).toEqual({ style: 'scale-down', controls: true });
  await video.evaluate(element => { void element.requestFullscreen().catch(error => Reflect.set(globalThis, '__recordingFullscreenFailure', String(error))); });
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? Reflect.get(globalThis, '__recordingFullscreenFailure')), { timeout: 10000 }).toBe('VIDEO');
  await page.evaluate(() => document.exitFullscreen());
  await expect.poll(() => page.evaluate(() => document.fullscreenElement === null)).toBe(true);
  return info;
}
