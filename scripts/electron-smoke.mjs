// Launch an isolated, hidden Electron fixture using hard links to the installed
// runtime binaries. No installed app files, profile, cookies or pages are changed.
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'

const install = process.env.DSH_DESKTOP_DIR || path.join(process.env.LOCALAPPDATA, 'Programs', 'DeepSeek Harness')
const root = path.resolve(import.meta.dirname, '..')
const output = path.resolve(root, '../reports/dsh-sidebrowser-acceptance/electron-fixture')
fs.mkdirSync(path.join(output, 'resources', 'app'), { recursive: true })
for (const entry of fs.readdirSync(install, { withFileTypes: true })) {
  if (!entry.isFile() || (entry.name.endsWith('.exe') && entry.name !== 'DeepSeek Harness.exe')) continue
  const target = path.join(output, entry.name === 'DeepSeek Harness.exe' ? 'BrowserFixture.exe' : entry.name)
  // Desktop updates replace binaries. Refresh old fixture hard links so the
  // acceptance run uses the currently installed Electron, not a previous one.
  if (fs.existsSync(target) && fs.statSync(target).ino !== fs.statSync(path.join(install, entry.name)).ino) fs.unlinkSync(target)
  if (!fs.existsSync(target)) fs.linkSync(path.join(install, entry.name), target)
}
const locales = path.join(output, 'locales')
if (!fs.existsSync(locales)) fs.symlinkSync(path.join(install, 'locales'), locales, 'junction')
const app = path.join(output, 'resources', 'app')
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'dsh-sidebrowser-fixture', version: '0.0.0', main: 'main.cjs' }))
for (const name of ['main.cjs', 'renderer.cjs', 'debug.cjs', 'diagnostics.cjs', 'index.html']) fs.copyFileSync(path.join(root, 'tests', 'electron', name), path.join(app, name))
const env = { ...process.env, DSH_SIDEBROWSER_PLUGIN_ROOT: root, DSH_SIDEBROWSER_REPORT: path.join(output, 'result.json') }
delete env.ELECTRON_RUN_AS_NODE
const child = spawn(path.join(output, 'BrowserFixture.exe'), [], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
let stderr = ''
child.stdout.on('data', chunk => process.stdout.write(chunk))
child.stderr.on('data', chunk => { stderr += chunk.toString() })
const watchdog = setTimeout(() => { child.kill(); process.stderr.write('Electron fixture watchdog expired\n') }, 45000)
child.on('error', error => { clearTimeout(watchdog); throw error })
child.on('exit', code => {
  clearTimeout(watchdog)
  fs.writeFileSync(path.join(output, 'stderr.log'), stderr)
  if (fs.existsSync(env.DSH_SIDEBROWSER_REPORT)) process.stdout.write(fs.readFileSync(env.DSH_SIDEBROWSER_REPORT, 'utf8') + '\n')
  process.exitCode = code || 0
})
