import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import { createPluginCommandResolver } from '../plugin-command-resolver'

const repoRoot = path.resolve(__dirname, '../../../../../')
const mindPluginRoot = path.resolve(repoRoot, 'kb-labs-mind', 'packages', 'mind-cli')
const devlinkPluginRoot = path.resolve(repoRoot, 'kb-labs-devlink', 'packages', 'core')

function createTestLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  }
}

describe('PluginCommandResolver', () => {
  let mindResolver: Awaited<ReturnType<typeof createPluginCommandResolver>>
  let devlinkResolver: Awaited<ReturnType<typeof createPluginCommandResolver>>

  beforeAll(async () => {
    mindResolver = await createPluginCommandResolver({
      discovery: {
        strategies: ['dir'],
        roots: [mindPluginRoot],
      },
      logger: createTestLogger(),
    })

    devlinkResolver = await createPluginCommandResolver({
      discovery: {
        strategies: ['dir'],
        roots: [devlinkPluginRoot],
      },
      logger: createTestLogger(),
    })
  })

  afterAll(async () => {
    await Promise.all([
      mindResolver?.dispose(),
      devlinkResolver?.dispose(),
    ])
  })

  it('resolves mind CLI command handlers', async () => {
    const resolution = await mindResolver.resolve('plugin:@kb-labs/mind/cli/update')
    expect(resolution.manifest.id).toBe('@kb-labs/mind')
    expect(resolution.handler.file).toContain('cli/update')
    expect(resolution.permissions).toBeDefined()
    expect(resolution.pluginRoot).toBe(mindPluginRoot)
  })

  it('resolves devlink CLI command handlers with namespaced IDs', async () => {
    const resolution = await devlinkResolver.resolve('plugin:@kb-labs/devlink/cli/devlink:plan')
    expect(resolution.manifest.id).toBe('@kb-labs/devlink')
    expect(resolution.handler.file).toContain('cli/plan')
    expect(resolution.permissions).toBeDefined()
  })
})

