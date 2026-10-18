import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const install = process.env.DSH_DESKTOP_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
if (!process.versions.electron) {
  const result = spawnSync(path.join(install, 'DeepSeek Harness.exe'), [import.meta.filename], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, encoding: 'utf8', timeout: 60000,
  })
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || '')
  if (result.error) throw result.error
  process.exit(result.status ?? 1)
}
const pkg = name => pathToFileURL(path.join(install, 'resources', 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', name, 'lib', 'index.js')).href
const { assertSupportedJsonSchema, validateJsonSchemaValue } = await import(pkg('dsh-tools'))
const { snapshotJsonValue } = await import(pkg('dsh-util-values'))
const sessionClient = readFileSync(path.join(install, 'resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-api-session-controller/lib/client.js'), 'utf8')
assert.ok(sessionClient.includes('api-session/status'), 'Installed DSH must expose the Agent running-status channel')
const { hostHarness, clientHarness } = await import('../tests/harness.mjs')
const client = clientHarness('<h1>Contracts</h1><input id="name"><button id="save">Save</button><table><tr><td>A</td></tr></table>')
const host = hostHarness({ observeAfterAction: true }, async (_platform, _provider, method, input) => client.provider.query(method, input, { sessionId: 'A' }))
try {
  for (const tool of host.tools.values()) {
    assertSupportedJsonSchema(tool.parameters)
    assertSupportedJsonSchema(tool.output.schema)
  }
  for (const method of client.provider.manifest.methods) {
    assertSupportedJsonSchema(method.inputSchema); assertSupportedJsonSchema(method.outputSchema)
  }
  const samples = [
    ['browser_tabs', {}], ['browser_read', {}], ['browser_read', { mode: 'elements' }],
    ['browser_snapshot', {}], ['browser_extract', { kind: 'tables' }],
    ['browser_act', { action: 'type', selector: '#name', text: '', inputMode: 'dom' }],
    ['browser_eval', { code: 'Promise.resolve({answer:42})' }],
    ['browser_dev_debug', { action: 'start' }], ['browser_dev_console', {}], ['browser_dev_network', {}],
    ['browser_dev_debug', { action: 'stop' }],
    ['browser_dev_inspect', { selector: '#name' }], ['browser_dev_styles', { selector: '#name' }],
    ['browser_dev_performance', {}], ['browser_dev_performance', { action: 'stop' }],
    ['browser_dev_storage', {}], ['browser_dev_watch', { action: 'list' }], ['browser_dev_sources', {}],
  ]
  for (const [name, input] of samples) {
    const tool = host.tools.get(name)
    assert.deepEqual(validateJsonSchemaValue(tool.parameters, input), [], `${name} input`)
    const result = await tool.execute(input, { agent: {}, signal: new AbortController().signal })
    const detached = snapshotJsonValue(result)
    assert.deepEqual(validateJsonSchemaValue(tool.output.schema, detached), [], `${name} result`)
  }
  console.log(JSON.stringify({ success: true, toolSchemas: host.tools.size, clientMethods: client.provider.manifest.methods.length, resultSamples: samples.length, agentStatusChannel: true, electron: process.versions.electron }))
} finally { host.dispose(); await client.close() }
