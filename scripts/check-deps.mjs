import { readdirSync, readFileSync, statSync } from 'node:fs'
import { builtinModules } from 'node:module'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const packagesDir = join(root, 'packages')

const allowedAcpDeps = {
  '@acpjs/protocol': [],
  '@acpjs/core': ['@acpjs/protocol'],
  '@acpjs/client': ['@acpjs/protocol'],
  '@acpjs/react': ['@acpjs/client', '@acpjs/protocol'],
  '@acpjs/electron': ['@acpjs/core', '@acpjs/protocol'],
  '@acpjs/registry': ['@acpjs/protocol'],
  '@acpjs/fixture-agent': [],
}

const environmentNeutral = new Set([
  '@acpjs/protocol',
  '@acpjs/client',
  '@acpjs/react',
])

const testFilePattern =
  /(\.test\.tsx?$|test-support|test-harness|test-setup|e2e-harness)/

const nodeBuiltins = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
])

function listSourceFiles(dir) {
  const files = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      files.push(...listSourceFiles(full))
    } else if (/\.tsx?$/.test(entry)) {
      files.push(full)
    }
  }
  return files
}

function importSpecifiers(source) {
  const pattern =
    /(?:^|[^\w$])(?:import|export)\s*(?:[\w$*\s{},]*?\s*from\s*)?['"]([^'"]+)['"]|import\s*\(\s*['"]([^'"]+)['"]/gm
  const specifiers = []
  for (const match of source.matchAll(pattern)) {
    const specifier = match[1] ?? match[2]
    if (specifier) specifiers.push(specifier)
  }
  return specifiers
}

const errors = []
const manifests = new Map()

for (const dir of readdirSync(packagesDir)) {
  const manifestPath = join(packagesDir, dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  manifests.set(manifest.name, { dir: join(packagesDir, dir), manifest })
}

for (const name of Object.keys(allowedAcpDeps)) {
  if (!manifests.has(name)) errors.push(`missing workspace package: ${name}`)
}

for (const [name, { dir, manifest }] of manifests) {
  const allowed = allowedAcpDeps[name]
  if (!allowed) {
    errors.push(`${name}: unknown package, not in the dependency graph`)
    continue
  }
  const declared = {
    ...manifest.dependencies,
    ...manifest.peerDependencies,
  }
  for (const dep of Object.keys(declared)) {
    if (dep.startsWith('@acpjs/') && !allowed.includes(dep)) {
      errors.push(
        `${name}: dependency on ${dep} violates the allowed dependency direction (allowed: ${allowed.join(', ') || 'none'})`,
      )
    }
  }
  const sourceFiles = listSourceFiles(join(dir, 'src')).filter(
    (file) => !testFilePattern.test(file),
  )
  for (const file of sourceFiles) {
    const relative = file.slice(root.length + 1)
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (
        specifier.startsWith('@acpjs/') &&
        specifier !== name &&
        !allowed.some(
          (dep) => specifier === dep || specifier.startsWith(`${dep}/`),
        )
      ) {
        errors.push(`${relative}: imports forbidden package ${specifier}`)
      }
      if (environmentNeutral.has(name) && nodeBuiltins.has(specifier)) {
        errors.push(
          `${relative}: environment-neutral package imports Node builtin ${specifier}`,
        )
      }
    }
  }
}

if (errors.length !== 0) {
  console.error('dependency direction check failed:')
  for (const error of errors) console.error(`  - ${error}`)
  process.exit(1)
}

console.log(`dependency direction check passed (${manifests.size} packages)`)
