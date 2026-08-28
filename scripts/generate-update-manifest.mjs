import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')

function argumentsOf(argv) {
  const values = new Map()
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index]
    const value = argv[index + 1]
    if (!name?.startsWith('--') || value === undefined || value.startsWith('--')) continue
    values.set(name, value)
    index++
  }
  return values
}

async function sha512Of(path) {
  const digest = createHash('sha512')
  for await (const chunk of createReadStream(path)) digest.update(chunk)
  return digest.digest('base64')
}

function yamlString(value) {
  return JSON.stringify(value)
}

/** Create the electron-updater-compatible repository manifest for one installer. */
export async function generateUpdateManifest(options) {
  const installerPath = resolve(options.installerPath)
  const outputPath = resolve(options.outputPath)
  const packageJson = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
  const version = options.version ?? packageJson.version
  if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error(`Invalid desktop version: ${JSON.stringify(version)}`)
  }
  const fileName = basename(installerPath)
  const expectedName = `WorldlineBox-Setup-${version}.exe`
  if (fileName !== expectedName) {
    throw new Error(`Installer name must be ${expectedName}, got ${fileName}`)
  }
  const [info, sha512] = await Promise.all([stat(installerPath), sha512Of(installerPath)])
  const releaseDate = (options.releaseDate ?? new Date()).toISOString()
  const releaseNotes = (options.releaseNotes
    ?? `WorldlineBox ${version} 稳定版本。\n包含 Agent、虚拟伙伴、内置浏览器、终端与工作区能力。`)
    .replaceAll('\r\n', '\n')
    .replaceAll('\r', '\n')
    .trim()
  const url = options.url
    ?? `https://github.com/whoiswennie/WorldlineBox/releases/download/v${version}/${fileName}`
  const notes = releaseNotes.split('\n').map(line => `  ${line}`).join('\n')
  const manifest = [
    `version: ${yamlString(version)}`,
    'files:',
    `  - url: ${yamlString(url)}`,
    `    sha512: ${yamlString(sha512)}`,
    `    size: ${String(info.size)}`,
    `path: ${yamlString(fileName)}`,
    `sha512: ${yamlString(sha512)}`,
    `releaseDate: ${yamlString(releaseDate)}`,
    'releaseNotes: |-',
    notes,
    '',
  ].join('\n')
  await writeFile(outputPath, manifest, 'utf8')
  return { outputPath, version, fileName, size: info.size, sha512, url, releaseDate, releaseNotes }
}

if (import.meta.main) {
  const args = argumentsOf(process.argv.slice(2))
  const installer = args.get('--installer')
  if (installer === undefined) throw new Error('--installer is required')
  const result = await generateUpdateManifest({
    installerPath: resolve(root, installer),
    outputPath: resolve(root, args.get('--output') ?? 'latest.yml'),
    ...(args.get('--version') === undefined ? {} : { version: args.get('--version') }),
    ...(process.env.WORLDLINE_RELEASE_NOTES === undefined
      ? {}
      : { releaseNotes: process.env.WORLDLINE_RELEASE_NOTES }),
  })
  console.log(`Update manifest: ${result.outputPath}`)
  console.log(`Release asset: ${result.url}`)
}
