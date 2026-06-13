import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { FixtureScenario } from './scenario.ts'

export type * from './scenario.ts'

export const fixtureAgentCliPath = fileURLToPath(
  new URL('./cli.ts', import.meta.url),
)

export async function writeScenarioFile(
  scenario: FixtureScenario,
  dir?: string,
): Promise<string> {
  const target = dir ?? (await mkdtemp(join(tmpdir(), 'acpjs-fixture-')))
  const file = join(target, 'scenario.json')
  await writeFile(file, JSON.stringify(scenario))
  return file
}
