import { readFileSync, writeFileSync } from 'node:fs'
const root = new URL('../', import.meta.url)
const template = readFileSync(new URL('src/client-template.js', root), 'utf8')
const core = readFileSync(new URL('src/page-core.js', root), 'utf8')
const helpers = readFileSync(new URL('src/page-extensions.js', root), 'utf8').replace(/^export /gm, '')
const driver = readFileSync(new URL('src/driver-extensions.js', root), 'utf8')
const visuals = readFileSync(new URL('src/visual-feedback.js', root), 'utf8')
const debug = ['src/diagnostics-dom.js', 'src/diagnostics-observe.js', 'src/diagnostics-data.js', 'src/debug-extensions.js', 'src/debug-page.js', 'src/debug-schema.js', 'src/debug-controller.js']
  .map(file => readFileSync(new URL(file, root), 'utf8').replace(/^export /gm, '')).join('\n')
if (!template.includes('/* PAGE_EXTENSIONS */')) throw new Error('Missing page helper build slot')
if (!template.includes('/* PAGE_CORE */')) throw new Error('Missing shared page core build slot')
writeFileSync(new URL('client.js', root), template.replace('/* PAGE_CORE */', core).replace('/* PAGE_EXTENSIONS */', helpers).replace('/* DRIVER_EXTENSIONS */', visuals + '\n' + debug + '\n' + driver))
