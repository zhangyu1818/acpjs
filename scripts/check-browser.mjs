import { join, resolve } from 'node:path'

import { build } from 'esbuild'

const root = resolve(import.meta.dirname, '..')

const entries = {
  '@acpjs/protocol': join(root, 'packages/protocol/src/index.ts'),
  '@acpjs/client': join(root, 'packages/client/src/index.ts'),
  '@acpjs/react': join(root, 'packages/react/src/index.ts'),
}

let failed = false

for (const [name, entry] of Object.entries(entries)) {
  try {
    await build({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      logLevel: 'silent',
      external: ['react'],
      alias: {
        '@acpjs/protocol': entries['@acpjs/protocol'],
        '@acpjs/client': entries['@acpjs/client'],
      },
    })
    console.log(`browser build ok: ${name}`)
  } catch (error) {
    failed = true
    console.error(`browser build FAILED: ${name}`)
    for (const message of error.errors ?? [{ text: String(error) }]) {
      console.error(`  - ${message.text}`)
    }
  }
}

if (failed) process.exit(1)
