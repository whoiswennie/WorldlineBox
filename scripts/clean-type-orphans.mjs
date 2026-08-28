import { readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoots = ['apps', 'packages', 'vendor'].map(name => join(root, name))
const outputSuffix = /(?:\.d\.ts\.map|\.d\.ts|\.js\.map|\.js)$/

async function exists(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function visit(directory, callback) {
  let entries
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch (error) {
    // Test fixtures create and remove hidden temporary directories while the
    // architecture gate is walking the workspace. A directory disappearing
    // between its parent's readdir and this recursive visit is benign.
    if (error?.code === 'ENOENT') return
    throw error
  }
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await visit(path, callback)
    else await callback(path)
  }
}

const typeRoots = []
for (const sourceRoot of sourceRoots) {
  await visit(sourceRoot, async (path) => {
    if (path.endsWith(join('lib', 'types', 'index.d.ts'))) {
      typeRoots.push(dirname(path))
    }
  })
}

let removed = 0

// A tsconfig without outDir can leave a complete TypeScript emit cluster in a
// source directory. This happened while migrating the workspace to lib/types:
// the next correctly configured build cannot remove those files because they
// are outside its output tree. A declaration map plus a same-stem TypeScript
// source is an unambiguous compiler artifact marker; remove only that cluster
// and leave ambient, CSS-module, and other hand-authored declarations intact.
for (const sourceRoot of sourceRoots) {
  const emittedStems = []
  await visit(sourceRoot, async (path) => {
    if (!path.endsWith('.d.ts.map')) return
    if (!path.split(sep).includes('src')) return
    const stem = basename(path, '.d.ts.map')
    const directory = dirname(path)
    const candidates = ['.ts', '.tsx', '.mts', '.cts'].map(extension =>
      join(directory, `${stem}${extension}`))
    if ((await Promise.all(candidates.map(exists))).some(Boolean)) {
      emittedStems.push(join(directory, stem))
    }
  })
  for (const stem of emittedStems) {
    for (const suffix of ['.js', '.js.map', '.d.ts', '.d.ts.map']) {
      const artifact = `${stem}${suffix}`
      if (!await exists(artifact)) continue
      await rm(artifact, { force: true })
      removed += 1
    }
  }
}

for (const typeRoot of new Set(typeRoots)) {
  const packageRoot = resolve(typeRoot, '..', '..')
  await visit(typeRoot, async (path) => {
    if (!outputSuffix.test(path)) return
    const stem = relative(typeRoot, path).replace(outputSuffix, '')
    const candidates = ['.ts', '.tsx', '.mts', '.cts'].map(extension =>
      join(packageRoot, 'src', `${stem}${extension}`))
    if ((await Promise.all(candidates.map(exists))).some(Boolean)) return
    await rm(path, { force: true })
    removed += 1
  })
}

console.log(`type output cleanup: removed ${removed} orphaned files`)
