import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const bin = (name) => join(root, 'node_modules', '.bin', name)
const publishedPackages = [
  'protocol',
  'core',
  'client',
  'react',
  'electron',
  'registry',
]
const failures = []

const run = (label, command, args) => {
  console.log(`\n> ${label}`)
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' })
  if (result.status !== 0) failures.push(label)
  return result.status === 0
}

if (!run('pnpm build', 'pnpm', ['build'])) {
  console.error('\nbuild failed, aborting')
  process.exit(1)
}

for (const pkg of publishedPackages) {
  const dir = join('packages', pkg)
  run(`publint ${pkg}`, bin('publint'), [dir])
  run(`attw ${pkg}`, bin('attw'), ['--pack', dir, '--profile', 'esm-only'])
}

const forbidden = [
  { name: 'node builtin', pattern: /["']node:[a-z_/.-]+["']/ },
  { name: 'electron module', pattern: /["']electron["']/ },
]

const distFiles = (pkg) =>
  readdirSync(join(root, 'packages', pkg, 'dist'))
    .filter((file) => file.endsWith('.js'))
    .map((file) => join(root, 'packages', pkg, 'dist', file))

const browserSafeFiles = [
  ...['protocol', 'client', 'react'].flatMap(distFiles),
  join(root, 'packages', 'electron', 'dist', 'renderer.js'),
]

console.log('\n> browser-safe dist scan')
for (const file of browserSafeFiles) {
  const source = readFileSync(file, 'utf8')
  for (const { name, pattern } of forbidden) {
    const match = source.match(pattern)
    if (match) {
      console.error(`  ${relative(root, file)}: ${name} reference ${match[0]}`)
      failures.push(`scan ${relative(root, file)}`)
    }
  }
}
if (!failures.some((label) => label.startsWith('scan '))) {
  console.log(
    `  clean: ${browserSafeFiles.length} files, no node:/electron references`,
  )
}

if (failures.length !== 0) {
  console.error(
    `\ncheck:publish FAILED:\n${failures.map((label) => `  - ${label}`).join('\n')}`,
  )
  process.exit(1)
}
console.log('\ncheck:publish OK')
