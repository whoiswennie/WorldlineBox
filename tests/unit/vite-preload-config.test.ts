import ViteConfigGenerator from '@electron-forge/plugin-vite/dist/ViteConfig';
import { resolveConfig } from 'vite';
import { describe, expect, it } from 'vitest';

const entries = [
  { entry: 'src/preload/index.ts', config: 'vite.preload.config.ts', target: 'preload' },
  { entry: 'src/preload/offscreen.ts', config: 'vite.offscreen-preload.config.ts', target: 'preload' },
  { entry: 'src/preload/critical-confirmation.ts', config: 'vite.critical-confirmation-preload.config.ts', target: 'preload' },
] as const;

describe('Forge preload configuration with Vite 8', () => {
  for (const production of [false, true]) {
    it(`keeps single-file CJS preloads after Forge defaults merge (${production ? 'production' : 'development'})`, async () => {
      const generator = new ViteConfigGenerator({ build: [...entries], renderer: [] }, process.cwd(), production);
      const generated = await generator.getBuildConfigs();
      for (const [index, config] of generated.entries()) {
        const resolved = await resolveConfig({ ...config, configFile: false }, 'build');
        const output = resolved.build.rolldownOptions.output;
        expect(Array.isArray(output)).toBe(false);
        expect(output).toMatchObject({ codeSplitting: false, format: 'cjs', entryFileNames: '[name].js' });
        expect(output).not.toHaveProperty('inlineDynamicImports');
        expect(resolved.build.rolldownOptions.input).toBe(entries[index]!.entry);
      }
    });
  }
});
