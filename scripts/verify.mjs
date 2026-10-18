import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import path from 'node:path'

const root = path.resolve(import.meta.dirname, '..')
const reportDir = path.resolve(root, '../reports/dsh-sidebrowser-acceptance')
mkdirSync(reportDir, { recursive: true })
const steps = [
  ['build', ['scripts/build.mjs']],
  ['unit', ['--test', 'tests/browser.test.mjs', 'tests/visual-feedback.test.mjs', 'tests/debug.test.mjs', 'tests/diagnostics.test.mjs', 'tests/shared-core.test.mjs', 'tests/observation.test.mjs']],
  ['installed-contracts', ['scripts/check-installed-contracts.mjs']],
  ['electron', ['scripts/electron-smoke.mjs']],
]
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const report = { package: manifest.name, version: manifest.version, success: true, steps: [] }
for (const [name, args] of steps) {
  const result = spawnSync(process.execPath, args, { cwd: root, windowsHide: true, encoding: 'utf8', timeout: 60000 })
  writeFileSync(path.join(reportDir, `${name}.log`), (result.stdout || '') + (result.stderr || ''))
  const item = { name, exitCode: result.status, success: result.status === 0 && !result.error }
  if (result.error) item.error = result.error.message
  report.steps.push(item); console.log(JSON.stringify(item))
  if (!item.success) { report.success = false; break }
}
if (report.success) report.electronEvidence = JSON.parse(readFileSync(path.join(reportDir, 'electron-fixture', 'result.json'), 'utf8'))
writeFileSync(path.join(reportDir, 'verification.json'), JSON.stringify(report, null, 2) + '\n')
if (!report.success) process.exitCode = 1
