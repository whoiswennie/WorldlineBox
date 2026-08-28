const fs = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const compatibility = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'identity-compatibility.json'), 'utf8'))
const roots = ['apps', 'packages', 'vendor', 'src', 'tests']
const extensions = new Set(['.cjs', '.js', '.json', '.mjs', '.ts', '.tsx', '.yaml', '.yml'])
const forbidden = [
  { label: 'reference project name', pattern: new RegExp('deep' + 'seek-harness', 'i') },
  { label: 'deprecated package scope', pattern: new RegExp('@world' + 'line/') },
]

const findings = []
const usedExceptions = new Set()

function scan(directory) {
  if (!fs.existsSync(directory)) return
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'lib' || entry.name === 'dist') continue
      scan(absolute)
      continue
    }
    if (!extensions.has(path.extname(entry.name))) continue
    const text = fs.readFileSync(absolute, 'utf8')
    const relativePath = path.relative(root, absolute).replaceAll('\\', '/')
    for (const rule of forbidden) {
      if (rule.pattern.test(text)) {
        if (compatibility.exceptions?.[relativePath]?.[rule.label] !== undefined) {
          usedExceptions.add(`${relativePath}\0${rule.label}`)
        } else {
          findings.push(`${relativePath}: ${rule.label}`)
        }
      }
    }
  }
}

for (const directory of roots) scan(path.join(root, directory))

for (const [relativePath, rules] of Object.entries(compatibility.exceptions ?? {})) {
  for (const label of Object.keys(rules)) {
    if (!usedExceptions.has(`${relativePath}\0${label}`)) {
      findings.push(`${relativePath}: stale compatibility exception for ${label}`)
    }
  }
}

if (findings.length) {
  console.error('Runtime identity verification failed:')
  for (const finding of findings) console.error(`- ${finding}`)
  process.exit(1)
}

console.log('Runtime identity verification passed.')
