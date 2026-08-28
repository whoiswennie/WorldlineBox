import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { expect, it } from 'vitest'

const DIST_ROOT = fileURLToPath(new URL('../dist', import.meta.url))

it('ships install metadata with the built web application', async () => {
  const index = await readFile(join(DIST_ROOT, 'index.html'), 'utf8')
  expect(index).toContain('<link rel="manifest" href="/manifest.webmanifest" />')
  expect(index).toContain('<link rel="icon" type="image/png" href="/worldline-icon.png" />')

  const manifest: unknown = JSON.parse(await readFile(join(DIST_ROOT, 'manifest.webmanifest'), 'utf8'))
  expect(manifest).toEqual({
    id: '/',
    name: '世界线',
    short_name: '世界线',
    start_url: '/',
    scope: '/',
    display: 'fullscreen',
    icons: [{
      src: '/worldline-icon.png',
      sizes: '1024x1024',
      type: 'image/png',
      purpose: 'any maskable',
    }],
  })
})

it('ships the Huan icon emitted by the build', async () => {
  const icon = await readFile(join(DIST_ROOT, 'worldline-icon.png'))
  expect(icon.byteLength).toBeGreaterThan(100_000)
  expect(icon.subarray(1, 4).toString('ascii')).toBe('PNG')
})
