# @acpjs/registry

Registry index fetch/cache, `AgentDefinition` resolution, and the `ensureInstalled` install flow for acpjs. Node-only, ESM-only, requires `node >= 24`.

The default data source is the official ACP registry CDN: `https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json`. `/latest/` is the only published path — there is no versioned CDN fallback point.

## Installation

```sh
pnpm add @acpjs/registry
```

`@acpjs/protocol` is the only runtime dependency (it provides the host event shapes used by `subscribe`).

## Quick start

Resolve an agent, install it if necessary, and hand the resulting `AgentDefinition` to `@acpjs/core`:

```ts
import { createRegistryClient } from '@acpjs/registry'

const registry = createRegistryClient()

// Subscribe before resolving so you observe the full install lifecycle.
const unsubscribe = registry.subscribe((event) => {
  if (event.type === 'install-progress') {
    const { stage } = event.payload
    if (stage === 'downloading' && 'downloadedBytes' in event.payload) {
      const { downloadedBytes, totalBytes } = event.payload
      console.log(`downloading ${downloadedBytes}/${totalBytes ?? '?'} bytes`)
    } else {
      console.log(`stage: ${stage}`)
    }
  }
})

const definition = await registry.ensureInstalled('claude-acp')
unsubscribe()

// definition: { id, command, args, env?, cwd?, meta? }
// Structurally identical to a hand-written AgentDefinition; pass it straight
// to @acpjs/core, e.g. host.spawnAgent(definition).
```

## Public API

### `createRegistryClient(options?: RegistryClientOptions): RegistryClient`

Returns a client with the following methods:

- `getIndex(): Promise<RegistryIndex>` — fetch (or serve from cache) the index and return `{ version?, entries }`, where `entries` is the list of parsed `RegistryEntry` objects.
- `getEntry(agentId): Promise<RegistryEntry | undefined>` — find a single parsed entry by its registry `id`.
- `ensureInstalled(agentId, options?): Promise<AgentDefinition>` — four-tier resolution plus install when required (see below).
- `getInstallArtifact(agentId): Promise<InstallArtifact | undefined>` — read the recorded install artifact for the current platform/version: `{ agentId, version, platform, executablePath, installedAt }`. Returns `undefined` when no artifact exists.
- `subscribe(listener): () => void` — subscribe to `install-progress` and `diagnostic` events. These are the `@acpjs/protocol` host event shapes and share one monotonically increasing host `seq`. Returns an unsubscribe function.

### `RegistryClientOptions`

Every boundary is injectable, which makes the client fully testable with no real network access:

| Option       | Type                                                     | Default                                        |
| ------------ | -------------------------------------------------------- | ---------------------------------------------- |
| `fetch`      | `(url: string) => Promise<Response>`                     | `globalThis.fetch`                             |
| `cacheDir`   | `string`                                                 | platform cache dir (see below)                 |
| `indexUrl`   | `string`                                                 | `DEFAULT_INDEX_URL`                            |
| `indexTtlMs` | `number`                                                 | `DEFAULT_INDEX_TTL_MS` (3,600,000 ms / 1 hour) |
| `now`        | `() => number`                                           | `Date.now`                                     |
| `platform`   | `string`                                                 | `process.platform`                             |
| `arch`       | `string`                                                 | `process.arch`                                 |
| `pathProbe`  | `(candidates: string[]) => Promise<string \| undefined>` | PATH executable probe                          |

### Exported types

`RegistryClient`, `RegistryClientOptions`, `EnsureInstalledOptions`, `RegistryEvent`, `RegistryEventListener`, `FetchLike`, `PathProbe`, `RegistryIndex`, `RegistryEntry`, `RegistryDistribution`, `PackageDistribution`, `BinaryTarget`, `PlatformKey`, `AgentDefinition`, `InstallArtifact`, `RegistryError`, `RegistryErrorCode`. Plus the constants `DEFAULT_INDEX_URL` and `DEFAULT_INDEX_TTL_MS`.

A `RegistryEntry` has the shape `{ id, name, version, description, distribution, authors?, license?, icon?, repository?, website? }`. A `distribution` may carry any combination of three forms: `npx`, `uvx`, and `binary` (a partial map keyed by `PlatformKey`).

## Index fetch and cache

- The index is cached on disk at `<cacheDir>/registry-index.json`. Within the TTL (default 1 hour) it is not re-fetched, and the cache is shared across client instances and processes.
- On network failure (a thrown error or a non-2xx response): if a cache exists, the stale cache is served and a `diagnostic` is emitted (`warn`, code `registry/index-stale-fallback`); if no cache exists, a `RegistryError('registry/index-unavailable')` is thrown.
- Unparseable index entries are skipped one by one with a `diagnostic` (`warn`, code `registry/entry-invalid`, `data.id` set to the entry id when present). A single bad entry never fails the whole index. Unknown top-level fields outside the schema (both on the index and within entries) are tolerated and ignored.
- The index body must be an object containing an `agents` array, otherwise `RegistryError('registry/index-invalid')` is thrown.

## `ensureInstalled` four-tier resolution

`ensureInstalled` resolves an agent in strict priority order and returns an `AgentDefinition`:

1. **Explicit command** — `ensureInstalled(id, { command, args?, env? })` produces an `AgentDefinition` directly. No network, no index read, no `meta`.
2. **Executable already on PATH** — if the PATH probe finds a candidate, it is used directly. `args`/`env` come from the matching distribution form (see "PATH probe" below).
3. **Package-manager run** — an `npx`/`uvx` distribution produces `command: 'npx' | 'uvx'` with `args: [package, ...args]` and `env` passed through.
4. **Binary download/install** — map `process.platform`/`process.arch` to one of six platform keys, then download → extract into a versioned cache directory → `chmod 755` → write `artifact.json`. The target's own `cmd` (a post-extraction relative command, which may be a nested sub-path), `args`, and `env` flow into the `AgentDefinition`.

### Install state machine

`resolving → (cache-hit → installed)` or `resolving → downloading → extracting → installed`. Any failed step transitions to `failed` (the payload carries `reason`). Tiers 1–3 perform no install and emit only `resolving → installed`. On failure the entire install directory is removed so no half-written artifacts remain. A repeat call for the same `(agentId, version, platform)` hits the cache and skips the download (idempotent).

### Archive formats

- Extracted: `.tar.gz`, `.tgz`, `.tar.bz2`, `.tbz2`, `.zip`.
- Any other suffix (for example `.exe`) is treated as a raw binary and written straight to disk — there is no `extracting` stage for raw binaries.
- Installer formats `.dmg`, `.pkg`, `.deb`, `.rpm` are rejected with `RegistryError('registry/unsupported-archive')` before any download occurs.

## Diagnostics and error codes

| Channel             | Code                            | Meaning                                                                         |
| ------------------- | ------------------------------- | ------------------------------------------------------------------------------- |
| diagnostic (`warn`) | `registry/index-stale-fallback` | Network failure; falling back to the stale cached index                         |
| diagnostic (`warn`) | `registry/entry-invalid`        | Skipped an unparseable index entry                                              |
| `RegistryError`     | `registry/index-unavailable`    | Network failure and no cache available                                          |
| `RegistryError`     | `registry/index-invalid`        | Index body is not an object with an `agents` array                              |
| `RegistryError`     | `registry/agent-not-found`      | No entry with the given `agentId` in the index                                  |
| `RegistryError`     | `registry/no-distribution`      | Entry has no usable distribution form                                           |
| `RegistryError`     | `registry/platform-unsupported` | No binary target for the current platform, or the platform key cannot be mapped |
| `RegistryError`     | `registry/unsupported-archive`  | Installer format (`.dmg`/`.pkg`/`.deb`/`.rpm`)                                  |
| `RegistryError`     | `registry/download-failed`      | Download threw or returned a non-2xx status                                     |
| `RegistryError`     | `registry/install-failed`       | Post-extraction error, e.g. `cmd` not found in the archive                      |

Every `RegistryError` carries a `code` (`RegistryErrorCode`) you can branch on.

## Known constraints

- **No checksum or signature verification.** The current registry index carries no integrity values, so download integrity cannot be verified at the registry layer and relies entirely on TLS and the official CDN. The `verifying` stage of the install state machine is skipped and emits no event. If the index begins to publish integrity values this must be implemented.
- **Installer archive formats are not supported** (`.dmg`, `.pkg`, `.deb`, `.rpm`); they are rejected before download.
- **Windows binaries** are written and `chmod`'d like any other platform; execution semantics depend on the published `cmd`.
- **Node-only and ESM-only.** Requires `node >= 24`; uses `node:child_process` (`tar`), `node:fs`, `node:zlib`, and the global `fetch`.

## Implementation-defined decisions

The ACP spec leaves several points implementation-defined. This package resolves them as follows:

- **Index TTL** — defaults to 3,600,000 ms (1 hour); override via `indexTtlMs`.
- **Cache directory** — defaults to an `acpjs` namespace under the platform cache convention: darwin `~/Library/Caches/acpjs`, linux `$XDG_CACHE_HOME/acpjs` (falling back to `~/.cache/acpjs`), windows `%LOCALAPPDATA%\acpjs\Cache` (falling back to `~/AppData/Local/acpjs/Cache`). Override via `cacheDir`. Install artifacts are isolated per `agents/<agentId>/<version>/<platformKey>/`; archive contents extract into `contents/` and metadata is written to `artifact.json`.
- **Platform keys** — six keys: `{darwin|linux|windows}-{aarch64|x86_64}`. Mapping: `win32 → windows`, `arm64 → aarch64`, `x64 → x86_64`. Any other `platform`/`arch` is unmappable and yields `registry/platform-unsupported`.
- **PATH probe** — candidate names are the basename of the current platform's binary `cmd` and the entry `id` (deduplicated, in that order). The default probe walks each directory in `PATH` checking for execute permission (on windows it also tries `.exe`/`.cmd` suffixes). Override via `pathProbe`. On a hit, `args`/`env` come from the current platform's binary target, or — when there is no binary target — from the `npx`/`uvx` form.
- **Verifying (skipped)** — see "Known constraints"; no integrity values exist in the index, so the stage is skipped.
- **`npx`/`uvx` precedence** — when a distribution contains both, `npx` is preferred. No extra flags (such as `-y`) are injected; `args` is exactly `[package, ...dist.args]`.
- **Tar extraction** — performed via the system `tar -xf` (bundled with macOS, Linux, and Windows 10+; gz/bz2 compression is auto-detected). Zip uses a built-in pure-JS reader (store/deflate, compression methods 0 and 8 only). Both zip entry paths and `cmd` resolution are guarded against directory traversal escapes.
- **`meta` pass-through** — registry-sourced `AgentDefinition`s carry `meta: { name, version, registryId, icon? }`.
- **Download granularity** — the `downloading` stage streams `response.body` and emits `{ stage: 'downloading', downloadedBytes, totalBytes? }` after each chunk (`downloadedBytes` is monotonically increasing; `totalBytes` is taken from the response `content-length` and omitted when absent, while `downloadedBytes` is still reported per chunk). When `response.body` is not streamable, it falls back to a single non-chunked read (no `downloadedBytes`; only the stage marker is emitted). Empty chunks are skipped.
- **Subscriber isolation** — a listener that throws is caught and ignored; dispatch to the remaining subscribers continues.
