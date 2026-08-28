import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
var HOOK_HEAVY_CHAT_MODULES = /\/src\/renderer\/components\/(?:ChatInterface|MessageBubble)\.tsx$/;
var HMR_DISABLED = process.env.WORLDLINE_FANTASY_DISABLE_HMR === '1';
// These modules own long-lived chat state and many hooks. They must never become React
// Refresh families: replacing such a family can preserve an obsolete Fiber whose broken
// hook queue only surfaces on a later IPC status update. Vite still compiles the excluded
// TSX with esbuild, and this plugin reloads the renderer when either source file changes.
var fullReloadHookHeavyChatModules = function () { return ({
    name: 'full-reload-hook-heavy-chat-modules',
    handleHotUpdate: function (context) {
        if (HMR_DISABLED)
            return [];
        var file = context.file.replace(/\\/g, '/');
        if (HOOK_HEAVY_CHAT_MODULES.test(file)) {
            context.server.ws.send({ type: 'full-reload', path: '*' });
            return [];
        }
    },
}); };
export default defineConfig({
    plugins: [
        react({ exclude: [HOOK_HEAVY_CHAT_MODULES] }),
        fullReloadHookHeavyChatModules(),
    ],
    base: './',
    root: '.',
    publicDir: 'build',
    build: {
        outDir: 'dist/renderer',
        emptyOutDir: true,
        // The stable launcher does not need source maps. Generating a map for the large
        // renderer bundle adds a second, memory-heavy write phase and can be terminated
        // silently by Windows while start-electron.bat is waiting for the synchronous child.
        sourcemap: false,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@main': path.resolve(__dirname, './src/main'),
            '@renderer': path.resolve(__dirname, './src/renderer'),
            '@preload': path.resolve(__dirname, './src/preload'),
            '@shared': path.resolve(__dirname, './src/shared'),
        },
    },
    server: {
        port: 5173,
        // start-electron.bat deliberately runs a stable debug renderer. Source edits are picked up
        // only after an explicit restart, so a long Agent task cannot be interrupted by HMR
        // or Vite full-page reloads while files are changing.
        hmr: HMR_DISABLED ? false : undefined,
    },
    esbuild: {
        // 忽略 TypeScript 类型错误
        logOverride: { 'this-is-undefined-in-esm': 'silent' }
    },
});
