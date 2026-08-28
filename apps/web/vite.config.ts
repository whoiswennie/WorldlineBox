import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig, type Plugin } from 'vite'
import { clientBuildEnvironmentDefines } from '../../scripts/client-build-environment.ts'

const sourceIcon = fileURLToPath(new URL('../../build/icon.png', import.meta.url))
const src = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url))
const STANDALONE_ERROR = 'apps/web is not a standalone application: bare Vite cannot inject window.__WORLDLINE_BOOT__. '
  + 'From a repository checkout, run `pnpm worldline web`; an installed package uses `worldline web`. '
  + 'For client-plugin HMR, run `pnpm worldline web` together with `pnpm run dev:web`.'
const DEFAULT_CLIENT_TITLE = 'Worldline Local Build'

function worldlineBrandAssets(): Plugin {
  return {
    name: 'worldline-brand-assets',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'worldline-icon.png',
        source: readFileSync(sourceIcon),
      })
    },
  }
}

/** Escape build-time text before placing it in the HTML title element. */
function escapeHtmlText(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Project the public build title into the initial HTML document. */
function clientDocumentTitle(): Plugin {
  const title = escapeHtmlText(process.env.DSH_CLIENT_TITLE ?? DEFAULT_CLIENT_TITLE)
  return {
    name: 'worldline-client-document-title',
    transformIndexHtml(html) {
      return html.replace('<title>Worldline Local Build</title>', `<title>${title}</title>`)
    },
  }
}

/** Fail before a Vite dev or preview server can expose the boot-manifest-free shell. */
function rejectStandaloneServe(): Plugin {
  return {
    name: 'worldline-reject-standalone-web-serve',
    config(_config, env) {
      if (env.command === 'serve') throw new Error(STANDALONE_ERROR)
    },
  }
}

/** Heavy, React-free render dependencies that can be cached independently from the shell. */
const VENDOR_PACKAGES: ReadonlySet<string> = new Set([
  'katex',
  'shiki',
  'mdast-util-from-markdown',
  'mdast-util-gfm',
  'mdast-util-math',
  'micromark-core-commonmark',
  'micromark-extension-gfm',
  'micromark-extension-math',
  'micromark-factory-space',
  'micromark-util-character',
  'micromark-util-classify-character',
  'micromark-util-sanitize-uri',
  'micromark-util-symbol',
  'micromark-util-types',
])

/** Grammars required during initial boot; remaining Shiki grammars stay lazy. */
const BOOT_GRAMMAR_FILES: readonly string[] = [
  'dist/typescript.mjs',
  'dist/shellscript.mjs',
  'dist/json.mjs',
]

const FONT_EXTENSIONS: readonly string[] = ['.woff2', '.woff', '.ttf']

/** Resolve the npm package that owns a pnpm-resolved module id. */
function npmPackageOf(id: string): string | undefined {
  const parts = id.split('/node_modules/')
  if (parts.length === 1) return undefined
  const [first, second] = parts[parts.length - 1].split('/')
  if (first.startsWith('.')) return undefined
  if (first.startsWith('@')) return second === undefined ? undefined : `${first}/${second}`
  return first
}

export default defineConfig({
  plugins: [rejectStandaloneServe(), clientDocumentTitle(), react(), worldlineBrandAssets()],
  build: {
    target: 'es2022',
    sourcemap: true,
    rollupOptions: {
      output: {
        chunkFileNames(chunk): string {
          if (chunk.name === 'index' || chunk.name === 'vendor') return 'assets/[name]-[hash].js'
          const isLangChunk = chunk.moduleIds.some(id => id.includes('/node_modules/@shikijs/langs/'))
          return isLangChunk ? 'assets/langs/[name]-[hash].js' : 'assets/[name]-[hash].js'
        },
        assetFileNames(asset): string {
          const fileName = asset.names[0] ?? ''
          const isFont = FONT_EXTENSIONS.some(extension => fileName.endsWith(extension))
          return isFont ? 'assets/fonts/[name]-[hash][extname]' : 'assets/[name]-[hash][extname]'
        },
        manualChunks(id: string): string | undefined {
          const packageName = npmPackageOf(id)
          if (packageName === undefined) return undefined
          if (packageName === '@shikijs/langs') {
            return BOOT_GRAMMAR_FILES.some(file => id.endsWith(`/${file}`)) ? 'vendor' : undefined
          }
          return VENDOR_PACKAGES.has(packageName) ? 'vendor' : undefined
        },
      },
    },
  },
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: [
      { find: /^node:module$/, replacement: src('./src/node-module-stub.ts') },
    ],
  },
  define: {
    ...clientBuildEnvironmentDefines(process.env),
    'process.versions.node': '"0.0.0"',
    'process.execArgv': '[]',
    'process.env.CORDIS_SHARED': 'undefined',
  },
})
