# @acpjs/registry

ACP registry index fetch/cache, `AgentDefinition` resolution, and `ensureInstalled` install flow. Node-only, ESM-only, `node >= 24`.

Default data source: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json` (`/latest/` is the only published path).

## Install

```sh
pnpm add @acpjs/registry
```

## Usage

```ts
import { createRegistryClient } from '@acpjs/registry'
import { createAcpHost } from '@acpjs/core'

const registry = createRegistryClient()

const unsubscribe = registry.subscribe((event) => {
  if (event.type === 'install-progress' && 'downloadedBytes' in event.payload) {
    console.log(`downloading ${event.payload.downloadedBytes}/${event.payload.totalBytes ?? '?'}`)
  }
})

const definition = await registry.ensureInstalled('claude-acp')
unsubscribe()

const host = createAcpHost()
await host.spawnAgent(definition) // AgentDefinition is isomorphic to hand-written config
```

## Exports

- `createRegistryClient(options?): RegistryClient`
- `RegistryError` (carries a `code: RegistryErrorCode`)
- Constants: `DEFAULT_INDEX_URL`, `DEFAULT_INDEX_TTL_MS`
- Types: `RegistryClient`, `RegistryClientOptions`, `EnsureInstalledOptions`, `RegistryEvent`, `RegistryEventListener`, `FetchLike`, `PathProbe`, `RegistryIndex`, `RegistryEntry`, `RegistryDistribution`, `PackageDistribution`, `BinaryTarget`, `PlatformKey`, `AgentDefinition`, `InstallArtifact`, `RegistryError`, `RegistryErrorCode`.

### `RegistryClient`

- `getIndex(): Promise<RegistryIndex>` — cached `{ version?, entries }`.
- `getEntry(agentId): Promise<RegistryEntry | undefined>`
- `ensureInstalled(agentId, options?): Promise<AgentDefinition>` — four-tier resolution + install.
- `getInstallArtifact(agentId): Promise<InstallArtifact | undefined>`
- `subscribe(listener): () => void` — `install-progress` + `diagnostic` events (`@acpjs/protocol` host shapes, one monotonic `seq`).

### `RegistryClientOptions` (all injectable)

| Option | Default |
| --- | --- |
| `fetch` | `globalThis.fetch` |
| `cacheDir` | platform cache dir (`acpjs` namespace) |
| `indexUrl` | `DEFAULT_INDEX_URL` |
| `indexTtlMs` | `DEFAULT_INDEX_TTL_MS` (1 hour) |
| `now` | `Date.now` |
| `platform` / `arch` | `process.platform` / `process.arch` |
| `pathProbe` | PATH executable probe |

## `ensureInstalled` resolution order

1. **Explicit command** — `ensureInstalled(id, { command, args?, env? })` → `AgentDefinition` directly (no network/index/meta).
2. **Executable on PATH** — probe finds candidate; args/env from the matching distribution form.
3. **Package-manager run** — `npx`/`uvx` distribution → `command: 'npx'|'uvx'`, `args: [package, ...args]` (`npx` preferred when both exist; no injected flags).
4. **Binary download/install** — map platform/arch to one of six keys (`{darwin|linux|windows}-{aarch64|x86_64}`) → download → extract → `chmod 755` → write `artifact.json`. Target `cmd`/`args`/`env` flow into the `AgentDefinition`.

Install state machine: `resolving → (cache-hit → installed)` or `resolving → downloading → extracting → installed`; any failure → `failed` (payload carries `reason`); the install dir is removed so no half-written artifacts remain. Idempotent per `(agentId, version, platform)`.

## Index cache

- Cached at `<cacheDir>/registry-index.json`; served within TTL (1h default), shared across processes.
- Network failure with cache → stale cache + `diagnostic` (`warn`, `registry/index-stale-fallback`); no cache → `RegistryError('registry/index-unavailable')`.
- Index body must be an object with an `agents` array, else `registry/index-invalid`. Unparseable entries are skipped individually (`registry/entry-invalid`).

## Archive formats

- Extracted: `.tar.gz`, `.tgz` (gzip tar), `.zip` (pure-JS reader; store/deflate only).
- Raw binary (any other suffix, e.g. `.exe`) → written directly, no `extracting` stage.
- Rejected before download: `.dmg`, `.pkg`, `.deb`, `.rpm`, `.tar.bz2`, `.tbz2` → `registry/unsupported-archive`.
- Tar extraction via [node-tar](https://github.com/isaacs/node-tar) in-process (security defaults on: leading `/` stripped, `..` refused, no write through symlinks). Downloads capped at 1 GiB; each zip entry capped at 256 MiB inflated; zip-slip guarded.

## Diagnostics & error codes

| Channel | Code | Meaning |
| --- | --- | --- |
| diagnostic (`warn`) | `registry/index-stale-fallback` | network failure, stale cache served |
| diagnostic (`warn`) | `registry/entry-invalid` | skipped unparseable entry |
| `RegistryError` | `registry/index-unavailable` | network failure, no cache |
| `RegistryError` | `registry/index-invalid` | index not `{ agents: [] }` |
| `RegistryError` | `registry/agent-not-found` | no entry for `agentId` |
| `RegistryError` | `registry/no-distribution` | entry has no usable distribution |
| `RegistryError` | `registry/platform-unsupported` | no binary target / unmappable platform |
| `RegistryError` | `registry/unsupported-archive` | unsupported format |
| `RegistryError` | `registry/download-failed` | download threw / non-2xx |
| `RegistryError` | `registry/install-failed` | post-extraction error (e.g. `cmd` missing) |

## Known constraints

- **No checksum/signature verification** — the index carries no integrity values; integrity relies on TLS + the official CDN. The `verifying` stage is skipped.
- **PATH probe** candidates (in order): basename of the platform's binary `cmd`, then entry `id`; default walks `PATH` for execute permission (windows tries `.exe`/`.cmd`).
- **`meta` pass-through** — registry-sourced `AgentDefinition`s carry `meta: { name, version, registryId, icon? }`.
- Windows binaries are written + `chmod`'d like any platform; execution depends on the published `cmd`.
