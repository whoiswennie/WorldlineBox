import type { ForgeConfig } from '@electron-forge/shared-types';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import process from 'node:process';
import { MakerDMG } from '@electron-forge/maker-dmg';
import { MakerZIP } from '@electron-forge/maker-zip';
import { AutoUnpackNativesPlugin } from '@electron-forge/plugin-auto-unpack-natives';
import { VitePlugin } from '@electron-forge/plugin-vite';

const projectRoot = import.meta.dirname;
const appIconBase = path.join(projectRoot, 'assets', 'icons', 'app');
const packagedResourcesRoot = process.platform === 'win32'
  ? path.join(projectRoot, '.tools', 'portable-release', randomUUID(), 'resources')
  : path.join(projectRoot, 'resources');

// WorldlineBox Windows: keep MSBuild builds hermetic from user-wide vcpkg integration
process.env.VcpkgEnabled = 'false';

function nativeMediaPlatform(platform: string, arch: string): string {
  const expectedHost = `${process.platform}-${process.arch}`;
  const target = `${platform}-${arch}`;
  if (target !== expectedHost || !['darwin-arm64', 'win32-x64', 'linux-x64', 'linux-arm64'].includes(target)) {
    throw new Error(
      `WorldlineBox release packages must be built and media-verified natively; host=${expectedHost}, target=${target}.`,
    );
  }
  return target;
}

function runNodeGate(script: string, args: string[], extraEnv?: NodeJS.ProcessEnv): void {
  const result = spawnSync(process.execPath, [path.join(projectRoot, script), ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...extraEnv },
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${script} release gate exited with ${String(result.status)}.`);
  }
}

const config: ForgeConfig = {
  hooks: {
    // These hooks are part of Forge itself, so invoking `electron-forge`
    // directly cannot bypass either the promoted-source gate or verification
    // of the bytes that Packager actually copied.
    prePackage: async (_forgeConfig, platform, arch) => {
      // WorldlineBox Windows 特别警告（2026-08-21 事故）：forge 会在打包时对
      // native 依赖执行 @electron/rebuild，子进程（cp.fork）继承本进程
      // 环境变量。本机若装有 vcpkg 用户级 MSBuild 集成，链接器会把
      // better-sqlite3 自带静态 sqlite3 错解析为 vcpkg 的动态 sqlite3.dll，
      // 打包产物 .node 依赖缺失 DLL 导致所有资源库打不开。必须在 forge
      // rebuild 之前强制 VcpkgEnabled=false（与 scripts/rebuild-native.mjs
      // 一致）。
      process.env.VcpkgEnabled = 'false';
      const mediaPlatform = nativeMediaPlatform(platform, arch);
      runNodeGate('scripts/generate-automation-declarations.mjs', []);
        runNodeGate('scripts/vendor-vcp-memory.mjs', ['--restore-missing']);
        runNodeGate('scripts/vendor-vcp-memory.mjs', ['--verify']);
      runNodeGate('scripts/stage-vcp-memory-runtime.mjs', []);
      runNodeGate('scripts/stage-bundled-embedding.mjs', ['--acquire']);
      // Recover ignored media executables from the pinned WorldlineBox-Build
      // release when a clean checkout or a local replacement fails the gate.
      runNodeGate('scripts/media-binaries.mjs', ['ensure', '--platform', mediaPlatform]);
      if (mediaPlatform === 'win32-x64') runNodeGate('scripts/portable-tools.mjs', ['release', '--release-root', packagedResourcesRoot]);
      // The browser extension is not shipped to a store yet; it ships inside
      // the app bundle (Contents/Resources/extension) for manual loading.
      // Rebuild it so the package always carries the current sources.
      runNodeGate('scripts/build-extension.mjs', []);
    },
    postPackage: async (_forgeConfig, packageResult) => {
      nativeMediaPlatform(packageResult.platform, packageResult.arch);
      for (const outputPath of packageResult.outputPaths) {
        runNodeGate('scripts/verify-package.mjs', [], {
          WORLDLINEBOX_PACKAGE_ROOT: outputPath,
          WORLDLINEBOX_PACKAGE_PLATFORM: `${packageResult.platform}-${packageResult.arch}`,
        });
      }
      // Packager has finished copying all extra resources. Reclaim only this
      // build's export after every output passes; failed builds retain evidence.
      if (packageResult.platform === 'win32') runNodeGate('scripts/portable-release-cleanup.mjs', [packagedResourcesRoot]);
    },
    // Forge supports `make --skip-package`; verify the exact default package
    // input again so that shortcut cannot feed stale or modified bytes to a
    // maker without passing the package gate.
    preMake: async () => {
      const mediaPlatform = nativeMediaPlatform(process.platform, process.arch);
      runNodeGate('scripts/media-binaries.mjs', ['ensure', '--platform', mediaPlatform]);
      if (mediaPlatform === 'win32-x64') runNodeGate('scripts/portable-tools.mjs', ['release', '--release-root', packagedResourcesRoot]);
      runNodeGate('scripts/verify-package.mjs', [], {
        WORLDLINEBOX_PACKAGE_ROOT: path.join(projectRoot, 'out', `WorldlineBox-${mediaPlatform}`),
        WORLDLINEBOX_PACKAGE_PLATFORM: mediaPlatform,
      });
      // Makers consume the verified out/ package, not the temporary tool export.
      if (mediaPlatform === 'win32-x64') runNodeGate('scripts/portable-release-cleanup.mjs', [packagedResourcesRoot]);
    },
  },
  packagerConfig: {
    // The Windows launcher verifies and reuses its portable Electron ZIP.
    electronZipDir: process.env.WORLDLINEBOX_ELECTRON_ZIP_DIR,
    icon: appIconBase,
    asar: {
      unpack:
        '**/node_modules/7zip-bin/**,' +
        // ConPTY loads DLL/executable helpers and worker JavaScript beside its NAPI binding.
        '**/node_modules/node-pty/**,' +
        // 2026-09-15：链接删除改为永久删除源文件后，产品不再调用系统回收站，
        // `trash` 依赖与其本地 helper 已移除，这里不再需要解包它。
        '**/node_modules/libarchive-wasm/dist/libarchive.wasm,' +
        // sqlite-vec loads its pinned platform extension through SQLite's
        // loadExtension API; dynamic libraries cannot be loaded from app.asar.
        '**/node_modules/sqlite-vec-*/vec0.*,' +
        // Sharp 0.35 ships prebuilt natives under @img/* (e.g.
        // @img/sharp-darwin-arm64/lib/*.node); native modules cannot load
        // from inside app.asar, so they must stay unpacked.
        '**/node_modules/@img/**',
    },
    // WorldlineBox 初版不购买签名证书。Apple Silicon 上只有链接器签名、没有
    // _CodeSignature 时，隔离后的应用会被 Gatekeeper 说成「已损坏」。
    // identity '-' 是临时签名，不是钥匙串里的证书名；默认会去钥匙串查找并失败，
    // 而 packager 又默认 continueOnError，于是打包成功但包仍然没签上。
    // 拿到 Developer ID 后换成证书名并补 osxNotarize。临时签名不消除
    // 「无法验证开发者」，只让右键打开可用。
    osxSign: Object.assign(
      {
        identity: '-',
        identityValidation: false,
        // 临时签名没有共同的 Team ID。加固运行时下，主程序会因「Team ID 不同」
        // 拒绝加载 Electron Framework，系统就提示「因为出现问题而无法打开」。
        // 这份授权允许加载同包里的框架和原生模块。Developer ID 签上同一证书后可以收紧。
        optionsForFile: () => ({
          entitlements: path.join(projectRoot, 'assets/mac/entitlements.plist'),
        }),
        // ffmpeg / ffprobe / oiiotool and sqlite-vec's dylib bytes are locked
        // by integrity manifests. Re-signing rewrites Mach-O bytes. Keep their
        // valid linker ad-hoc signatures; the outer app seal still covers them.
        ignore: (file: string) =>
          /[/\\]resources[/\\](?:ffmpeg|oiio)[/\\]/.test(file) ||
          /[/\\]app\.asar\.unpacked[/\\]node_modules[/\\]sqlite-vec-darwin-arm64[/\\]vec0\.dylib$/i.test(file),
      },
      { continueOnError: false },
    ),
    // Media executables must remain outside app.asar so the Library Worker can
    // spawn them. `npm run media:verify` is the release gate that validates the
    // platform bundle before packaging; `verify:package` repeats the same
    // checks against this copied directory.
    extraResource: [
      path.join(projectRoot, 'resources', 'dsh-bridge'),
      path.join(projectRoot, '.tools', 'vcp-memory-release', 'vcp-memory'),
      path.join(projectRoot, '.tools', 'vcp-memory-release', 'vcp-memory-host'),
      path.join(projectRoot, 'resources', 'embedding-models'),
      packagedResourcesRoot,
      // Browser extension bundle (manual-load distribution): installed at
      // WorldlineBox.app/Contents/Resources/extension (macOS) or
      // resources/extension (Windows) so users can load it unpacked.
      'dist/extension',
      'assets/icons/app-dock.png',
      'assets/icons/app.png',
      'assets/icons/app.ico',
      'assets/icons/app.icns',
      // Third-party attribution ships inside the package next to the LICENSE.
      'THIRD_PARTY_NOTICES.md',
      'assets/backgrounds/attribution',
      'LICENSE',
    ],
    // Forge's Vite plugin otherwise excludes all node_modules. Keep them in the
    // copy set so Packager can prune to production dependencies and the native
    // module plugin can unpack better-sqlite3.
    ignore: (file) => {
      if (!file) return false;
      const normalized = file.replaceAll('\\', '/');
      // These complete dependency trees ship once through extraResource. Keeping
      // them in ASAR as well doubles the payload and sends nested copies to prune.
      if (/^\/\.vite\/vcp-memory(?:-host)?(?:\/|$)/u.test(normalized)) return true;
      return !normalized.startsWith('/.vite') && !normalized.startsWith('/node_modules');
    },
  },
  rebuildConfig: {
    onlyModules: process.env.WORLDLINEBOX_SKIP_NATIVE_REBUILD === '1' ? [] : ['better-sqlite3'],
    ignoreModules: ['node-pty'],
  },
  makers: [
    // Windows 安装器不在此处（2026-08-08 决策：WiX MSI 已回退——MSI 语言
    // 切换需自定义 bootstrapper（社区确认），Inno/NSIS 内置多语言选择
    // （VS Code 用 Inno））。Inno Setup 以独立脚本产出（scripts/inno-build.mjs
    // + assets/inno/worldlineboxsetup.iss），release pipeline 的 make 阶段会串联。
    new MakerZIP({}, ['darwin', 'win32']),
    new MakerDMG({}),
  ],
  plugins: [
    new AutoUnpackNativesPlugin({}),
    new VitePlugin({
      build: [
        {
          entry: 'src/main/index.ts',
          config: 'vite.main.config.ts',
          target: 'main',
        },
        {
          entry: 'src/preload/index.ts',
          config: 'vite.preload.config.ts',
          target: 'preload',
        },
        {
          // Slice E (WorldlineBox-hnmg): dedicated bridge for the hidden offscreen
          // thumbnail window; emitted as `.vite/build/offscreen.js`.
          entry: 'src/preload/offscreen.ts',
          config: 'vite.offscreen-preload.config.ts',
          target: 'preload',
        },
        {
          // Critical confirmation child windows have a deliberately narrow
          // bridge; they must not inherit the full application preload.
          entry: 'src/preload/critical-confirmation.ts',
          config: 'vite.critical-confirmation-preload.config.ts',
          target: 'preload',
        },
        {
          // The native browser reuses the extension content script through an
          // isolated, sandboxed preload, separate from the application bridge.
          entry: 'src/preload/browser-capture.ts',
          config: 'vite.browser-capture-preload.config.ts',
          target: 'preload',
        },
        {
          entry: 'src/worker/index.ts',
          config: 'vite.worker.config.ts',
          target: 'main',
        },
        {
          entry: 'src/companions/worker.ts',
          config: 'vite.companion-worker.config.ts',
          target: 'main',
        },
        {
          entry: 'src/scripting/script-runtime-utility-entry.ts',
          config: 'vite.script-runtime.config.ts',
          target: 'main',
        },
        {
          entry: 'src/scripting/plugin-standard-host-entry.ts',
          config: 'vite.plugin-runtime.config.ts',
          target: 'main',
        },
        {
          entry: 'src/scripting/plugin-trusted-host-entry.ts',
          config: 'vite.plugin-trusted-runtime.config.ts',
          target: 'main',
        },
      ],
      renderer: [
        {
          name: 'main_window',
          config: 'vite.renderer.config.ts',
        },
      ],
    }),
  ],
};

export default config;
