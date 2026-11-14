import type { Page } from '@playwright/test';

/** Observe the values passed to the real Cubism mesh update. */
export async function observeCallRenderedPose(page: Page) {
  await page.evaluate(() => {
    type CoreModel = { parameters: { ids: string[]; values: Float32Array }; update(): void };
    const { Model } = Reflect.get(window, 'Live2DCubismCore') as { Model: { prototype: CoreModel } };
    const update = Model.prototype.update;
    Model.prototype.update = function () {
      const { ids, values } = this.parameters;
      Reflect.set(window, '__callRenderedPose', {
        tear: values[ids.indexOf('key2')],
        hand: values[ids.indexOf('Movement2')],
        smugEyes: values[ids.indexOf('key6')],
      });
      update.call(this);
    };
  });
  return () => page.evaluate(() => Reflect.get(window, '__callRenderedPose') as {
    tear: number; hand: number; smugEyes: number;
  } | undefined);
}
