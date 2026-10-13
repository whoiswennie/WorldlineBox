import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, createLogger, loadConfigFromFile } from 'vite';

const require = createRequire(import.meta.url);
const ViteConfigGenerator = require('@electron-forge/plugin-vite/dist/ViteConfig').default;
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const toolsRoot = path.join(projectRoot, '.tools');
await mkdir(toolsRoot, { recursive: true });
assert.equal(path.dirname(await realpath(toolsRoot)), await realpath(projectRoot), 'Smoke outputs must stay inside the project.');
const outputRoot = await mkdtemp(path.join(toolsRoot, 'vite-forge-smoke-'));
const report = [];

// Use Forge's actual merge path and declared targets, without starting Forge,
// Electron, a renderer server or a watcher. Development builds keep Forge's
// development mode/minification; only watch and output paths are overridden.
const loaded = await loadConfigFromFile({ command: 'build', mode: 'production' }, path.join(projectRoot, 'forge.config.ts'));
const forgePlugin = loaded?.config.plugins?.find((plugin) => plugin.name === 'vite');
assert.ok(forgePlugin?.config, 'Expected the configured Forge Vite plugin.');

for (const production of [false, true]) {
  const generator = new ViteConfigGenerator(forgePlugin.config, projectRoot, production);
  const mode = production ? 'production' : 'development';
  const configs = [
    ...(await generator.getBuildConfigs()).map((config, index) => ({ config, target: forgePlugin.config.build[index] })),
    ...(await generator.getRendererConfig()).map((config, index) => ({ config, target: forgePlugin.config.renderer[index] })),
  ];
  for (const { config, target } of configs) {
    const name = path.basename(target.config, '.config.ts');
    const warnings = [];
    const logger = createLogger('warn');
    const logWarn = logger.warn.bind(logger);
    const logWarnOnce = logger.warnOnce.bind(logger);
    logger.warn = (message, options) => { warnings.push(message); logWarn(message, options); };
    logger.warnOnce = (message, options) => { warnings.push(message); logWarnOnce(message, options); };
    const outDir = path.join(outputRoot, mode, name);
    console.log(`Forge ${mode}: ${name}`);
    const built = await build({
      ...config,
      configFile: false,
      customLogger: logger,
      build: { ...config.build, watch: null, emptyOutDir: false, outDir },
    });
    const outputs = Array.isArray(built) ? built : [built];
    assert.ok(outputs.every((output) => 'output' in output), 'The smoke build must not create a watcher.');
    const chunks = outputs.flatMap((output) => output.output).filter((output) => output.type === 'chunk');
    assert.equal(warnings.filter((warning) => /inlineDynamicImports/.test(warning)).length, 0, 'Legacy preload output options reached Rolldown.');
    if (target.target === 'preload' || /script-runtime|plugin-runtime|plugin-trusted-runtime/.test(name)) {
      assert.equal(chunks.length, 1, `${name} must remain a single CJS entry.`);
      assert.equal(chunks[0].isEntry, true);
      assert.ok(chunks[0].fileName.endsWith('.js'));
      assert.equal(chunks[0].imports.filter((entry) => entry.startsWith('./')).length, 0, 'The entry must not require sibling chunks.');
    }
    report.push({ mode, target: name, entries: chunks.filter((chunk) => chunk.isEntry).map((chunk) => chunk.fileName), chunks: chunks.length, warnings });
  }
}

await writeFile(path.join(outputRoot, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`Passed ${report.length} isolated Forge builds; report: ${path.join(outputRoot, 'report.json')}`);
