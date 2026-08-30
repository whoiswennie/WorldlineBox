import { createReadStream, createWriteStream } from 'node:fs'
import { access, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const root = resolve(import.meta.dirname, '..')
const args = new Map()
for (let index = 2; index < process.argv.length; index++) {
  const name = process.argv[index]
  if (!name.startsWith('--')) continue
  const value = process.argv[index + 1]
  if (value && !value.startsWith('--')) {
    args.set(name, value)
    index++
  } else {
    args.set(name, '')
  }
}

const preview = process.argv.includes('--preview')
const source = resolve(root, 'apps/installer/windows/WorldlineInstaller.cs')
const manifest = resolve(root, 'apps/installer/windows/app.manifest')
const logo = resolve(root, 'build/icon.png')
const icon = resolve(root, 'build/icon.ico')
const output = resolve(root, args.get('--output') || 'release/installer-preview/世界线盒子-UI预览.exe')
const input = args.has('--input') ? resolve(root, args.get('--input')) : null
const temporary = resolve(dirname(output), '.worldline-installer-build')
const stub = resolve(temporary, 'WorldlineBox.Stub.exe')
const archive = resolve(temporary, 'WorldlineBox.Payload.zip')
const compiledSource = resolve(temporary, 'WorldlineInstaller.cs')
const desktopPackage = JSON.parse(await readFile(resolve(root, 'apps/desktop/package.json'), 'utf8'))
const version = args.get('--version') || desktopPackage.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u.test(version)) {
  throw new Error(`Invalid installer version: ${JSON.stringify(version)}`)
}
const assemblyVersion = `${version.split('-', 1)[0]}.0`

await mkdir(temporary, { recursive: true })
await mkdir(dirname(output), { recursive: true })
const installerSource = await readFile(source, 'utf8')
if (!installerSource.includes('__WORLDLINE_VERSION__')) {
  throw new Error('Worldline installer source is missing the version placeholder')
}
await writeFile(
  compiledSource,
  installerSource
    .replaceAll('__WORLDLINE_ASSEMBLY_VERSION__', assemblyVersion)
    .replaceAll('__WORLDLINE_VERSION__', version),
  'utf8',
)

const framework = `${process.env.WINDIR || 'C:\\Windows'}\\Microsoft.NET\\Framework64\\v4.0.30319`
const compiler = resolve(framework, 'csc.exe')
const wpf = resolve(framework, 'WPF')
await access(compiler)

const compilerArgs = [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  `/out:${stub}`, `/win32icon:${icon}`, `/resource:${logo},WorldlineLogo.png`,
  `/reference:${resolve(wpf, 'PresentationCore.dll')}`,
  `/reference:${resolve(wpf, 'PresentationFramework.dll')}`,
  `/reference:${resolve(wpf, 'WindowsBase.dll')}`,
  `/reference:${resolve(framework, 'System.Xaml.dll')}`,
  `/reference:${resolve(framework, 'System.IO.Compression.dll')}`,
  `/reference:${resolve(framework, 'System.IO.Compression.FileSystem.dll')}`,
  `/reference:${resolve(framework, 'System.Windows.Forms.dll')}`,
  `/reference:${resolve(framework, 'Microsoft.CSharp.dll')}`,
]
if (!preview) compilerArgs.push(`/win32manifest:${manifest}`)
compilerArgs.push(compiledSource)
await run(compiler, compilerArgs)

if (preview) {
  await copyFile(stub, output)
  await rm(temporary, { recursive: true, force: true })
  console.log(`Custom installer UI preview: ${output}`)
  process.exit(0)
}

if (!input) throw new Error('--input is required for a release installer build')
await access(input)
await rm(archive, { force: true })
const localizedExecutable = resolve(input, '世界线.exe')
const payloadExecutable = resolve(input, 'WorldlineBox.exe')
let restoreLocalizedExecutable = false
try {
  await access(localizedExecutable)
  await rm(payloadExecutable, { force: true })
  await rename(localizedExecutable, payloadExecutable)
  restoreLocalizedExecutable = true
} catch {
  await access(payloadExecutable)
}

try {
  const nonAsciiPaths = await collectNonAsciiPaths(input)
  if (nonAsciiPaths.length > 0) {
    throw new Error(`Installer payload contains non-ASCII paths: ${nonAsciiPaths.join(', ')}`)
  }
  await run(resolve(process.env.WINDIR || 'C:\\Windows', 'System32/tar.exe'), [
    '-a', '-c', '--options', 'zip:compression=deflate,compression-level=1',
    '-f', archive, '-C', input, '.',
  ])
} finally {
  if (restoreLocalizedExecutable) await rename(payloadExecutable, localizedExecutable)
}

await pipeline(createReadStream(stub), createWriteStream(output))
const payloadOffset = (await stat(output)).size
await appendFile(output, archive)
const payloadLength = (await stat(archive)).size
const footer = Buffer.alloc(24)
footer.write('WLBOX001', 0, 'ascii')
footer.writeBigInt64LE(BigInt(payloadOffset), 8)
footer.writeBigInt64LE(BigInt(payloadLength), 16)
await appendBuffer(output, footer)
await rm(temporary, { recursive: true, force: true })
console.log(`Custom installer: ${output}`)

function run(command, commandArgs) {
  return new Promise((accept, reject) => {
    const child = spawn(command, commandArgs, { cwd: root, stdio: 'inherit', windowsHide: true })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? accept() : reject(new Error(`${basename(command)} exited with ${code}`)))
  })
}

async function appendFile(target, value) {
  await pipeline(createReadStream(value), createWriteStream(target, { flags: 'a' }))
}

async function appendBuffer(target, value) {
  await new Promise((accept, reject) => {
    const stream = createWriteStream(target, { flags: 'a' })
    stream.on('error', reject)
    stream.on('finish', accept)
    stream.end(value)
  })
}

async function collectNonAsciiPaths(directory, relativeDirectory = '') {
  const paths = []
  const entries = await readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name
    if (/[^\x00-\x7f]/u.test(relativePath)) paths.push(relativePath)
    if (entry.isDirectory()) {
      paths.push(...await collectNonAsciiPaths(resolve(directory, entry.name), relativePath))
    }
  }
  return paths
}
